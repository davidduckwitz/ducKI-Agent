import { describe, expect, it, vi } from "vitest";
import type { AgentRunOptions, AgentRunResult } from "../src/config/interfaces_types.js";
import { AgentRunnerV2 } from "../src/agent-runner-v2.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function result(response = "done"): AgentRunResult {
  return {
    response,
    iterations: 1,
    toolsUsed: [],
  };
}

function makeRunner() {
  const provider = {
    model: "test-model",
    supportsStreaming: () => true,
  } as any;
  return new AgentRunnerV2(provider, {} as any, { maxIterations: 7 });
}

describe("AgentRunnerV2 live streaming", () => {
  it("yields event/chunk frames before Agent.run resolves and preserves callback order", async () => {
    const runner = makeRunner();
    const gate = deferred<void>();
    const callerEvents: string[] = [];
    const callerChunks: string[] = [];

    const runSpy = vi.spyOn(runner.getAgent(), "run").mockImplementation(async (_input, options: AgentRunOptions = {}) => {
      options.onEvent?.({
        type: "reasoning",
        message: "first event",
        timestamp: "2026-08-24T20:00:00.000Z",
      });
      options.onChunk?.("alpha");

      await gate.promise;

      options.onEvent?.({
        type: "decision",
        message: "second event",
        timestamp: "2026-08-24T20:00:01.000Z",
      });
      options.onChunk?.("omega");
      return result("finished");
    });

    const iterator = runner.run("hello", {
      stream: false,
      onEvent: (event) => callerEvents.push(event.message),
      onChunk: (chunk) => callerChunks.push(chunk),
    });

    const start = await iterator.next();
    expect(start.value).toMatchObject({ type: "start", data: { maxIterations: 7 } });

    // These two frames arrive while the mocked Agent.run() is still blocked on `gate`.
    // The old implementation could not produce either until the whole run completed.
    const firstEvent = await iterator.next();
    expect(firstEvent.value).toMatchObject({
      type: "event",
      data: { type: "reasoning", message: "first event" },
    });

    const firstChunk = await iterator.next();
    expect(firstChunk.value).toEqual({ type: "chunk", data: { text: "alpha" } });

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0]?.[1]?.stream).toBe(true);
    expect(callerEvents).toEqual(["first event"]);
    expect(callerChunks).toEqual(["alpha"]);

    gate.resolve();

    const secondEvent = await iterator.next();
    expect(secondEvent.value).toMatchObject({
      type: "event",
      data: { type: "decision", message: "second event" },
    });

    const secondChunk = await iterator.next();
    expect(secondChunk.value).toEqual({ type: "chunk", data: { text: "omega" } });

    const completion = await iterator.next();
    expect(completion.value).toMatchObject({
      type: "completion",
      data: { response: "finished" },
    });

    const done = await iterator.next();
    expect(done.done).toBe(true);
    expect(callerEvents).toEqual(["first event", "second event"]);
    expect(callerChunks).toEqual(["alpha", "omega"]);
  });

  it("emits an error frame instead of throwing when the underlying run rejects", async () => {
    const runner = makeRunner();
    const gate = deferred<void>();

    vi.spyOn(runner.getAgent(), "run").mockImplementation(async (_input, options: AgentRunOptions = {}) => {
      options.onChunk?.("before failure");
      await gate.promise;
      throw new Error("provider exploded");
    });

    const iterator = runner.run("hello");
    expect((await iterator.next()).value).toMatchObject({ type: "start" });
    expect((await iterator.next()).value).toEqual({ type: "chunk", data: { text: "before failure" } });

    gate.resolve();

    const error = await iterator.next();
    expect(error.value).toMatchObject({
      type: "error",
      data: { message: "provider exploded" },
    });
    expect((await iterator.next()).done).toBe(true);
  });

  it("stops the underlying Agent when the consumer cancels before completion", async () => {
    const runner = makeRunner();
    const gate = deferred<AgentRunResult>();
    const agent = runner.getAgent();

    vi.spyOn(agent, "run").mockImplementation(async (_input, options: AgentRunOptions = {}) => {
      options.onChunk?.("still running");
      return gate.promise;
    });
    const stopSpy = vi.spyOn(agent, "stop").mockImplementation(() => undefined);

    const iterator = runner.run("hello");
    expect((await iterator.next()).value).toMatchObject({ type: "start" });
    expect((await iterator.next()).value).toEqual({ type: "chunk", data: { text: "still running" } });

    await iterator.return(undefined);
    expect(stopSpy).toHaveBeenCalledTimes(1);

    // Let the mocked execution settle after cancellation so the test also proves the
    // runner keeps a rejection/settlement observer attached after the consumer leaves.
    gate.resolve(result("late completion"));
    await Promise.resolve();
  });
});

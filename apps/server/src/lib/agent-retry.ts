import type { Agent, AgentRunResult } from "@ducki/agent";

type AgentRunOptions = Parameters<Agent["run"]>[1];

export function shouldRetryAgentRun(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return normalized.includes("cannot read properties")
    || normalized.includes("cannot read property")
    || normalized.includes("cannot set properties")
    || normalized.includes("is not a function")
    || normalized.includes("undefined is not")
    || normalized.includes("typeerror")
    || normalized.includes("referenceerror")
    || normalized.includes("syntaxerror")
    || normalized.includes("rangeerror")
    || normalized.includes("maximum call stack size exceeded")
    || normalized.includes("out of memory");
}

export async function runAgentWithRepairRetry(
  createAgent: () => Agent,
  firstPrompt: string,
  retryPromptFactory: (errorMessage: string) => string,
  prepareAgentRun?: (agent: Agent, attempt: number) => Promise<void> | void,
  options?: AgentRunOptions
): Promise<{ result: AgentRunResult; attempts: number }> {
  const firstAgent = createAgent();
  try {
    await prepareAgentRun?.(firstAgent, 1);
    const result = await firstAgent.run(firstPrompt, options);
    return { result, attempts: 1 };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (!shouldRetryAgentRun(errorMessage)) {
      throw error;
    }

    const retryAgent = createAgent();
    await prepareAgentRun?.(retryAgent, 2);
    const retryPrompt = retryPromptFactory(errorMessage);
    const retryOptions: AgentRunOptions | undefined = options?.stream
      ? { ...options, stream: options.stream }
      : options;
    const retryResult = await retryAgent.run(retryPrompt, retryOptions);
    return { result: retryResult, attempts: 2 };
  }
}

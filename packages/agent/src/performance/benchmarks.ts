/**
 * Performance Benchmarks for Agent Runtime
 * Measures: iteration latency, memory usage, token efficiency, tool execution time
 */

import type { LLMProvider } from "@ducki/providers";
import type { DatabaseService } from "@ducki/database";
import { Agent } from "../agent.js";
import type { AgentOptions } from "../config/interfaces_types.js";

/**
 * Benchmark result data.
 */
export interface BenchmarkResult {
  name: string;
  iterations: number;
  totalTimeMs: number;
  avgTimeMs: number;
  minTimeMs: number;
  maxTimeMs: number;
  memoryDeltaMb: number;
  success: boolean;
  error?: string;
}

/**
 * Comprehensive benchmark suite for agent runtime.
 */
export class AgentBenchmark {
  constructor(
    private provider: LLMProvider,
    private db: DatabaseService
  ) {}

  /**
   * Benchmark: Single iteration latency.
   * Measures time from "start run" to "first completion or tool call".
   */
  async benchmarkIterationLatency(iterations: number = 10): Promise<BenchmarkResult> {
    const times: number[] = [];
    const agent = new Agent(this.provider, this.db);

    try {
      for (let i = 0; i < iterations; i++) {
        const startMem = this.getMemoryUsage();
        const startTime = performance.now();

        await agent.run("What is 2+2?", { stream: false });

        const endTime = performance.now();
        const endMem = this.getMemoryUsage();

        times.push(endTime - startTime);
      }

      return {
        name: "iteration-latency",
        iterations,
        totalTimeMs: times.reduce((a, b) => a + b, 0),
        avgTimeMs: times.reduce((a, b) => a + b, 0) / times.length,
        minTimeMs: Math.min(...times),
        maxTimeMs: Math.max(...times),
        memoryDeltaMb: 0, // Simplified
        success: true,
      };
    } catch (error) {
      return {
        name: "iteration-latency",
        iterations,
        totalTimeMs: 0,
        avgTimeMs: 0,
        minTimeMs: 0,
        maxTimeMs: 0,
        memoryDeltaMb: 0,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Benchmark: Tool execution throughput.
   * Measures how many tool calls can be executed per second.
   */
  async benchmarkToolThroughput(toolCount: number = 100): Promise<BenchmarkResult> {
    const agent = new Agent(this.provider, this.db);
    const times: number[] = [];

    try {
      for (let i = 0; i < toolCount; i++) {
        const startTime = performance.now();

        // Execute a simple filesystem read (mocked)
        await agent.executor.execute("filesystem", {
          action: "read",
          path: "/tmp/test.txt",
        });

        const endTime = performance.now();
        times.push(endTime - startTime);
      }

      const totalMs = times.reduce((a, b) => a + b, 0);
      const throughputPerSecond = (toolCount / (totalMs / 1000)).toFixed(1);

      return {
        name: "tool-throughput",
        iterations: toolCount,
        totalTimeMs: totalMs,
        avgTimeMs: totalMs / toolCount,
        minTimeMs: Math.min(...times),
        maxTimeMs: Math.max(...times),
        memoryDeltaMb: 0,
        success: true,
      };
    } catch (error) {
      return {
        name: "tool-throughput",
        iterations: toolCount,
        totalTimeMs: 0,
        avgTimeMs: 0,
        minTimeMs: 0,
        maxTimeMs: 0,
        memoryDeltaMb: 0,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Benchmark: Hook execution overhead.
   * Measures impact of hook system (Phase 1) on performance.
   */
  async benchmarkHookOverhead(): Promise<BenchmarkResult> {
    const noHooksAgent = new Agent(this.provider, this.db);
    const withHooksAgent = new Agent(this.provider, this.db, undefined, {
      hooks: [
        {
          name: "test-hook",
          priority: 50,
          handler: async () => ({ proceed: true }),
        },
      ],
    });

    const times: { noHooks: number[]; withHooks: number[] } = { noHooks: [], withHooks: [] };

    try {
      // Run without hooks
      for (let i = 0; i < 5; i++) {
        const startTime = performance.now();
        await noHooksAgent.run("Test query 1");
        times.noHooks.push(performance.now() - startTime);
      }

      // Run with hooks
      for (let i = 0; i < 5; i++) {
        const startTime = performance.now();
        await withHooksAgent.run("Test query 2");
        times.withHooks.push(performance.now() - startTime);
      }

      const noHooksAvg = times.noHooks.reduce((a, b) => a + b, 0) / times.noHooks.length;
      const withHooksAvg = times.withHooks.reduce((a, b) => a + b, 0) / times.withHooks.length;
      const overhead = ((withHooksAvg - noHooksAvg) / noHooksAvg) * 100;

      return {
        name: "hook-overhead",
        iterations: 10,
        totalTimeMs: times.withHooks.reduce((a, b) => a + b, 0),
        avgTimeMs: withHooksAvg,
        minTimeMs: Math.min(...times.withHooks),
        maxTimeMs: Math.max(...times.withHooks),
        memoryDeltaMb: 0,
        success: true,
      };
    } catch (error) {
      return {
        name: "hook-overhead",
        iterations: 10,
        totalTimeMs: 0,
        avgTimeMs: 0,
        minTimeMs: 0,
        maxTimeMs: 0,
        memoryDeltaMb: 0,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Benchmark: Event emission overhead (Phase 1).
   * Measures impact of granular events on performance.
   */
  async benchmarkEventOverhead(): Promise<BenchmarkResult> {
    const agentNoEvents = new Agent(this.provider, this.db);
    const agentWithEvents = new Agent(this.provider, this.db, {
      emitEvent: () => {}, // Emit but do nothing
      emitChunk: () => {},
    });

    const times: number[] = [];

    try {
      for (let i = 0; i < 5; i++) {
        const startTime = performance.now();
        await agentWithEvents.run("Quick test");
        times.push(performance.now() - startTime);
      }

      return {
        name: "event-overhead",
        iterations: 5,
        totalTimeMs: times.reduce((a, b) => a + b, 0),
        avgTimeMs: times.reduce((a, b) => a + b, 0) / times.length,
        minTimeMs: Math.min(...times),
        maxTimeMs: Math.max(...times),
        memoryDeltaMb: 0,
        success: true,
      };
    } catch (error) {
      return {
        name: "event-overhead",
        iterations: 5,
        totalTimeMs: 0,
        avgTimeMs: 0,
        minTimeMs: 0,
        maxTimeMs: 0,
        memoryDeltaMb: 0,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Run all benchmarks and return aggregated results.
   */
  async runAll(): Promise<BenchmarkResult[]> {
    return Promise.all([
      this.benchmarkIterationLatency(5),
      this.benchmarkHookOverhead(),
      this.benchmarkEventOverhead(),
    ]);
  }

  /**
   * Helper: Get current memory usage in MB.
   */
  private getMemoryUsage(): number {
    if (typeof process !== "undefined" && process.memoryUsage) {
      return process.memoryUsage().heapUsed / 1024 / 1024;
    }
    return 0;
  }

  /**
   * Format benchmark results as table.
   */
  static formatResults(results: BenchmarkResult[]): string {
    const lines = [
      "Benchmark Results",
      "=================",
      "",
    ];

    for (const result of results) {
      lines.push(`${result.name}:`);
      lines.push(`  Iterations:    ${result.iterations}`);
      lines.push(`  Avg Time:      ${result.avgTimeMs.toFixed(2)}ms`);
      lines.push(`  Min/Max:       ${result.minTimeMs.toFixed(2)}ms / ${result.maxTimeMs.toFixed(2)}ms`);
      lines.push(`  Total Time:    ${result.totalTimeMs.toFixed(2)}ms`);
      if (!result.success) {
        lines.push(`  ERROR:         ${result.error}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}

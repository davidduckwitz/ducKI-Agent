import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    /**
     * Child processes instead of worker threads.
     *
     * With the default `threads` pool the suite segfaulted (exit 139) in roughly one run in
     * three - always AFTER all tests had passed, during worker teardown. The cause is the
     * native `@libsql/client` addon the database package pulls in: unloading a native addon
     * from a worker thread is unreliable, and a crash there turns a fully green run into a
     * failing exit code. Forked processes tear down cleanly.
     *
     * Measured on this repo: no difference in wall-clock time (~11-12s either way), and 0
     * failures across repeated runs versus 1-in-3 with threads.
     */
    pool: "forks",
    /**
     * Keep the vitest defaults and additionally skip .claude/worktrees: those are
     * separate git worktrees of other sessions with their own code states, whose
     * tests would otherwise pollute (and fail) the main suite.
     */
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
      "**/.claude/worktrees/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts"],
    },
  },
});

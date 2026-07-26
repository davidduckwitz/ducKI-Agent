#!/usr/bin/env node
/**
 * Compiles whisper.cpp for nodejs-whisper.
 *
 * nodejs-whisper builds whisper.cpp only as a side effect of downloading a model - it
 * returns early when the model file is already present, so the build never happens on a
 * checkout where the model survived but the build directory did not (a clean, a
 * reinstall, a fresh node_modules). The library then fails every transcription with
 * "whisper-cli executable not found" and cannot repair itself. This script performs the
 * same CMake build the library would have run.
 *
 * Requires CMake and a C++ toolchain (on Windows: Visual Studio Build Tools).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

function resolveWhisperCppPath() {
  // pnpm keeps dependencies under the package that declares them, so nodejs-whisper is
  // not resolvable from the workspace root - look it up from the packages that depend
  // on it instead.
  const searchPaths = [
    join(process.cwd(), "packages", "providers"),
    join(process.cwd(), "apps", "server"),
    process.cwd(),
  ];

  for (const base of searchPaths) {
    try {
      const entry = require.resolve("nodejs-whisper", { paths: [base] });
      return join(dirname(dirname(entry)), "cpp", "whisper.cpp");
    } catch {
      // Try the next workspace package.
    }
  }

  return undefined;
}

function resolveCmake() {
  const probe = spawnSync("cmake", ["--version"], { stdio: "ignore", shell: true });
  if (probe.status === 0) return "cmake";

  // CMake's Windows installer does not always put itself on PATH.
  const fallback = "C:\\Program Files\\CMake\\bin\\cmake.exe";
  if (process.platform === "win32" && existsSync(fallback)) return fallback;

  return undefined;
}

function run(cmake, args, cwd) {
  console.log(`> ${cmake} ${args.join(" ")}`);
  const result = spawnSync(cmake, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`CMake step failed (exit ${result.status ?? "unknown"}): ${args.join(" ")}`);
  }
}

const whisperCppPath = resolveWhisperCppPath();
if (!whisperCppPath || !existsSync(whisperCppPath)) {
  console.error("nodejs-whisper ist nicht installiert (cpp/whisper.cpp fehlt). Zuerst 'pnpm install' ausfuehren.");
  process.exit(1);
}

const cmake = resolveCmake();
if (!cmake) {
  console.error(
    "CMake wurde nicht gefunden. Installiere CMake (https://cmake.org/download/) und stelle sicher, dass es im PATH liegt."
  );
  process.exit(1);
}

const withCuda = ["1", "true", "yes", "on"].includes((process.env["NODEJS_WHISPER_USE_CUDA"] ?? "").toLowerCase());

try {
  const configureArgs = ["-B", "build", "-DCMAKE_BUILD_TYPE=Release", "-DWHISPER_BUILD_TESTS=OFF"];
  if (withCuda) configureArgs.push("-DGGML_CUDA=1");
  run(cmake, configureArgs, whisperCppPath);
  run(cmake, ["--build", "build", "--config", "Release", "--target", "whisper-cli"], whisperCppPath);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const built = [
  join("build", "bin", "Release", "whisper-cli.exe"),
  join("build", "bin", "Debug", "whisper-cli.exe"),
  join("build", "bin", "whisper-cli.exe"),
  join("build", "bin", "whisper-cli"),
].find((candidate) => existsSync(join(whisperCppPath, candidate)));

if (!built) {
  console.error("Build lief durch, aber es wurde keine whisper-cli Binary gefunden.");
  process.exit(1);
}

console.log(`whisper-cli gebaut: ${join(whisperCppPath, built)}`);

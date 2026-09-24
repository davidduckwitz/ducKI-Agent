import { execFileSync } from "node:child_process";

/**
 * True if an actual CUDA Toolkit (nvcc) is installed. `withCuda: true` without this present
 * doesn't fail cleanly - nodejs-whisper only discovers it's missing deep inside a CMake
 * configure step, surfacing a wall of raw CMake/CUDA-CMakeLists output instead of a usable
 * error. Callers that hardcode withCuda:true must still gate on this; it exists here mainly
 * so unset defaults can pick a sane value automatically instead of hardcoding "off".
 */
export function hasCudaToolkit(): boolean {
  if (process.env["CUDA_PATH"]) return true;
  try {
    execFileSync("nvcc", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let cachedCudaAvailable: boolean | undefined;

/** Cached: nvcc --version spawns a process, not worth repeating per transcription. */
export function resolveNodejsWhisperCudaDefault(): boolean {
  if (cachedCudaAvailable === undefined) cachedCudaAvailable = hasCudaToolkit();
  return cachedCudaAvailable;
}

/**
 * Default whisper.cpp model when nothing was configured explicitly. On CPU, model load +
 * inference time dominates short voice commands, so "tiny" trades some accuracy for a much
 * faster response; once a GPU absorbs that cost, "base" is worth the better accuracy.
 */
export function resolveNodejsWhisperModelDefault(): string {
  return resolveNodejsWhisperCudaDefault() ? "base" : "tiny";
}

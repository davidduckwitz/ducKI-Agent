import { describe, expect, it } from "vitest";
import { CODING_ROOT, resolveCodingSandboxRoot } from "./coding";

describe("resolveCodingSandboxRoot", () => {
  it("keeps traversal-shaped project references under the coding root", () => {
    expect(resolveCodingSandboxRoot("../bitcoin-dashboard"))
      .toBe(`${CODING_ROOT}/bitcoin-dashboard`.replaceAll("/", "\\"));
  });

  it("resolves a plain project slug under the coding root", () => {
    expect(resolveCodingSandboxRoot("bitcoin-dashboard"))
      .toBe(`${CODING_ROOT}/bitcoin-dashboard`.replaceAll("/", "\\"));
  });

  it("preserves trusted absolute staging paths", () => {
    const absolute = "C:\\temp\\coding-stage";
    expect(resolveCodingSandboxRoot(absolute)).toBe(absolute);
  });
});

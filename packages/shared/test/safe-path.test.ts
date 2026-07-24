import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { resolveWithinRoot } from "../src/index.ts";

describe("resolveWithinRoot", () => {
  const root = join("C:", "workspace", "shared-workspace");

  it("resolves a plain relative path under the root", () => {
    expect(resolveWithinRoot(root, "chat-uploads/photo.png")).toBe(join(root, "chat-uploads", "photo.png"));
  });

  it("tolerates a redundant leading shared-workspace/ prefix", () => {
    expect(resolveWithinRoot(root, "shared-workspace/chat-uploads/photo.png")).toBe(
      join(root, "chat-uploads", "photo.png")
    );
  });

  it("tolerates a leading slash and backslashes", () => {
    expect(resolveWithinRoot(root, "/chat-uploads\\photo.png")).toBe(join(root, "chat-uploads", "photo.png"));
  });

  it("rejects .. traversal", () => {
    expect(() => resolveWithinRoot(root, "../secrets.txt")).toThrow();
    expect(() => resolveWithinRoot(root, "chat-uploads/../../secrets.txt")).toThrow();
  });

  it("rejects an empty path", () => {
    expect(() => resolveWithinRoot(root, "")).toThrow();
    expect(() => resolveWithinRoot(root, "   ")).toThrow();
  });

  it("rejects a sibling directory that merely shares the root's name as a prefix", () => {
    const evilRoot = `${root}-evil`;
    expect(() => resolveWithinRoot(root, evilRoot)).toThrow();
  });

  it("allows the root itself", () => {
    expect(resolveWithinRoot(root, ".")).toBe(root);
  });
});

import { describe, it, expect } from "vitest";
import { resolveApiUrl } from "./apiFetchRewrite";

const ORIGIN = "https://ducki-ai-agent.davidduckwitz.de";

describe("resolveApiUrl", () => {
  it("is a no-op in local mode (apiBase '/api')", () => {
    expect(resolveApiUrl("/api/skills", ORIGIN, "/api")).toBeNull();
    expect(resolveApiUrl("/api", ORIGIN, "/api")).toBeNull();
  });

  it("rewrites relative /api paths onto a remote base", () => {
    expect(resolveApiUrl("/api/skills", ORIGIN, "http://127.0.0.1:3001/api")).toBe(
      "http://127.0.0.1:3001/api/skills"
    );
    expect(resolveApiUrl("/api/settings/x?y=1", ORIGIN, "http://127.0.0.1:3001/api")).toBe(
      "http://127.0.0.1:3001/api/settings/x?y=1"
    );
  });

  it("rewrites same-origin absolute /api URLs", () => {
    expect(resolveApiUrl(`${ORIGIN}/api/health`, ORIGIN, "http://127.0.0.1:3001/api")).toBe(
      "http://127.0.0.1:3001/api/health"
    );
  });

  it("leaves non-/api paths untouched", () => {
    expect(resolveApiUrl("/web/assets/x.js", ORIGIN, "http://127.0.0.1:3001/api")).toBeNull();
    expect(resolveApiUrl("/apixyz/thing", ORIGIN, "http://127.0.0.1:3001/api")).toBeNull();
  });

  it("leaves other origins (already-remote backend) untouched", () => {
    expect(
      resolveApiUrl("http://127.0.0.1:3001/api/health", ORIGIN, "http://127.0.0.1:3001/api")
    ).toBeNull();
    expect(resolveApiUrl("https://cdn.example.com/api/x", ORIGIN, "http://127.0.0.1:3001/api")).toBeNull();
  });

  it("preserves query and hash", () => {
    expect(resolveApiUrl("/api/x?a=1#frag", ORIGIN, "http://h:3001/api")).toBe("http://h:3001/api/x?a=1#frag");
  });
});

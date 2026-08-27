import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browserTool, executeInWorker } from "../src/browser.ts";

// detect runs in the main process (no worker fork), so it's safe at module load.
// On machines without a local Chrome/Edge the whole suite is skipped instead of failing.
const detect = await browserTool.execute({ action: "detect" });
const browserAvailable = Boolean(
  detect.success && (detect.data as { browserAvailable?: boolean })?.browserAvailable
);

const HTML = `<!doctype html><html><body>
<h1>Testseite</h1>
<p id="status">Hallo Welt</p>
<label>Name <input id="name" type="text" placeholder="Dein Name"></label>
<button id="save" onclick="document.getElementById('status').textContent='Gespeichert'">Speichern</button>
<select id="land"><option value="de">Deutschland</option><option value="at">Österreich</option></select>
<input type="checkbox" id="cb"><label for="cb">Zustimmen</label>
<div id="drop" style="width:120px;height:60px;border:1px solid #999">Dropzone</div>
<div id="scroller" style="height:120px;overflow:auto;border:1px solid #333"><div style="height:700px"><button id="nested-bottom" style="margin-top:620px">Unten im Panel</button></div></div>
<div style="height:900px"></div><button id="page-bottom">Unten auf Seite</button>
</body></html>`;
const PAGE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`;

describe.skipIf(!browserAvailable)("browser tool - snapshot / text-based targeting / expect", () => {
  let sessionId: string | undefined;

  beforeAll(async () => {
    const r = await executeInWorker({
      action: "launch",
      headless: true,
      newSession: true,
      url: PAGE_URL,
      timeoutMs: 20000,
    });
    expect(r.success).toBe(true);
    sessionId = (r.data as { sessionId: string }).sessionId;
  }, 60000);

  afterAll(async () => {
    if (sessionId) await executeInWorker({ action: "close", sessionId });
  });

  it("snapshot returns an interactive element tree with names and deterministic selectors", async () => {
    const r = await executeInWorker({ action: "snapshot", sessionId, maxNodes: 100 });
    expect(r.success).toBe(true);
    const data = r.data as { elements: Array<Record<string, unknown>> };
    expect(data.elements.length).toBeGreaterThan(0);
    const button = data.elements.find(
      (e) => e.role === "button" && String(e.name).includes("Speichern")
    );
    expect(button).toBeTruthy();
    expect(String((button as Record<string, unknown>).selector)).toMatch(/^#/);
    const input = data.elements.find(
      (e) => e.role === "textbox" && String(e.name).includes("Name")
    );
    expect(input).toBeTruthy();
    const offscreen = data.elements.find((e) => e.name === "Unten auf Seite");
    expect(offscreen).toBeTruthy();
    expect(offscreen?.inViewport).toBe(false);
  }, 30000);

  it("clicks by accessible name (no CSS selector) and the page reacts", async () => {
    const r = await executeInWorker({ action: "click", sessionId, text: "Speichern" });
    expect(r.success).toBe(true);
    expect(String((r.data as { clicked: string }).clicked)).toMatch(/^#/);
    const ex = await executeInWorker({
      action: "expect",
      sessionId,
      condition: "text_visible",
      text: "Gespeichert",
      timeout: 3000,
    });
    expect((ex.data as { passed: boolean }).passed).toBe(true);
  }, 30000);

  it("types into a field by its label and verifies the value", async () => {
    const r = await executeInWorker({
      action: "type",
      sessionId,
      target: "Name",
      text: "Max Mustermann",
    });
    expect(r.success).toBe(true);
    const ev = await executeInWorker({
      action: "evaluate",
      sessionId,
      script: "document.querySelector('#name').value",
    });
    expect(ev.success).toBe(true);
    expect(String((ev.data as { result?: unknown }).result ?? "")).toBe("Max Mustermann");
  }, 30000);

  it("forwards normalized pointer and raw keyboard input for the shared UI browser", async () => {
    // The button sits near the top of the default viewport. This verifies the coordinate
    // path used by the live sidebar without relying on semantic selectors.
    const click = await executeInWorker({ action: "mouse_click", sessionId, xRatio: 0.08, yRatio: 0.16 });
    expect(click.success).toBe(true);

    await executeInWorker({ action: "click", sessionId, selector: "#name" });
    const typed = await executeInWorker({ action: "keyboard_type", sessionId, text: " via UI" });
    expect(typed.success).toBe(true);
    const ev = await executeInWorker({ action: "evaluate", sessionId, script: "document.querySelector('#name').value" });
    expect(String((ev.data as { result?: unknown }).result ?? "")).toContain("via UI");
  }, 30000);

  it("supports shared history, reload and scrolling controls", async () => {
    expect((await executeInWorker({ action: "scroll_by", sessionId, deltaY: 120 })).success).toBe(true);
    expect((await executeInWorker({ action: "reload", sessionId })).success).toBe(true);
    expect((await executeInWorker({ action: "keyboard_press", sessionId, key: "Tab" })).success).toBe(true);
  }, 30000);

  it("scrolls the nested element under the UI pointer and can click off-screen controls by name", async () => {
    const rect = await executeInWorker({ action: "evaluate", sessionId, script: "(() => { const r=document.querySelector('#scroller').getBoundingClientRect(); return {x:(r.left+r.width/2)/innerWidth,y:(r.top+r.height/2)/innerHeight}; })()" });
    const point = (rect.data as { result: { x: number; y: number } }).result;
    const scrolled = await executeInWorker({ action: "scroll_by", sessionId, deltaY: 350, xRatio: point.x, yRatio: point.y });
    expect(scrolled.success).toBe(true);
    const nestedOffset = await executeInWorker({ action: "evaluate", sessionId, script: "document.querySelector('#scroller').scrollTop" });
    expect(Number((nestedOffset.data as { result: unknown }).result)).toBeGreaterThan(0);
    const clicked = await executeInWorker({ action: "click", sessionId, text: "Unten auf Seite", role: "button" });
    expect(clicked.success).toBe(true);
  }, 30000);

  it("does not silently redirect a stale session id to another live session", async () => {
    const result = await executeInWorker({ action: "get_content", sessionId: "stale-session-id" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("stale-session-id");
  });

  it("keeps a shared screencast alive until its final viewer leaves", async () => {
    const first = await executeInWorker({ action: "stream_start", sessionId, viewerId: "test-a" });
    const second = await executeInWorker({ action: "stream_start", sessionId, viewerId: "test-b" });
    expect(first.success).toBe(true);
    expect((second.data as { consumers: number }).consumers).toBe(2);
    const oneLeft = await executeInWorker({ action: "stream_stop", sessionId, viewerId: "test-a" });
    expect((oneLeft.data as { streaming: boolean; wasStreaming: boolean }).wasStreaming).toBe(false);
    const finalLeft = await executeInWorker({ action: "stream_stop", sessionId, viewerId: "test-b" });
    expect((finalLeft.data as { streaming: boolean; wasStreaming: boolean }).wasStreaming).toBe(true);
  }, 30000);

  it("lets the UI select the exact shared default session used by agent calls", async () => {
    const selected = await executeInWorker({ action: "set_default", sessionId });
    expect(selected.success).toBe(true);
    const sessions = await executeInWorker({ action: "list_sessions" });
    const active = (sessions.data as { sessions: Array<{ sessionId: string; isDefault: boolean }> }).sessions.find((item) => item.sessionId === sessionId);
    expect(active?.isDefault).toBe(true);
    const implicit = await executeInWorker({ action: "get_content" });
    expect((implicit.data as { sessionId: string }).sessionId).toBe(sessionId);
  }, 30000);

  it("selects a dropdown option by its visible label", async () => {
    const r = await executeInWorker({
      action: "select",
      sessionId,
      selector: "#land",
      option: "Österreich",
    });
    expect(r.success).toBe(true);
    expect((r.data as { selected: string[] }).selected).toContain("at");
  }, 30000);

  it("hovers an element by name", async () => {
    const r = await executeInWorker({ action: "hover", sessionId, text: "Speichern" });
    expect(r.success).toBe(true);
  }, 30000);

  it("expect passes and fails correctly", async () => {
    const visible = await executeInWorker({
      action: "expect",
      sessionId,
      condition: "element_visible",
      text: "Speichern",
      timeout: 3000,
    });
    expect((visible.data as { passed: boolean }).passed).toBe(true);

    const hidden = await executeInWorker({
      action: "expect",
      sessionId,
      condition: "element_hidden",
      text: "GibtEsNicht",
      timeout: 3000,
    });
    expect((hidden.data as { passed: boolean }).passed).toBe(true);

    const absent = await executeInWorker({
      action: "expect",
      sessionId,
      condition: "text_visible",
      text: "GibtEsNicht",
      timeout: 1500,
    });
    expect((absent.data as { passed: boolean }).passed).toBe(false);
    expect(String((absent.data as { reason: string }).reason)).toMatch(/not found|not met/);
  }, 30000);

  it("get_page_errors reports no captured errors on a clean page", async () => {
    const r = await executeInWorker({ action: "get_page_errors", sessionId });
    expect(r.success).toBe(true);
    const d = r.data as { pageErrorCount: number; networkErrorCount: number };
    expect(d.pageErrorCount).toBe(0);
    expect(d.networkErrorCount).toBe(0);
  }, 30000);

  it("get_page_errors captures a console error and expect(no_page_errors) fails on it", async () => {
    const ev = await executeInWorker({
      action: "evaluate",
      sessionId,
      script: "console.error('test-error-123')",
    });
    expect(ev.success).toBe(true);
    const r = await executeInWorker({ action: "get_page_errors", sessionId });
    expect(r.success).toBe(true);
    const d = r.data as { pageErrors: Array<{ text: string }> };
    expect(d.pageErrors.some((e) => e.text.includes("test-error-123"))).toBe(true);
    const ex = await executeInWorker({
      action: "expect",
      sessionId,
      condition: "no_page_errors",
      timeout: 1000,
    });
    expect((ex.data as { passed: boolean }).passed).toBe(false);
    // Clean up for the next run: clear the captured errors.
    await executeInWorker({ action: "get_page_errors", sessionId, clear: true });
  }, 30000);

  it("mark_dirty forces exactly one reload on the next inspection, not on every repeated call", async () => {
    // A page-scoped global is wiped by navigation but survives ordinary JS execution - a cheap,
    // unambiguous signal for "did the page actually reload".
    await executeInWorker({ action: "evaluate", sessionId, script: "window.__marker = 'still-here'" });

    const untouched1 = await executeInWorker({ action: "evaluate", sessionId, script: "window.__marker" });
    expect(untouched1.data).toMatchObject({ result: "still-here" });
    const untouched2 = await executeInWorker({ action: "evaluate", sessionId, script: "window.__marker" });
    expect(untouched2.data).toMatchObject({ result: "still-here" });

    const marked = await executeInWorker({ action: "mark_dirty", sessionId });
    expect(marked.success).toBe(true);
    expect((marked.data as { dirty: boolean }).dirty).toBe(true);

    // The next inspection reloads once - the marker set via evaluate() does not survive that.
    const afterDirty = await executeInWorker({ action: "evaluate", sessionId, script: "window.__marker" });
    expect((afterDirty.data as { result: unknown }).result).toBeUndefined();

    // Re-seed and confirm the flag was consumed: a second evaluate right after must NOT reload.
    await executeInWorker({ action: "evaluate", sessionId, script: "window.__marker = 'still-here'" });
    const afterDirtyAgain = await executeInWorker({ action: "evaluate", sessionId, script: "window.__marker" });
    expect(afterDirtyAgain.data).toMatchObject({ result: "still-here" });
  }, 30000);

  it("mark_dirty on a nonexistent session is a harmless no-op instead of an error", async () => {
    const r = await executeInWorker({ action: "mark_dirty", sessionId: "does-not-exist" });
    expect(r.success).toBe(true);
    expect((r.data as { dirty: boolean }).dirty).toBe(false);
  }, 10000);
});

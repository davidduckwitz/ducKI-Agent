import { expect, it } from "vitest";
import { speechFlushBoundary } from "./speechFlushBoundary";

it("keeps short unfinished Chatterbox fragments buffered", () => {
  expect(speechFlushBoundary("Das ist eine noch nicht abgeschlossene Aussage", true, true)).toBe(0);
});
it("flushes completed sentences immediately", () => {
  expect(speechFlushBoundary("Hallo! Wie geht es dir", true, true)).toBe(7);
});
it("uses larger subsequent chunks without splitting words", () => {
  const text = "Sprachausgabe ".repeat(25);
  const first = speechFlushBoundary(text, true, true);
  const next = speechFlushBoundary(text, false, true);
  expect(first).toBeGreaterThan(40);
  expect(next).toBeGreaterThan(first);
  expect(text[first - 1]).toBe(" ");
  expect(text[next - 1]).toBe(" ");
});
it("keeps unfinished long words and supports faster streaming providers", () => {
  expect(speechFlushBoundary("x".repeat(130), true, true)).toBe(0);
  expect(speechFlushBoundary("Ein Text mit mehreren Worten ohne Abschluss und mehr", true, false)).toBeGreaterThan(0);
});

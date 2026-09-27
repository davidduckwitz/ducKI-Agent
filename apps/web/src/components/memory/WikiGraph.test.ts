import { describe, expect, it } from "vitest";
import { graphFitTransform } from "./WikiGraph";

const node = (id: string, title: string, x: number, y: number) => ({
  id,
  title,
  x,
  y,
  status: "approved",
  tags: [],
  degree: 0,
});

describe("graphFitTransform", () => {
  it("moves a graph that settled outside the canvas into view", () => {
    const transform = graphFitTransform(
      [node("left.md", "Left node", -200, 100), node("right.md", "Right node", 600, 400)],
      800,
      500,
    );

    for (const point of [{ x: -200, y: 100 }, { x: 600, y: 400 }]) {
      const screenX = point.x * transform.k + transform.x;
      const screenY = point.y * transform.k + transform.y;
      expect(screenX).toBeGreaterThan(40);
      expect(screenX).toBeLessThan(760);
      expect(screenY).toBeGreaterThan(40);
      expect(screenY).toBeLessThan(460);
    }
  });

  it("does not over-zoom a compact graph", () => {
    const transform = graphFitTransform([node("index.md", "Index", 100, 100)], 1200, 700);
    expect(transform.k).toBeLessThanOrEqual(1.25);
  });

  it("returns the identity transform before nodes have positions", () => {
    const transform = graphFitTransform(
      [{ id: "index.md", title: "Index", status: "approved", tags: [], degree: 0 }],
      800,
      500,
    );
    expect(transform).toEqual({ x: 0, y: 0, k: 1 });
  });
});

#!/usr/bin/env node
// Renders the NSIS installer bitmaps (src-tauri/installer/{sidebar,header}.bmp) from the DucKI duck
// (same shapes as apps/web/src/components/chat/DuckyMascot.tsx). Dependency-free: a tiny
// supersampled polygon rasterizer writing 24-bit BMPs, which is what NSIS/MUI2 requires.
//
//   node scripts/generate-installer-art.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src-tauri/installer");

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

// ---- geometry (duck in its native 64x64 viewBox) ----------------------------------------------
function ellipse(cx, cy, rx, ry, steps = 48) {
  return Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * Math.PI * 2;
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
  });
}
function quad(p0, c, p1, steps = 16) {
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    pts.push([(1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p1[0], (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p1[1]]);
  }
  return pts;
}
const DUCK = [
  { color: "#F2B705", poly: [[14, 40], ...quad([14, 40], [6, 38], [8, 46]), ...quad([8, 46], [12, 47], [17, 43])] },
  { color: "#FFCE31", poly: ellipse(30, 42, 18, 14) },
  { color: "#FFE07A", poly: ellipse(27, 47, 11, 6), alpha: 0.55 },
  { color: "#F2B705", poly: [[27, 33], ...quad([27, 33], [40, 30], [39, 44]), ...quad([39, 44], [31, 45], [25, 40])] },
  { color: "#FFCE31", poly: ellipse(42, 24, 11, 11) },
  { color: "#FF9DB0", poly: ellipse(47, 27, 2.4, 2.4), alpha: 0.5 },
  { color: "#FF8A1E", poly: [[50, 22], [60, 25], [50, 29]] },
  { color: "#22303C", poly: ellipse(45, 21, 2.2, 2.2) },
  { color: "#FFFFFF", poly: ellipse(45.8, 20.2, 0.7, 0.7) },
];

function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

// ---- canvas -------------------------------------------------------------------------------------
function canvas(w, h, bg) {
  const px = new Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = bg(x, y);
  return { w, h, px };
}

/** Draws `shapes` (poly coords in a 64-unit box) scaled to `size` px with its top-left at ox/oy. */
function draw(c, shapes, ox, oy, size, ss = 4) {
  const k = size / 64;
  for (const shape of shapes) {
    const color = hex(shape.color);
    const poly = shape.poly.map(([x, y]) => [ox + x * k, oy + y * k]);
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    const [x0, x1] = [Math.max(0, Math.floor(Math.min(...xs))), Math.min(c.w - 1, Math.ceil(Math.max(...xs)))];
    const [y0, y1] = [Math.max(0, Math.floor(Math.min(...ys))), Math.min(c.h - 1, Math.ceil(Math.max(...ys)))];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        let hits = 0;
        for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) if (inside(poly, x + (sx + 0.5) / ss, y + (sy + 0.5) / ss)) hits++;
        if (!hits) continue;
        const a = (hits / (ss * ss)) * (shape.alpha ?? 1);
        c.px[y * c.w + x] = mix(c.px[y * c.w + x], color, a);
      }
    }
  }
}

function writeBmp(file, c) {
  const rowSize = Math.ceil((c.w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + rowSize * c.h);
  buf.write("BM", 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(c.w, 18);
  buf.writeInt32LE(c.h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(rowSize * c.h, 34);
  for (let y = 0; y < c.h; y++) {
    const row = 54 + (c.h - 1 - y) * rowSize; // bottom-up
    for (let x = 0; x < c.w; x++) {
      const [r, g, b] = c.px[y * c.w + x];
      buf[row + x * 3] = b;
      buf[row + x * 3 + 1] = g;
      buf[row + x * 3 + 2] = r;
    }
  }
  fs.writeFileSync(file, buf);
  console.log(`✓ ${path.relative(process.cwd(), file)} (${c.w}x${c.h})`);
}

// Deterministic "random" so regenerating yields identical files.
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// ---- sidebar 164x314: night pond ---------------------------------------------------------------
{
  const top = hex("#121b36");
  const bottom = hex("#0a0f1e");
  const water = hex("#1d4ed8");
  const W = 164;
  const H = 314;
  const waterY = 232;
  const c = canvas(W, H, (x, y) => {
    const base = mix(top, bottom, y / H);
    if (y < waterY) return base;
    const t = (y - waterY) / (H - waterY);
    const wave = 0.5 + 0.5 * Math.sin(x / 6 + y / 2);
    return mix(base, water, 0.18 + 0.22 * t + 0.05 * wave);
  });
  for (let i = 0; i < 60; i++) {
    const x = Math.floor(rand() * W);
    const y = Math.floor(rand() * (waterY - 10));
    c.px[y * W + x] = mix(c.px[y * W + x], [255, 255, 255], 0.35 + rand() * 0.6);
  }
  // wave crests
  for (let x = 0; x < W; x++) {
    for (const [baseY, a] of [[waterY, 0.55], [waterY + 18, 0.3], [waterY + 38, 0.18]]) {
      const y = Math.round(baseY + Math.sin(x / 5) * 1.5);
      c.px[y * W + x] = mix(c.px[y * W + x], hex("#60a5fa"), a);
    }
  }
  draw(c, DUCK, 14, 118, 136);
  writeBmp(path.join(outDir, "sidebar.bmp"), c);
}

// ---- header 150x57: light, duck on the right ---------------------------------------------------
{
  const c = canvas(150, 57, (x) => mix(hex("#ffffff"), hex("#fff6d6"), Math.max(0, (x - 60) / 90)));
  draw(c, DUCK, 96, 3, 52);
  writeBmp(path.join(outDir, "header.bmp"), c);
}

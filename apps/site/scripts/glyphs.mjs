#!/usr/bin/env node
/**
 * Samples Atkinson Hyperlegible Mono's outlines for the text the front page's
 * loom pulls into thread, into src/loom/glyphs.json: points in ems, y down.
 * The page draws the letters from these points and moves them, so it needs
 * no font parser. Run again after changing the text below.
 *
 *   pnpm --filter @weftwallet/site glyphs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const files = join(dirname(require.resolve("@fontsource/atkinson-hyperlegible-mono/package.json")), "files");
const load = (weight) => {
  const b = readFileSync(join(files, `atkinson-hyperlegible-mono-latin-${weight}-normal.woff`));
  return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const fonts = { 400: load(400), 500: load(500) };

/** A path's contours as point lists, about `step` ems apart. */
function contours(path, step) {
  const out = [];
  let cur = null, px = 0, py = 0;
  const push = (x, y) => cur.push([Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
  for (const c of path.commands) {
    const n = (k) => Math.max(k, Math.ceil(Math.hypot(c.x - px, c.y - py) / step));
    if (c.type === "M") {
      cur = [];
      out.push(cur);
      push(c.x, c.y);
    } else if (c.type === "L") {
      const m = n(1);
      for (let i = 1; i <= m; i++) push(px + ((c.x - px) * i) / m, py + ((c.y - py) * i) / m);
    } else if (c.type === "Q") {
      const m = n(2);
      for (let i = 1; i <= m; i++) {
        const t = i / m, u = 1 - t;
        push(u * u * px + 2 * u * t * c.x1 + t * t * c.x, u * u * py + 2 * u * t * c.y1 + t * t * c.y);
      }
    } else if (c.type === "C") {
      const m = n(3) * 2;
      for (let i = 1; i <= m; i++) {
        const t = i / m, u = 1 - t;
        push(u * u * u * px + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x, u * u * u * py + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y);
      }
    }
    if (c.type !== "Z") [px, py] = [c.x, c.y];
  }
  return out.filter((c) => c.length > 2);
}

function text(str, weight, step) {
  const font = fonts[weight];
  let x = 0;
  const glyphs = [];
  for (const ch of str) {
    const g = font.charToGlyph(ch);
    glyphs.push({ ch, contours: ch === " " ? [] : contours(g.getPath(x, 0, 1), step) });
    x += g.advanceWidth / font.unitsPerEm;
  }
  return { str, width: x, xHeight: font.tables.os2.sxHeight / font.unitsPerEm, glyphs };
}

const data = {
  // The lockup's word: weight 500, as the wordmark.
  weft: text("weft", 500, 0.012),
  // The calls woven into cloth under the hero.
  txs: ["TransferAsset(asset7, Org2MSP)", "CreateAsset(asset8, teal, 5)", "CastBallot(board-2026)", "ReadAsset(asset1)", "UpdateAsset(asset3, 300)", "DeleteAsset(asset6)"].map((s) => text(s, 400, 0.03)),
};
writeFileSync(join(here, "..", "src", "loom", "glyphs.json"), `${JSON.stringify(data)}\n`);
console.log(`Wrote src/loom/glyphs.json (${(JSON.stringify(data).length / 1024).toFixed(0)} KB)`);

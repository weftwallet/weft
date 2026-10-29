#!/usr/bin/env node
/**
 * Draws the lockups (mark plus wordmark) into logo/. The wordmark is "weft",
 * lowercase, in Atkinson Hyperlegible Mono at weight 500, converted to
 * outlines: a lockup used as an image or a favicon can't load a font, so live
 * text would fall back to whatever monospace the machine has.
 *
 *   node packages/brand/scripts/lockups.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const fontFile = join(dirname(require.resolve("@fontsource/atkinson-hyperlegible-mono/package.json")), "files", "atkinson-hyperlegible-mono-latin-500-normal.woff");
const buffer = readFileSync(fontFile);
const font = opentype.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));

// The mark is the 48px tile; the word sits 14px to its right, its x-height
// centred on the tile.
const SIZE = 34;
const TRACKING = -1;
const X = 62;
let x = X;
const parts = [];
for (const ch of "weft") {
  const glyph = font.charToGlyph(ch);
  parts.push(glyph.getPath(x, 0, SIZE));
  x += (glyph.advanceWidth / font.unitsPerEm) * SIZE + TRACKING;
}
// Baseline: centre the x-height (the height of "w" and "e") on the tile's centre, y = 24.
const xHeight = (font.tables.os2.sxHeight / font.unitsPerEm) * SIZE;
const baseline = Math.round((24 + xHeight / 2) * 10) / 10;
const d = parts.map((p) => p.toPathData(2)).join("");
const width = Math.ceil(x - TRACKING + 2);

const mark = readFileSync(join(root, "logo", "mark.svg"), "utf8")
  .replace(/^<svg[^>]*>\n?/, "")
  .replace(/<\/svg>\s*$/, "")
  .trim();

for (const [name, ink] of [["lockup-dark", "#E8ECEF"], ["lockup-light", "#0B1218"]]) {
  writeFileSync(
    join(root, "logo", `${name}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="48" viewBox="0 0 ${width} 48" role="img" aria-label="Weft">\n` +
      `  ${mark.replace(/\n/g, "\n  ")}\n` +
      `  <path transform="translate(0 ${baseline})" fill="${ink}" d="${d}"/>\n</svg>\n`,
  );
}
console.log(`Wrote lockups, ${width}px wide, baseline ${baseline}`);

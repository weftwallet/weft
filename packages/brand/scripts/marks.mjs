#!/usr/bin/env node
/**
 * Draws each product's mark into logo/products/. Weft, the wallet and the docs
 * use the main mark (logo/mark.svg, logo/mark-small.svg); the others are
 * drawn here in the same language, so they can't drift from it.
 *
 *   node packages/brand/scripts/marks.mjs
 *
 * Construction (see SYSTEM.md, "Marks"):
 *   - Two colours only: thread #3FC1B0 and ink #0B1218.
 *   - Two grounds. A teal tile with ink threads for products people pass
 *     something through (Weft, the wallet, docs, playground). An ink tile in a
 *     teal frame, with teal threads, for tools an organisation runs for itself
 *     (network, explorer). The frame is the loom.
 *   - Full drawings are on a 48px tile: plain tile 44px with radius 12 at
 *     (2, 2); framed tile 42px with radius 11 and a 2px frame at (3, 3).
 *   - Warps are 3 wide, wefts 6 wide, both with round ends.
 *   - Every crossing shows which thread is on top. A weft is drawn over a
 *     10-wide stroke of the ground, which cuts the warps it passes over; where
 *     the warp passes over instead, the warp is drawn back on top over a
 *     7-wide stroke of the ground.
 *   - Small drawings are for 32px and below, on the 16px pixel grid: threads
 *     2px, 1px gaps at crossings, the frame 1px. Every edge lands on a whole
 *     pixel. A small drawing may simplify the full one (fewer threads), never
 *     contradict it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "logo", "products");
const THREAD = "#3FC1B0";
const INK = "#0B1218";

/** Grounds: [tile colour, thread colour, framed]. */
const TEAL = [THREAD, INK, false];
const FRAMED = [INK, THREAD, true];
/** Weft Experimental's ground: the teal tile with its bottom edge pinked. */
const PINKED = [THREAD, INK, "pinked"];

/* Full drawings ----------------------------------------------------------- */

const full = ([g, t]) => ({
  warp: (x, y1 = 8, y2 = 40) => `<path d="M${x} ${y1}V${y2}" stroke="${t}" stroke-width="3" stroke-linecap="round"/>`,
  /** A weft, over every warp it crosses. */
  weft: (y, x1, x2) =>
    `<path d="M${x1} ${y}H${x2}" stroke="${g}" stroke-width="10" stroke-linecap="round"/>` +
    `<path d="M${x1} ${y}H${x2}" stroke="${t}" stroke-width="6" stroke-linecap="round"/>`,
  /** The warp at x passes over the weft at y. */
  warpOver: (x, y) =>
    `<path d="M${x} ${y - 5}V${y + 5}" stroke="${g}" stroke-width="7"/>` + `<path d="M${x} ${y - 5}V${y + 5}" stroke="${t}" stroke-width="3"/>`,
});

/** The pinked edge: ten teeth across the 44px bottom edge, 4px deep. */
const pinked48 = (g) => {
  const teeth = Array.from({ length: 20 }, (_, i) => `L${+(46 - 2.2 * (i + 1)).toFixed(1)} ${i % 2 ? 42 : 46}`).join("");
  return `<path d="M2 14a12 12 0 0 1 12-12H34a12 12 0 0 1 12 12V42${teeth}Z" fill="${g}"/>`;
};

const tile48 = ([g, t, framed]) =>
  framed === "pinked"
    ? pinked48(g)
    : framed
    ? `<rect x="3" y="3" width="42" height="42" rx="11" fill="${g}" stroke="${t}" stroke-width="2"/>`
    : `<rect x="2" y="2" width="44" height="44" rx="12" fill="${g}"/>`;

const teal = full(TEAL);
const framed = full(FRAMED);

const drawings = {
  // The cloth still on the loom: two picks through, the third halfway across
  // and stopped before the second warp, so the bottom of the warp is bare.
  playground: {
    ground: TEAL,
    full:
      teal.warp(17) + teal.warp(31) +
      teal.weft(14, 10, 38) + teal.warpOver(31, 14) +
      teal.weft(24, 10, 38) + teal.warpOver(17, 24) +
      teal.weft(34, 10, 24),
  },
  // Weft Experimental: the main mark's cloth cut as a swatch, with a pinked
  // edge, the way a fabric sample is cut to try before the whole bolt. The
  // warps stop above the teeth.
  experimental: {
    ground: PINKED,
    full:
      teal.warp(17, 8, 38) + teal.warp(31, 8, 38) +
      teal.weft(14, 10, 38) + teal.warpOver(31, 14) +
      teal.weft(24, 10, 38) + teal.warpOver(17, 24) +
      teal.weft(34, 10, 38) + teal.warpOver(31, 34),
  },
  // The warp alone, strung in the loom: nothing has passed through it yet.
  network: {
    ground: FRAMED,
    full: [12, 20, 28, 36].map((x) => framed.warp(x)).join(""),
  },
  // The finished cloth, the record: a 3 by 3 plain weave, every crossing
  // alternating. Denser than the main mark's 3 by 2, so it is never the main
  // mark inverted (that is logo/mark-inverted.svg, Weft on a light ground).
  explorer: {
    ground: FRAMED,
    full:
      [14, 24, 34].map((x) => framed.warp(x, 9, 39)).join("") +
      [14, 24, 34]
        .map((y, k) => framed.weft(y, 8, 40) + [14, 24, 34].filter((_, j) => (j + k) % 2 === 1).map((x) => framed.warpOver(x, y)).join(""))
        .join(""),
  },
};

/* Small drawings, on whole pixels ----------------------------------------- */

const rect = (x, y, w, h, fill) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;
const px = ([g, t]) => ({
  warp: (x, y = 2, h = 12) => rect(x, y, 2, h, t),
  weft: (y, x = 2, w = 12) => rect(x, y, w, 2, t),
  /** The warp at x passes over the weft at y: the weft is cut either side. */
  warpOver: (x, y) => rect(x - 1, y - 1, 4, 4, g) + rect(x, y - 1, 2, 4, t),
  /** The weft at y passes over the warp at x: the warp is cut either side. */
  weftOver: (x, y) => rect(x - 1, y - 1, 4, 4, g) + rect(x - 1, y, 4, 2, t),
});
const tile16 = ([g, t, isFramed]) =>
  isFramed === "pinked"
    ? `<path d="M0 4Q0 0 4 0H12Q16 0 16 4V16H14V14H12V16H10V14H8V16H6V14H4V16H2V14H0Z" fill="${g}" shape-rendering="crispEdges"/>`
    : isFramed ? `<rect width="16" height="16" rx="4" fill="${t}"/><rect x="1" y="1" width="14" height="14" rx="3" fill="${g}"/>` : `<rect width="16" height="16" rx="4" fill="${g}"/>`;

const pTeal = px(TEAL);
const pFramed = px(FRAMED);

// Playground: two warps and one pick through, bare warp below. The half pick
// of the full drawing is noise at this size.
drawings.playground.small = pTeal.warp(4) + pTeal.warp(10) + pTeal.weft(4) + pTeal.weftOver(4, 4) + pTeal.warpOver(10, 4);
// Network: three warps. Four don't fit 2px threads with gaps on 16px.
drawings.network.small = pFramed.warp(3) + pFramed.warp(7) + pFramed.warp(11);
// Explorer: the 3 by 3 weave, every crossing alternating.
drawings.explorer.small =
  pFramed.warp(3) + pFramed.warp(7) + pFramed.warp(11) +
  [3, 7, 11].map((y, k) => pFramed.weft(y) + [3, 7, 11].map((x, j) => ((j + k) % 2 ? pFramed.warpOver(x, y) : pFramed.weftOver(x, y))).join("")).join("");

// Experimental: the main mark's 2 by 2 weave, warps a pixel shorter to clear
// the teeth on the bottom two rows.
drawings.experimental.small =
  pTeal.warp(4, 2, 11) + pTeal.warp(10, 2, 11) + pTeal.weft(4) + pTeal.weft(10) +
  pTeal.weftOver(4, 4) + pTeal.warpOver(10, 4) + pTeal.warpOver(4, 10) + pTeal.weftOver(10, 10);

const names = { experimental: "Weft Experimental", playground: "Weft Playground", network: "Weft Network", explorer: "Weft Explorer" };

mkdirSync(out, { recursive: true });
for (const [id, d] of Object.entries(drawings)) {
  writeFileSync(
    join(out, `${id}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48" role="img" aria-label="${names[id]}">\n` +
      `  ${tile48(d.ground)}\n  <g fill="none">${d.full}</g>\n</svg>\n`,
  );
  writeFileSync(
    join(out, `${id}-small.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" role="img" aria-label="${names[id]}">\n` +
      `  ${tile16(d.ground)}\n  <g shape-rendering="crispEdges">${d.small}</g>\n</svg>\n`,
  );
}
console.log(`Wrote ${Object.keys(drawings).length * 2} marks to logo/products/`);

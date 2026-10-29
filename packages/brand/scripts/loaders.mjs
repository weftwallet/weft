#!/usr/bin/env node
/**
 * Draws each product's loader into logo/loaders/: the product's own mark with
 * one pick pulled through its warps, seated, then drawn out the other side,
 * again and again. It replaces the generic spinner across the products (see
 * SYSTEM.md, "Loading"). Like a spinner, it keeps turning with reduced motion.
 *
 *   node packages/brand/scripts/loaders.mjs
 *
 * Each product passes its own thing through:
 *   - weft (also the wallet and the docs): the middle of its three picks.
 *   - playground: its unfinished last pick, which comes to rest halfway, as
 *     in its mark.
 *   - network: a pick through its bare warps that never stays.
 *   - explorer: the middle row of its plain weave.
 *
 * The moving pick is a dash travelling along its row, so it's bounded by the
 * row without a clip path and needs no script. The warps it passes under are
 * drawn back on top over their own gap, as in the marks; where no pick is
 * passing, that gap is the tile's own colour, so it can't be seen.
 *
 * The files carry their own CSS, with class and animation names unique to
 * each product, so several can sit inline on one page.
 *
 * Each also has a small drawing, <id>-small.svg, for 24px and below. Like
 * the small marks it's on the 16px pixel grid, and its pick moves a whole
 * pixel at a time, so every edge stays on a pixel at 16px.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "logo", "loaders");
const THREAD = "#3FC1B0";
const INK = "#0B1218";
const PERIOD = 1600; // ms, one pick in, held, and out
const TENSION = "cubic-bezier(0.3, 0.7, 0.2, 1)"; // ease-tension
const IN_OUT = "cubic-bezier(0.65, 0, 0.35, 1)"; // ease-in-out

const FILLED = { tile: `<rect x="2" y="2" width="44" height="44" rx="12" fill="${THREAD}"/>`, ground: THREAD, thread: INK };
const FRAMED = { tile: `<rect x="3" y="3" width="42" height="42" rx="11" fill="${INK}" stroke="${THREAD}" stroke-width="2"/>`, ground: INK, thread: THREAD };

const LOADERS = {
  weft: {
    name: "Weft",
    ...FILLED,
    warps: [17, 31],
    span: [8, 40],
    picks: [
      { y: 14, from: 10, to: 38, under: [31] },
      { y: 24, from: 10, to: 38, under: [17], moves: true },
      { y: 34, from: 10, to: 38, under: [31] },
    ],
  },
  playground: {
    name: "Weft Playground",
    ...FILLED,
    warps: [17, 31],
    span: [8, 40],
    picks: [
      { y: 14, from: 10, to: 38, under: [31] },
      { y: 24, from: 10, to: 38, under: [17] },
      { y: 34, from: 10, to: 38, under: [31], moves: true, rest: 14 },
    ],
  },
  network: {
    name: "Weft Network",
    ...FRAMED,
    warps: [12, 20, 28, 36],
    span: [8, 40],
    picks: [{ y: 24, from: 8, to: 40, under: [20, 36], moves: true, leaves: true }],
  },
  explorer: {
    name: "Weft Explorer",
    ...FRAMED,
    warps: [14, 24, 34],
    span: [9, 39],
    picks: [
      { y: 14, from: 8, to: 40, under: [24] },
      { y: 24, from: 8, to: 40, under: [14, 34], moves: true },
      { y: 34, from: 8, to: 40, under: [24] },
    ],
  },
};

const path = (d, stroke, width, extra = "") => `<path d="${d}" stroke="${stroke}" stroke-width="${width}"${extra}/>`;

function draw(id, L) {
  const cls = `weft-loader-${id}`;
  const row = (p) => `M${p.from} ${p.y}H${p.to}`;
  // A pick over a stroke of the ground, which cuts the warps it passes over.
  const pick = (p, extra = "") => path(row(p), L.ground, 10, ` stroke-linecap="round"${extra}`) + path(row(p), L.thread, 6, ` stroke-linecap="round"${extra}`);
  // The warps a pick passes under, back on top over their own gap.
  const unders = (p) => p.under.map((x) => path(`M${x} ${p.y - 5}V${p.y + 5}`, L.ground, 7) + path(`M${x} ${p.y - 5}V${p.y + 5}`, L.thread, 3)).join("");

  const moving = L.picks.find((p) => p.moves);
  const length = moving.to - moving.from;
  const dash = moving.rest ?? length;
  const start = dash + 1, gone = -(length + 1);
  const keyframes = moving.leaves
    ? `0%{stroke-dashoffset:${start};animation-timing-function:${TENSION}}42%{stroke-dashoffset:0;animation-timing-function:${IN_OUT}}76%,100%{stroke-dashoffset:${gone}}`
    : `0%{stroke-dashoffset:${start};animation-timing-function:${TENSION}}42%{stroke-dashoffset:0}62%{stroke-dashoffset:0;animation-timing-function:${IN_OUT}}96%,100%{stroke-dashoffset:${gone}}`;

  const body = [
    L.tile,
    `<g fill="none">`,
    ...L.warps.map((x) => path(`M${x} ${L.span[0]}V${L.span[1]}`, L.thread, 3, ` stroke-linecap="round"`)),
    ...L.picks.filter((p) => !p.moves).map((p) => pick(p) + unders(p)),
    pick(moving, ` class="${cls}"`) + unders(moving),
    `</g>`,
  ].join("\n  ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
  <!-- ${L.name}'s loader: its mark, with one pick pulled through, seated and drawn out, every ${PERIOD}ms. Generated by scripts/loaders.mjs. -->
  <style>.${cls}{stroke-dasharray:${dash} 200;stroke-dashoffset:${start};animation:${cls} ${PERIOD}ms infinite}@keyframes ${cls}{${keyframes}}</style>
  ${body}
</svg>
`;
}

/* Small drawings, on the 16px grid ---------------------------------------- */

const r = (x, y, w, h, fill) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;
const SMALL_FILLED = { tile: `<rect width="16" height="16" rx="4" fill="${THREAD}"/>`, ground: THREAD, thread: INK };
const SMALL_FRAMED = { tile: `<rect width="16" height="16" rx="4" fill="${THREAD}"/><rect x="1" y="1" width="14" height="14" rx="3" fill="${INK}"/>`, ground: INK, thread: THREAD };

// Each: the warps (x of each 2px warp), the still picks (2px rows, from the
// small marks), and the moving pick's row, length and the warps it passes under.
const SMALL = {
  weft: { ...SMALL_FILLED, warps: [4, 10], still: [{ y: 4, under: [10] }], moving: { y: 10, length: 12, under: [4] } },
  playground: { ...SMALL_FILLED, warps: [4, 10], still: [{ y: 4, under: [10] }], moving: { y: 10, length: 6, under: [4] } },
  network: { ...SMALL_FRAMED, warps: [3, 7, 11], still: [], moving: { y: 7, length: 12, under: [7], leaves: true } },
  explorer: { ...SMALL_FRAMED, warps: [3, 7, 11], still: [{ y: 3, under: [7] }, { y: 11, under: [7] }], moving: { y: 7, length: 12, under: [3, 11] } },
};

function drawSmall(id, S) {
  const cls = `weft-loader-${id}-small`;
  const lane = [2, 14]; // the picks run from x 2 to 14
  // A pick passes under a warp: the warp, back on top over a 1px gap.
  const under = (x, y) => r(x - 1, y - 1, 4, 4, S.ground) + r(x, y - 1, 2, 4, S.thread);
  // A still pick: its row over a 1px gap of the ground, then the warps it passes under.
  const still = (p) => r(lane[0], p.y - 1, lane[1] - lane[0], 4, S.ground) + r(lane[0], p.y, lane[1] - lane[0], 2, S.thread) + p.under.map((x) => under(x, p.y)).join("");
  const m = S.moving;
  const span = lane[1] - lane[0];
  const enter = m.length + 1, leave = span + 1;
  const step = (n) => `steps(${n}, end)`;
  const keyframes = m.leaves
    ? `0%{transform:translateX(-${enter}px);animation-timing-function:${step(enter)}}42%{transform:translateX(0);animation-timing-function:${step(leave)}}76%,100%{transform:translateX(${leave}px)}`
    : `0%{transform:translateX(-${enter}px);animation-timing-function:${step(enter)}}42%{transform:translateX(0)}62%{transform:translateX(0);animation-timing-function:${step(leave)}}96%,100%{transform:translateX(${leave}px)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  <!-- ${LOADERS[id].name}'s small loader, on the 16px grid: its pick moves a pixel at a time. Generated by scripts/loaders.mjs. -->
  <style>.${cls}{animation:${cls} ${PERIOD}ms infinite}@keyframes ${cls}{${keyframes}}</style>
  ${S.tile}
  <g shape-rendering="crispEdges">
  ${S.warps.map((x) => r(x, 2, 2, 12, S.thread)).join("")}
  ${S.still.map(still).join("\n  ")}
  <svg x="${lane[0]}" y="0" width="${span}" height="16" viewBox="${lane[0]} 0 ${span} 16"><g class="${cls}">${r(lane[0], m.y - 1, m.length, 4, S.ground)}${r(lane[0], m.y, m.length, 2, S.thread)}</g></svg>
  ${m.under.map((x) => under(x, m.y)).join("")}
  </g>
</svg>
`;
}

mkdirSync(out, { recursive: true });
for (const [id, L] of Object.entries(LOADERS)) {
  writeFileSync(join(out, `${id}.svg`), draw(id, L));
  writeFileSync(join(out, `${id}-small.svg`), drawSmall(id, SMALL[id]));
  console.log(`logo/loaders/${id}.svg, logo/loaders/${id}-small.svg`);
}

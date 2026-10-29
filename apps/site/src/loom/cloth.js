// Transactions become cloth.
// A loom is strung: two warps for each organisation, named above.
// Transaction calls appear in mono beside it (above their row on a narrow
// screen), unknot, and are pulled through as picks, over and under while
// they travel, row on row from the bottom, into a ledger. After six rows it
// rests.
import * as L from "./engine.js";
const { TEAL, WHITE, mix, rgb, phase, ease } = L;

const ORGS = ["Org1MSP", "Org2MSP", "Org3MSP"];
export const T = {
  warps: [200, 520],
  labels: [520, 400],
  first: 1000,
  every: 1150,
  rows: 6,
  textIn: 360,
  pull: { unknot: 420, unknotSpread: 380, pullAt: 520, pullSpread: 420, pull: 620, lift: 0 },
};
T.total = T.first + T.every * (T.rows - 1) + 2400;

export function create(canvas, glyphs, { frozen, autoplay } = {}) {
  const txs = glyphs.txs;
  let c = null;
  // The page's colours, from the theme; recolor() reads them again.
  let P = L.palette(canvas);

  function layout(w, h) {
    if (c && c.w === w && c.h === h) return c;
    const narrow = w < 560;
    const longest = Math.max(...txs.map((tx) => tx.width));
    // Wide: calls are written to the left of the loom. Narrow: above their row.
    const x0 = narrow ? w * 0.06 : w * 0.5, x1 = w - w * 0.04;
    const size = narrow ? Math.min(15, (x1 - x0) / longest) : Math.min(17, (x0 - 20) / longest);
    const warpGap = (x1 - x0) / (ORGS.length * 2 + 1);
    const warps = Array.from({ length: ORGS.length * 2 }, (_, i) => x0 + warpGap * (i + 1));
    const pickW = Math.max(8, Math.min(16, h * 0.034));
    const rowGap = pickW * 2.1;
    // The loom is a little taller than the cloth it will hold, centred.
    const loomH = rowGap * (T.rows + 2.5);
    const top = h / 2 - loomH / 2 + 10, bottom = h / 2 + loomH / 2 + 10;
    const rows = Array.from({ length: T.rows }, (_, r) => {
      const y = bottom - pickW - r * rowGap;
      const tx = txs[r % txs.length];
      const base = narrow ? y - pickW * 1.1 : y + (tx.xHeight * size) / 2;
      const sx = narrow ? x0 : x0 - 14 - tx.width * size;
      const contours = tx.glyphs.flatMap((g) => L.place(g, sx, base, size));
      return { y, tx, base, sx, contours, thread: L.thread(contours, [x1, y], [x0, y], { midY: narrow ? base - (tx.xHeight * size) / 2 : y }) };
    });
    c = { w, h, x0, x1, warps, top, bottom, pickW, rowGap, size, rows };
    return c;
  }

  const line = (ctx, ax, ay, bx, by, width, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  };

  function draw(ctx, t, w, h) {
    layout(w, h);
    ctx.fillStyle = rgb(P.ground);
    ctx.fillRect(0, 0, w, h);
    const warpW = c.pickW * 0.55;
    // The warp, a quieter teal than the picks: the network, held fixed.
    const WARP = mix(P.ground, TEAL, 0.62);

    // The shed: as each row is pulled through, the warps it passes under
    // lift, thicker and with a shadow, then close down on it.
    const pullWindow = (r) => [T.first + r * T.every + 200 + T.pull.pullAt, T.pull.pullSpread + T.pull.pull];
    const shed = c.warps.map((_, j) => Math.max(0, ...c.rows.map((_, r) => ((j + r) % 2 === 0 ? 0 : L.bell(t, ...pullWindow(r))))));
    const wOf = (j) => warpW * (1 + 0.45 * shed[j]);

    // The warp: two threads for each organisation, strung top to bottom.
    ctx.lineCap = "round";
    c.warps.forEach((x, i) => {
      const k = ease.out(phase(t, T.warps[0] + i * 50, T.warps[1]));
      if (k <= 0) return;
      const yEnd = c.top + (c.bottom - c.top) * k;
      if (shed[i] > 0.01) line(ctx, x + 3 * shed[i], c.top + 3 * shed[i], x + 3 * shed[i], yEnd + 3 * shed[i], wOf(i), rgb([0, 0, 0], P.shadow * 1.1 * shed[i]));
      line(ctx, x, c.top, x, yEnd, wOf(i), rgb(WARP));
    });
    // Each organisation's name above its pair.
    const lk = ease.out(phase(t, ...T.labels));
    if (lk > 0) {
      ctx.save();
      ctx.globalAlpha = lk;
      ctx.fillStyle = rgb(P.subtle);
      ctx.font = `500 ${Math.round(c.size * 0.85)}px "Atkinson Hyperlegible Mono", ui-monospace, monospace`;
      ctx.textAlign = "center";
      ORGS.forEach((name, i) => ctx.fillText(name, (c.warps[i * 2] + c.warps[i * 2 + 1]) / 2, c.top - 14 + (1 - lk) * 4));
      ctx.restore();
    }

    c.rows.forEach((row, r) => {
      const start = T.first + r * T.every;
      if (t < start - T.textIn) return;
      // The call appears beside the loom, then turns to thread.
      const shown = ease.out(phase(t, start - T.textIn, T.textIn));
      const pullStart = start + 200;
      if (t < pullStart) {
        ctx.save();
        ctx.globalAlpha = shown;
        ctx.translate((1 - shown) * -8, 0);
        ctx.fillStyle = rgb(mix(P.text, TEAL, ease.out(phase(t, start - 120, 300))));
        ctx.fill(L.pathOf(row.contours));
        ctx.restore();
        return;
      }
      const st = L.threadState(row.thread, t, pullStart, { ...T.pull, lift: c.pickW * 0.8 });
      const w0 = c.size * 0.09;
      const lift = 1 - st.done;
      if (lift > 0.01) {
        ctx.save();
        ctx.translate(0, 3 * lift);
        L.strokeSmooth(ctx, st.pts, w0, c.pickW, rgb([0, 0, 0], P.shadow * 1.1 * lift));
        ctx.restore();
      }
      L.strokeVarying(ctx, st.pts, w0 * 1.6, c.pickW * 1.6, rgb(P.ground));
      L.strokeVarying(ctx, st.pts, w0, c.pickW, rgb(TEAL));
      ctx.save();
      ctx.translate(0, -c.pickW * 0.18);
      L.strokeSmooth(ctx, st.pts, w0 * 0.3, c.pickW * 0.2, rgb(mix(TEAL, WHITE, 0.55), 0.35));
      ctx.restore();
      // Plain weave, as it travels: wherever this row is passing a warp it
      // goes under, the warp is drawn over it there, with its gap.
      c.warps.forEach((x, j) => {
        if ((j + r) % 2 === 0) return;
        const cr = L.crossing(st.pts, x, wOf(j) / 2 + c.pickW * 0.4);
        if (!cr) return;
        const pad = w0 * 0.6 + (c.pickW * 0.85 - w0 * 0.6) * cr.k;
        ctx.lineCap = "butt";
        line(ctx, x, cr.y0 - pad, x, cr.y1 + pad, wOf(j) + c.pickW * 0.55, rgb(P.ground));
        line(ctx, x, cr.y0 - pad - 1, x, cr.y1 + pad + 1, wOf(j), rgb(WARP));
        ctx.lineCap = "round";
      });
    });
  }

  const api = L.run(canvas, draw, { total: T.total, frozen, autoplay });
  api.recolor = () => {
    P = L.palette(canvas);
    api.redraw();
  };
  return api;
}

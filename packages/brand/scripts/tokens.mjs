#!/usr/bin/env node
/**
 * The source of Weft's design tokens. Writes tokens.css and tokens.json:
 *
 *   node packages/brand/scripts/tokens.mjs
 *
 * Three layers:
 *   - Primitives: the brand's named colours (--weft-ink, --weft-thread, ...),
 *     fixed in both themes.
 *   - Roles: what a colour is for (--weft-bg, --weft-text, --weft-accent-text,
 *     ...). These change with the theme. New work uses roles. --weft-text,
 *     --weft-text-muted, --weft-text-subtle, --weft-line and --weft-line-strong
 *     were primitives before; their dark values are unchanged.
 *   - Scales: type, space, radius, elevation, motion and states.
 *
 * Light-theme text colours are chosen for at least 4.5:1 contrast on linen.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const primitives = {
  ink: "#0B1218",
  slate: "#17212B",
  surface: "#111A23",
  thread: "#3FC1B0",
  "thread-soft": "#102826",
  amber: "#E8A33D",
  "amber-soft": "#2A2214",
  signal: "#E5675B",
  "signal-soft": "#2A1817",
  linen: "#F5F3EE",
};

/** Roles, dark then light. */
const roles = {
  // Grounds, from furthest back to nearest.
  "bg-sunken": ["#080D12", "#ECE8DF"],
  bg: ["#0B1218", "#F5F3EE"],
  "bg-surface": ["#111A23", "#FBFAF7"],
  // In light, cards are a step below white so dialogs, which are white, stand
  // apart from them by their ground as well as their shadow.
  "bg-raised": ["#17212B", "#FDFCFA"],
  "bg-overlay": ["#1C2733", "#FFFFFF"],
  // Lines.
  line: ["#22303D", "#E2DED4"],
  "line-strong": ["#2C3A48", "#C9C4B8"],
  // Text.
  "text-strong": ["#F4F6F8", "#05090C"],
  text: ["#E8ECEF", "#0B1218"],
  "text-muted": ["#A9B5C1", "#3D4A56"],
  "text-subtle": ["#94A3B3", "#5B6876"],
  // Thread: the only accent. Fills take ink text in both themes.
  accent: ["#3FC1B0", "#3FC1B0"],
  "accent-hover": ["#5CCDBE", "#35AE9F"],
  "accent-text": ["#3FC1B0", "#1A7468"],
  "accent-soft": ["#102826", "#DCF1EC"],
  "accent-line": ["#1F5C55", "#9FD9CF"],
  "on-accent": ["#0B1218", "#0B1218"],
  // Keyboard focus. Needs 3:1 against every ground; thread on linen is about 2:1.
  focus: ["#3FC1B0", "#1A7468"],
  // Status only: never decoration.
  warn: ["#E8A33D", "#E8A33D"],
  "warn-text": ["#E8A33D", "#8A5A10"],
  "warn-soft": ["#2A2214", "#F8EEDB"],
  "warn-line": ["#5C4420", "#E6C58E"],
  danger: ["#E5675B", "#E5675B"],
  "danger-text": ["#E5675B", "#B2392E"],
  "danger-soft": ["#2A1817", "#F9E4E1"],
  "danger-line": ["#5A2B27", "#E9B3AC"],
  "on-status": ["#0B1218", "#0B1218"],
  // Scrims behind sheets and dialogs.
  scrim: ["rgb(5 9 12 / 0.66)", "rgb(11 18 24 / 0.32)"],
};

const font = {
  // Atkinson Hyperlegible, from the Braille Institute: every character that
  // could be mistaken for another (0 O, 1 l I, 5 S, 8 B) differs in shape.
  // Weft's job is showing exactly what you sign, so the type does the same.
  sans: '"Atkinson Hyperlegible Next", system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"Atkinson Hyperlegible Mono", ui-monospace, "SFMono-Regular", Menlo, monospace',
};

/**
 * [size, line height]. md is the interface base, base is for reading. Below
 * md there is only xs: sizes 1px apart blur into each other.
 */
const type = {
  xs: ["12px", "16px"],
  md: ["14px", "20px"],
  base: ["16px", "26px"],
  lg: ["18px", "28px"],
  xl: ["22px", "30px"],
  "2xl": ["28px", "36px"],
  "3xl": ["36px", "44px"],
  display: ["clamp(40px, 6vw, 72px)", "1.05"],
};

const space = { 0: "0", 1: "4px", 2: "8px", 3: "12px", 4: "16px", 5: "20px", 6: "24px", 8: "32px", 10: "40px", 12: "48px", 16: "64px", 24: "96px", 32: "128px" };
const radius = { sm: "6px", lg: "12px", xl: "16px", "2xl": "24px", pill: "999px" };

/** Dark then light. Dark grounds lean on borders, so shadows only separate layers. */
const shadow = {
  1: ["0 1px 2px rgb(0 0 0 / 0.32)", "0 1px 2px rgb(11 18 24 / 0.08)"],
  2: ["0 8px 24px rgb(0 0 0 / 0.36)", "0 8px 24px rgb(11 18 24 / 0.10)"],
  3: ["0 24px 64px rgb(0 0 0 / 0.48)", "0 24px 64px rgb(11 18 24 / 0.16)"],
};

/**
 * Motion. Thread under tension: things arrive quickly and settle, with no
 * bounce or overshoot. Exits are shorter than entrances and ease in.
 */
const motion = {
  duration: {
    instant: "90ms", // press feedback
    fast: "140ms", // hover, colour, small state changes
    base: "220ms", // panels, screens, menus arriving
    slow: "360ms", // sheets, dialogs, layout that moves far
    deliberate: "600ms", // drawn lines, progress, the weave
  },
  ease: {
    out: "cubic-bezier(0.2, 0.8, 0.2, 1)", // arriving
    in: "cubic-bezier(0.4, 0, 1, 1)", // leaving
    "in-out": "cubic-bezier(0.65, 0, 0.35, 1)", // moving between two places
    tension: "cubic-bezier(0.3, 0.7, 0.2, 1)", // a thread pulled taut: the weave
  },
  // How far things travel. Zero with reduced motion, so movement becomes a fade.
  shift: { sm: "4px", md: "8px", lg: "16px" },
  stagger: "60ms",
};

const state = {
  "focus-ring": "2px",
  "focus-offset": "2px",
  "press-scale": "0.98",
  "disabled-opacity": "0.5",
};

/* Contrast: every text role on every ground, and focus, in both themes. */
const luminance = (hex) => {
  const [r, g, b] = hex.match(/[0-9a-f]{2}/gi).map((x) => parseInt(x, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const grounds = ["bg-sunken", "bg", "bg-surface", "bg-raised", "bg-overlay"];
const needs = { "text-strong": 4.5, text: 4.5, "text-muted": 4.5, "text-subtle": 4.5, "accent-text": 4.5, "warn-text": 4.5, "danger-text": 4.5, focus: 3 };
const failures = [];
for (const [i, theme] of ["dark", "light"].entries()) {
  for (const [role, min] of Object.entries(needs)) {
    for (const ground of grounds) {
      const ratio = contrast(roles[role][i], roles[ground][i]);
      if (ratio < min) failures.push(`${theme}: ${role} on ${ground} is ${ratio.toFixed(2)}:1, needs ${min}:1`);
    }
  }
  // Text on fills.
  for (const [fill, on] of [["accent", "on-accent"], ["warn", "on-status"], ["danger", "on-status"]]) {
    const ratio = contrast(roles[on][i], roles[fill][i]);
    if (ratio < 4.5) failures.push(`${theme}: ${on} on ${fill} is ${ratio.toFixed(2)}:1, needs 4.5:1`);
  }
}
if (failures.length) {
  console.error(`Contrast too low, nothing written:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ */

const lines = [];
const decl = (name, value) => `  --weft-${name}: ${value};`;
const roleBlock = (i) => Object.entries(roles).map(([k, v]) => decl(k, v[i])).concat(Object.entries(shadow).map(([k, v]) => decl(`shadow-${k}`, v[i])));

lines.push(
  "/* Weft design tokens. Generated by scripts/tokens.mjs: edit that, then run",
  "   `node packages/brand/scripts/tokens.mjs`. See SYSTEM.md for how to use them. */",
  "",
  ":root {",
  "  /* Primitives: fixed in both themes. */",
  ...Object.entries(primitives).map(([k, v]) => decl(k, v.toLowerCase())),
  "",
  "  /* Type */",
  decl("font-sans", font.sans),
  decl("font-mono", font.mono),
  ...Object.entries(type).flatMap(([k, [size, lh]]) => [decl(`type-${k}`, size), decl(`leading-${k}`, lh)]),
  "",
  "  /* Space and shape */",
  ...Object.entries(space).map(([k, v]) => decl(`space-${k}`, v)),
  ...Object.entries(radius).map(([k, v]) => decl(`radius-${k}`, v)),
  "",
  "  /* Motion */",
  ...Object.entries(motion.duration).map(([k, v]) => decl(`duration-${k}`, v)),
  ...Object.entries(motion.ease).map(([k, v]) => decl(`ease-${k}`, v)),
  ...Object.entries(motion.shift).map(([k, v]) => decl(`shift-${k}`, v)),
  decl("stagger", motion.stagger),
  "",
  "  /* States */",
  ...Object.entries(state).map(([k, v]) => decl(k, v)),
  "",
  "  /* Roles: dark unless the page or the system asks for light. */",
  ...roleBlock(0),
  "  color-scheme: dark;",
  "}",
  "",
  ':root[data-theme="light"] {',
  ...roleBlock(1),
  "  color-scheme: light;",
  "}",
  "",
  "@media (prefers-color-scheme: light) {",
  "  :root:not([data-theme]) {",
  ...roleBlock(1).map((l) => `  ${l}`),
  "    color-scheme: light;",
  "  }",
  "}",
  "",
  "@media (prefers-reduced-motion: reduce) {",
  "  :root {",
  ...Object.keys(motion.shift).map((k) => `  ${decl(`shift-${k}`, "0px")}`),
  `  ${decl("stagger", "0ms")}`,
  `  ${decl("press-scale", "1")}`,
  "  }",
  "}",
  "",
);
writeFileSync(join(root, "tokens.css"), lines.join("\n"));

const json = {
  color: Object.fromEntries(Object.entries(primitives).map(([k, v]) => [k.replace(/-(\w)/g, (_, c) => c.toUpperCase()), v])),
  role: {
    dark: Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, v[0]])),
    light: Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, v[1]])),
  },
  font,
  type: Object.fromEntries(Object.entries(type).map(([k, [size, leading]]) => [k, { size, leading }])),
  space,
  radius,
  shadow: { dark: Object.fromEntries(Object.entries(shadow).map(([k, v]) => [k, v[0]])), light: Object.fromEntries(Object.entries(shadow).map(([k, v]) => [k, v[1]])) },
  motion,
  state,
};
writeFileSync(join(root, "tokens.json"), `${JSON.stringify(json, null, 2)}\n`);
console.log("Wrote tokens.css and tokens.json");

// Renders the extension's toolbar icons from the brand SVGs: Weft's into
// apps/extension/public/icon/ and Weft Experimental's (docs/adr/0009) into
// apps/extension/public/icon-experimental/.
// Usage: pnpm dlx --package sharp node scripts/render-icons.mjs
//    or: pnpm add -D -w sharp && node scripts/render-icons.mjs
import { mkdirSync, readFileSync } from "node:fs";
import sharp from "sharp";

const logo = new URL("../packages/brand/logo/", import.meta.url);
const sets = [
  { big: "mark.svg", small: "mark-small.svg", out: "icon/" },
  { big: "products/experimental.svg", small: "products/experimental-small.svg", out: "icon-experimental/" },
];

for (const set of sets) {
  const out = new URL(`../apps/extension/public/${set.out}`, import.meta.url);
  mkdirSync(out, { recursive: true });
  const big = readFileSync(new URL(set.big, logo));
  const small = readFileSync(new URL(set.small, logo));
  for (const size of [16, 32, 48, 128]) {
    await sharp(size <= 32 ? small : big, { density: 600 })
      .resize(size, size)
      .png()
      .toFile(new URL(`${size}.png`, out).pathname);
  }
}
console.log("Rendered icons to apps/extension/public/icon and icon-experimental");

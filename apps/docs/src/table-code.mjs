// @ts-check
/**
 * A rehype plugin for the docs' tables: inline code in a table cell gets
 * break opportunities (<wbr>) at the points a reader would break it, after
 * `_`, `.`, `/`, `-`, `:`, `,`, `=`, `?`, `&` and before a capital that
 * follows a small letter (castBallot), and every 8 characters in a long run
 * of hex. On a phone a narrow column then wraps `ENDORSEMENT_POLICY_FAILURE`
 * as ENDORSEMENT_ POLICY_ FAILURE, never in the middle of a word
 * (theme.css). A table that still doesn't fit scrolls inside itself.
 */

const AFTER = /[_./\-:,=?&]/;
const HEX_RUN = /[0-9a-f]{17,}/gi;

/**
 * Splits one string of code into pieces between which a line may break.
 * @param {string} text
 * @returns {string[]}
 */
export function breakPoints(text) {
  const pieces = [];
  let piece = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    const prev = text[i - 1] ?? "";
    if (piece && /[A-Z]/.test(c) && /[a-z]/.test(prev)) {
      pieces.push(piece);
      piece = "";
    }
    piece += c;
    // Not after a leading sign (-32002, /api): a break needs a word before it.
    if (AFTER.test(c) && i < text.length - 1 && /[^_./\-:,=?&]/.test(piece)) {
      pieces.push(piece);
      piece = "";
    }
  }
  if (piece) pieces.push(piece);
  // A long run of hex has no word in it: break it into groups of 8.
  return pieces.flatMap((p) => (p.match(HEX_RUN)?.[0] === p ? (p.match(/.{1,8}/g) ?? [p]) : [p]));
}

/**
 * @param {any} node
 * @param {boolean} inCell
 */
function visit(node, inCell) {
  if (!node || !Array.isArray(node.children)) return;
  const cell = inCell || (node.type === "element" && (node.tagName === "td" || node.tagName === "th"));
  if (cell && node.type === "element" && node.tagName === "code") {
    node.children = node.children.flatMap((/** @type {any} */ child) => {
      if (child.type !== "text") return [child];
      const pieces = breakPoints(child.value);
      return pieces.flatMap((value, i) => (i === 0 ? [{ type: "text", value }] : [{ type: "element", tagName: "wbr", properties: {}, children: [] }, { type: "text", value }]));
    });
    return;
  }
  for (const child of node.children) visit(child, cell);
}

/** The plugin: `rehypePlugins: [tableCode]`. */
export default function tableCode() {
  return (/** @type {any} */ tree) => visit(tree, false);
}

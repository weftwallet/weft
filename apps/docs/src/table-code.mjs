// @ts-check
/**
 * A rehype plugin for the docs' tables: inline code in a table cell gets
 * break opportunities (<wbr>) at the points a reader would break it, after
 * `_`, `.`, `/`, `-`, `:`, `,`, `=`, `?`, `&` and before a capital that
 * follows a small letter (castBallot), and every 8 characters in a long run
 * of hex. On a phone a narrow column then wraps `ENDORSEMENT_POLICY_FAILURE`
 * as ENDORSEMENT_ POLICY_ FAILURE, never in the middle of a word
 * (theme.css).
 *
 * It also gives every body cell its column's heading as `data-label`, and
 * the table's parts their ARIA roles. Where a table has less than 40rem
 * (theme.css), each row stacks as a block: the first cell as its title, then
 * each other cell under its label, so no table scrolls sideways and no
 * markdown table needs changing by hand. The roles keep it a table to
 * assistive technology once its parts are no longer displayed as one.
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

/**
 * A node's text, as a reader sees it.
 * @param {any} node
 * @returns {string}
 */
function text(node) {
  if (node.type === "text") return node.value;
  return (node.children ?? []).map(text).join("");
}

/** @param {any} node */
const isElement = (node, /** @type {string} */ tag) => node?.type === "element" && node.tagName === tag;

/**
 * Labels the body cells of every table with their column's heading, and
 * gives the table's parts their roles.
 * @param {any} node
 */
export function labelCells(node) {
  if (!node || !Array.isArray(node.children)) return;
  if (!isElement(node, "table")) {
    for (const child of node.children) labelCells(child);
    return;
  }
  const rows = [];
  const collect = (/** @type {any} */ n) => {
    for (const child of n.children ?? []) {
      if (isElement(child, "tr")) rows.push(child);
      else if (child.type === "element" && ["thead", "tbody", "tfoot"].includes(child.tagName)) {
        child.properties = { ...child.properties, role: "rowgroup" };
        collect(child);
      }
    }
  };
  collect(node);
  node.properties = { ...node.properties, role: "table" };
  const head = rows.find((r) => r.children.some((/** @type {any} */ c) => isElement(c, "th")));
  const labels = head ? head.children.filter((/** @type {any} */ c) => c.type === "element").map((/** @type {any} */ c) => text(c).trim()) : [];
  for (const row of rows) {
    row.properties = { ...row.properties, role: "row" };
    let i = 0;
    for (const cell of row.children) {
      if (cell.type !== "element") continue;
      if (cell.tagName === "th") cell.properties = { ...cell.properties, role: row === head ? "columnheader" : "rowheader" };
      else if (cell.tagName === "td") cell.properties = { ...cell.properties, role: "cell", ...(labels[i] ? { dataLabel: labels[i] } : {}) };
      i++;
    }
  }
}

/** The plugin: `rehypePlugins: [tableCode]`. */
export default function tableCode() {
  return (/** @type {any} */ tree) => {
    visit(tree, false);
    labelCells(tree);
  };
}

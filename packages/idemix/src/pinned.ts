/**
 * The idemix module Weft runs, pinned by hash (docs/adr/0008). The module
 * isn't committed: scripts/build.mjs builds it from Go source into
 * dist/wasm and refuses one whose SHA-256 isn't this one, and the loaders
 * refuse to run one either. `node scripts/build.mjs --update` rewrites
 * these values; commit them with the change that caused them.
 */
export const PINNED = {
  /** SHA-256 of dist/wasm/weft-idemix.wasm, lowercase hex. */
  wasmSha256: "fc1d413f3c4fab8c0a3b9a24a47338c0b9c5584ab83e015f4ee932b61ece2032",
  /** SHA-256 of dist/wasm/wasm_exec.js, from the same Go toolchain. */
  wasmExecSha256: "0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14",
  /** The module's size in bytes, for progress and for the budget's record. */
  wasmBytes: 12_680_460,
  /** The Go toolchain, IBM idemix and IBM mathlib it is built with. */
  go: "go1.26.10",
  idemix: "v0.3.1",
  mathlib: "v0.3.2",
} as const;

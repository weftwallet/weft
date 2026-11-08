// src/table-code.mjs: where inline code in a table cell may wrap.
import assert from "node:assert/strict";
import { test } from "node:test";
import tableCode, { breakPoints } from "./table-code.mjs";

test("breaks after separators and between camelCase words, never inside a word", () => {
  assert.deepEqual(breakPoints("ENDORSEMENT_POLICY_FAILURE"), ["ENDORSEMENT_", "POLICY_", "FAILURE"]);
  assert.deepEqual(breakPoints("weft_castBallot"), ["weft_", "cast", "Ballot"]);
  assert.deepEqual(breakPoints("privatevote-chair-2027"), ["privatevote-", "chair-", "2027"]);
  assert.deepEqual(breakPoints("/api/v1/channels/:channel/private-elections?offset="), ["/api/", "v1/", "channels/", ":channel/", "private-", "elections?", "offset="]);
  assert.deepEqual(breakPoints("Org1MSP"), ["Org1MSP"]);
  assert.deepEqual(breakPoints("-32002"), ["-32002"]);
});

test("breaks a long run of hex into groups of 8", () => {
  assert.deepEqual(breakPoints("1bf8214f23b1a05152c126a7"), ["1bf8214f", "23b1a051", "52c126a7"]);
  assert.deepEqual(breakPoints("deadbeef"), ["deadbeef"]);
});

test("puts <wbr> between the pieces of code in table cells only", () => {
  const code = (value) => ({ type: "element", tagName: "code", children: [{ type: "text", value }] });
  const tree = {
    type: "root",
    children: [
      { type: "element", tagName: "p", children: [code("a_b")] },
      { type: "element", tagName: "table", children: [{ type: "element", tagName: "td", children: [code("a_b")] }] },
    ],
  };
  tableCode()(tree);
  assert.deepEqual(tree.children[0].children[0].children, [{ type: "text", value: "a_b" }]);
  assert.deepEqual(tree.children[1].children[0].children[0].children.map((n) => n.tagName ?? n.value), ["a_", "wbr", "b"]);
});

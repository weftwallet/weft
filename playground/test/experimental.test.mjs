// The playground's own logic that runs without Docker: which voters' CA
// proxies and containers the next `playground:up --experimental` stops.
// Run with `node --test playground/test/` (part of `pnpm test`).
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEMO_VOTERS, unlistedVoters, voterElections } from "../experimental.mjs";

const containerOf = (e) => `ca_voters_${e.id.replace(/-/g, "_")}`;
const chair = (id) => ({ id, voterOrg: { mspId: `M${id}`, ca: { name: `ca-${id}`, port: 1, operations: 2, proxy: 3 } } });

test("an election removed from ELECTIONS has its CA proxy and its CA container stopped", () => {
  const left = unlistedVoters(
    {
      pidFiles: ["ca-proxy.pid", "ca-proxy-chair-2027.pid", "ca-proxy-chair-2028.pid", "relay.pid", "ca-proxy-chair-2028.log"],
      containers: ["ca_voters_chair_2027", "ca_voters_chair_2028"],
    },
    containerOf,
    [chair("chair-2027")],
  );
  assert.deepEqual(left, { proxies: ["ca-proxy-chair-2028"], containers: ["ca_voters_chair_2028"] });
});

test("with every election still listed, nothing is stopped, and Org1's CA proxy never is", () => {
  const left = unlistedVoters({ pidFiles: ["ca-proxy.pid", "ca-proxy-chair-2027.pid"], containers: ["ca_voters_chair_2027"] }, containerOf, [chair("chair-2027")]);
  assert.deepEqual(left, { proxies: [], containers: [] });
});

test("the playground's own list: chair-2027 with demo voters voter1 to voter5", () => {
  assert.deepEqual(voterElections().map((e) => e.id), ["chair-2027"]);
  assert.deepEqual(DEMO_VOTERS.map((v) => v.id), ["voter1", "voter2", "voter3", "voter4", "voter5"]);
  assert.deepEqual(unlistedVoters({ pidFiles: ["ca-proxy-chair-2027.pid"], containers: ["ca_voters_chair_2027"] }, containerOf), { proxies: [], containers: [] });
});

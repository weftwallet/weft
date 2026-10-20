// Runs the contract against an in-memory stand-in for the Fabric stub.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BallotContract, commitmentFor } from "../dist/index.js";

function ledger() {
  const state = new Map();
  const privateData = new Map();
  let clock = Date.parse("2026-10-20T08:00:00Z");
  let tx = 0;
  const range = (map, prefix) => ({
    async *[Symbol.asyncIterator]() {
      for (const [key, value] of [...map].sort()) if (key.startsWith(prefix)) yield { key, value };
    },
  });
  const key = (type, attrs) => `\u0000${type}\u0000${attrs.map((a) => `${a}\u0000`).join("")}`;
  return {
    state,
    privateData,
    advance: (ms) => (clock += ms),
    ctx(mspId, id, transient = {}) {
      tx++;
      const events = [];
      let queriedPrivate = false;
      const write = (fn) => async (...args) => {
        // As in Fabric: no writes after a range query on private data.
        if (queriedPrivate) throw new Error("Transaction has already performed queries on pvt data. Writes are not allowed");
        return fn(...args);
      };
      return {
        events,
        stub: {
          createCompositeKey: key,
          splitCompositeKey: (k) => { const parts = k.split("\u0000").slice(1, -1); return { objectType: parts[0], attributes: parts.slice(1) }; },
          getPrivateData: async (c, k) => privateData.get(`${c}/${k}`) ?? Buffer.alloc(0),
          getState: async (k) => state.get(k) ?? Buffer.alloc(0),
          putState: write(async (k, v) => void state.set(k, Buffer.from(v))),
          putPrivateData: write(async (c, k, v) => void privateData.set(`${c}/${k}`, Buffer.from(v))),
          getStateByPartialCompositeKey: (type, attrs) => range(state, key(type, attrs)),
          getPrivateDataByPartialCompositeKey: (c, type, attrs) => {
            queriedPrivate = true;
            const prefix = `${c}/${key(type, attrs)}`;
            return { async *[Symbol.asyncIterator]() { for (const [k, value] of privateData) if (k.startsWith(prefix)) yield { key: k, value }; } };
          },
          getTransient: () => new Map(Object.entries(transient).map(([k, v]) => [k, Buffer.from(JSON.stringify(v))])),
          getTxID: () => `tx${tx}`,
          getTxTimestamp: () => ({ seconds: { toString: () => String(Math.floor(clock / 1000)) }, nanos: 0 }),
          setEvent: (name, payload) => events.push({ name, payload: JSON.parse(Buffer.from(payload).toString()) }),
        },
        clientIdentity: { getMSPID: () => mspId, getID: () => `x509::CN=${id}` },
      };
    },
  };
}

const salt = (n) => n.toString(16).padStart(32, "0");
const options = JSON.stringify(["yes", "no"]);

test("ballots stay private, commitments are public, the tally adds up", async () => {
  const l = ledger();
  const c = new BallotContract();
  await c.CreateElection(l.ctx("Org1MSP", "admin"), "board-2026", "Board vote", options, "2026-10-21T08:00:00Z");

  const receipt = JSON.parse(await c.CastVote(l.ctx("Org1MSP", "alice", { ballot: { option: "yes", salt: salt(1) } }), "board-2026"));
  assert.equal(receipt.commitment, commitmentFor("board-2026", "yes", salt(1)));
  await c.CastVote(l.ctx("Org2MSP", "bob", { ballot: { option: "no", salt: salt(2) } }), "board-2026");
  await c.CastVote(l.ctx("Org2MSP", "carol", { ballot: { option: "yes", salt: salt(3) } }), "board-2026");

  // The public state holds commitments only; no option appears in it.
  const publicText = [...l.state.values()].map((v) => v.toString()).join(" ");
  assert.ok(!publicText.includes('"option"'));
  assert.ok(publicText.includes(receipt.commitment));

  await assert.rejects(c.CastVote(l.ctx("Org1MSP", "alice", { ballot: { option: "no", salt: salt(4) } }), "board-2026"), /already voted/);
  await assert.rejects(c.CastVote(l.ctx("Org1MSP", "dan", { ballot: { option: "maybe", salt: salt(5) } }), "board-2026"), /isn't one of the options/);
  await assert.rejects(c.CastVote(l.ctx("Org1MSP", "dan", { ballot: { option: "yes", salt: "short" } }), "board-2026"), /salt/);
  await assert.rejects(c.CloseElection(l.ctx("Org1MSP", "admin"), "board-2026"), /open until/);

  l.advance(2 * 86_400_000);
  await assert.rejects(c.CastVote(l.ctx("Org1MSP", "dan", { ballot: { option: "yes", salt: salt(6) } }), "board-2026"), /closed/);
  await assert.rejects(c.CloseElection(l.ctx("Org2MSP", "admin"), "board-2026"), /Only Org1MSP/);
  const closed = JSON.parse(await c.CloseElection(l.ctx("Org1MSP", "admin"), "board-2026"));
  assert.deepEqual(closed.tally, { counts: { yes: 2, no: 1 }, total: 3 });
  assert.equal(closed.state, "closed");
});

test("the count stops when a commitment has no ballot behind it", async () => {
  const l = ledger();
  const c = new BallotContract();
  await c.CreateElection(l.ctx("Org1MSP", "admin"), "e1", "Vote", options, "2026-10-21T08:00:00Z");
  await c.CastVote(l.ctx("Org1MSP", "alice", { ballot: { option: "yes", salt: salt(1) } }), "e1");
  // A commitment written without a ballot (not possible through CastVote).
  l.state.set("\u0000commitment\u0000e1\u0000forged\u0000", Buffer.from(JSON.stringify({ commitment: "00" })));
  l.advance(2 * 86_400_000);
  await assert.rejects(c.CloseElection(l.ctx("Org1MSP", "admin"), "e1"), /ballot for transaction forged is missing/);
});

test("elections need valid IDs, two different options and a future close", async () => {
  const l = ledger();
  const c = new BallotContract();
  await assert.rejects(c.CreateElection(l.ctx("Org1MSP", "a"), "bad id", "t", options, "2026-10-21T08:00:00Z"), /IDs/);
  await assert.rejects(c.CreateElection(l.ctx("Org1MSP", "a"), "e", "t", '["only"]', "2026-10-21T08:00:00Z"), /at least two/);
  await assert.rejects(c.CreateElection(l.ctx("Org1MSP", "a"), "e", "t", '["a","a"]', "2026-10-21T08:00:00Z"), /different/);
  await assert.rejects(c.CreateElection(l.ctx("Org1MSP", "a"), "e", "t", options, "2026-10-19T08:00:00Z"), /future/);
});

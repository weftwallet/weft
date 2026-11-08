/**
 * Experimental (docs/adr/0008): the proposal check for an idemix signer
 * compares the creator's id_bytes with the identity Weft made, byte for
 * byte, before anything is signed. The X.509 tests are in the relay's
 * offline-signing test, unchanged.
 */
import type { ContractCall, RelaySigner } from "@weftwallet/protocol";
import { describe, expect, it } from "vitest";
import { toBase64 } from "./bytes.ts";
import { decodeProposedTransaction } from "./fabric-messages.ts";
import { evaluateCall, RelayClient, submitCall } from "./relay-client.ts";
import { isIdemixSigner, verifyProposal, VerificationError } from "./verify.ts";

const enc = new TextEncoder();
function varint(n: number): number[] {
  const out: number[] = [];
  for (; n >= 0x80; n >>>= 7) out.push((n & 0x7f) | 0x80);
  out.push(n);
  return out;
}
/** A length-delimited protobuf field. */
const f = (field: number, value: Uint8Array | string) => {
  const bytes = typeof value === "string" ? enc.encode(value) : value;
  return new Uint8Array([...varint((field << 3) | 2), ...varint(bytes.length), ...bytes]);
};
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, (at += p.length) - p.length);
  return out;
};

/** fabric-gateway's ProposedTransaction for `call`, with the given creator. */
function proposed(call: ContractCall, mspId: string, idBytes: Uint8Array, txId = "a".repeat(64)): Uint8Array {
  const header = cat(f(1, cat(f(4, call.channel), f(5, txId))), f(2, f(1, cat(f(1, mspId), f(2, idBytes)))));
  const spec = cat(f(2, f(2, call.chaincode)), f(3, cat(...[call.fn, ...(call.args ?? [])].map((a) => f(1, a)))));
  const proposal = cat(f(1, header), f(2, f(1, f(1, spec))));
  return cat(f(1, txId), f(2, f(1, proposal)));
}

const call: ContractCall = { channel: "privatevote-chair-2027", chaincode: "private-ballot", fn: "GetElection", args: ["chair-2027"] };
const VOTERS = "ChairVoters2027MSP";
const made = new Uint8Array(Array.from({ length: 260 }, (_, i) => (i * 13 + 5) % 256));
const signer: RelaySigner = { mspId: VOTERS, idemixIdentity: toBase64(made) };

/** A relay that answers the proposal request with `proposal`, and nothing else. */
function relayAnswering(proposal: Uint8Array) {
  const paths: string[] = [];
  const fetchImpl = (async (url: string) => {
    paths.push(new URL(url).pathname);
    return new Response(JSON.stringify({ proposal: toBase64(proposal), transactionId: "a".repeat(64) }), { status: 200 });
  }) as typeof fetch;
  return { relay: new RelayClient("http://relay.test", fetchImpl), paths };
}

describe("the proposal check for an idemix signer", () => {
  it("tells idemix signers from X.509 ones", () => {
    expect(isIdemixSigner(signer)).toBe(true);
    expect(isIdemixSigner({ mspId: "Org1MSP", certificate: "-----BEGIN CERTIFICATE-----" })).toBe(false);
  });

  it("passes when the creator is the identity Weft made", () => {
    expect(() => verifyProposal(call, signer, decodeProposedTransaction(proposed(call, VOTERS, made)))).not.toThrow();
  });

  it("refuses a creator one byte different, a byte longer or shorter, or from another MSP", () => {
    const flipped = new Uint8Array(made);
    flipped[100] = flipped[100]! ^ 0x80;
    for (const other of [flipped, cat(made, new Uint8Array([0])), made.subarray(0, made.length - 1)]) {
      const decoded = decodeProposedTransaction(proposed(call, VOTERS, other));
      expect(() => verifyProposal(call, signer, decoded)).toThrow(
        "Refusing to sign: signing identity does not match what you approved (expected \"the identity Weft made for this transaction, byte for byte\", got \"different bytes\").",
      );
    }
    expect(() => verifyProposal(call, signer, decodeProposedTransaction(proposed(call, "Org1MSP", made)))).toThrow(/signing organisation/);
  });

  it("refuses before anything is signed, in a read and in a write", async () => {
    const flipped = new Uint8Array(made);
    flipped[0] = flipped[0]! ^ 1;
    for (const flow of [evaluateCall, submitCall]) {
      const { relay, paths } = relayAnswering(proposed(call, VOTERS, flipped));
      const signed: Uint8Array[] = [];
      const sign = async (m: Uint8Array) => (signed.push(m), new Uint8Array(64));
      await expect(flow(relay, signer, call, sign)).rejects.toThrow(VerificationError);
      expect(signed).toEqual([]);
      expect(paths).toEqual(["/v1/proposals"]);
    }
  });
});

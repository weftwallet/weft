/**
 * Getting a voter credential (docs/adr/0008): the order of the steps, so
 * nothing secret is sent before a check that can fail, and what the voter
 * is told for each failure. The CA's answers are recorded from Fabric CA
 * 1.5.17's idemix endpoint; the module is a fake with the same calls.
 */
import type { IdemixApi, VoterCredentialSecret } from "@weftwallet/idemix";
import type { VoterInvite } from "@weftwallet/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { EnrolError, alreadyHeld, enrol, saveRecord, type EnrolDeps } from "./enrol";
import { credentialView, type VoterCredentialRecord } from "./types";

const KEY_BYTES = new TextEncoder().encode("an issuer public key, as Fabric CA serves it");
const KEY_B64 = btoa(String.fromCharCode(...KEY_BYTES));
let KEY_HASH = "";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const invite = (patch: Partial<VoterInvite> = {}): VoterInvite => ({
  weftVoterInvite: 1,
  network: "Weft playground",
  organization: "Chair 2027 voters",
  mspId: "ChairVoters2027MSP",
  affiliation: "voters",
  caUrl: "http://localhost:7081",
  caName: "ca-chair-2027",
  relayUrl: "http://localhost:8787",
  relayOperator: "Weft Playground",
  channel: "privatevote-chair-2027",
  chaincode: "private-ballot",
  electionId: "chair-2027",
  issuerKeyHash: KEY_HASH,
  curve: "FP256BN_AMCL",
  endorsers: [{ mspId: "Org1MSP", caChain: PEM }],
  ...patch,
});

/** Everything the enrolment did, in order. */
let log: string[];
let ca: {
  info: () => Response | Promise<Response>;
  nonce: () => Response;
  credential: () => Response;
};
let module: { start?: Error; load?: Error; check?: Error; attrs?: Partial<{ OU: string; Role: number; EnrollmentID: string }> };
let locked: boolean;
let saved: VoterCredentialRecord[];
let refuseSave: boolean;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function deps(): EnrolDeps {
  return {
    fetch: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      log.push(`${method} ${url.replace("http://localhost:7081", "")}${auth ? ` auth=${auth}` : ""}${body?.request ? " with a request" : ""}`);
      if (url.includes("/cainfo")) return ca.info();
      return body?.request ? ca.credential() : ca.nonce();
    },
    startModule: async () => {
      log.push("module started");
      if (module.start) throw module.start;
      const api: Partial<IdemixApi> = {
        loadIssuerKey: async (ipk) => {
          log.push("issuer key loaded");
          if (module.load) throw module.load;
          return { issuerKeyHash: ipk === KEY_B64 ? KEY_HASH : "other", curve: "FP256BN_AMCL" };
        },
        credentialRequest: async (nonce) => {
          log.push(`request built for ${nonce}`);
          return { secretKey: "c2VjcmV0IGtleQ==", request: { nonce } };
        },
        checkCredential: async (c: VoterCredentialSecret) => {
          log.push(`credential checked for ${c.enrollmentId}`);
          if (module.check) throw module.check;
          return "valid";
        },
      };
      return Object.assign(api as IdemixApi, { terminate: () => void log.push("worker terminated") });
    },
    voterKey: async () => {
      log.push("sealing key derived");
      if (locked) throw new Error("Weft is locked. Unlock it to sign.");
      return {} as CryptoKey;
    },
    seal: async (_key, id, secret) => {
      log.push(`sealed ${id}`);
      return { secret: { iv: "iv", data: `sealed(${secret.secretKey})` }, enrollmentId: { iv: "iv", data: `sealed(${secret.enrollmentId})` } };
    },
    save: async (record) => {
      log.push("saved");
      if (refuseSave) throw new Error("QuotaExceededError: The quota has been exceeded.");
      saved.push(record);
      return credentialView(record, null);
    },
    newId: () => "cred-1",
    now: () => 1_800_000_000_000,
  };
}

const basic = `Basic ${btoa("voter1:voter1pw")}`;

beforeEach(async () => {
  KEY_HASH = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", KEY_BYTES)), (b) => b.toString(16).padStart(2, "0")).join("");
  log = [];
  locked = false;
  saved = [];
  refuseSave = false;
  module = {};
  ca = {
    info: () => json(200, { success: true, result: { CAName: "ca-chair-2027", IssuerPublicKey: KEY_B64, IssuerRevocationPublicKey: "cmV2b2NhdGlvbg==" } }),
    nonce: () => json(200, { success: true, result: { Nonce: "bm9uY2U=" } }),
    credential: () => json(200, { success: true, result: { Credential: "Y3JlZGVudGlhbA==", CRI: "Y3Jp", Attrs: { OU: "voters", Role: 1, EnrollmentID: "voter1", ...module.attrs } } }),
  };
});

const run = (inv = invite()) => enrol(inv, "http://localhost:8787/.well-known/weft-voter-invite/chair-2027.json", "voter1", "voter1pw", deps());
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as EnrolError);

describe("enrolment", () => {
  it("checks the issuer key and starts the module before the secret is sent, and enrols once", async () => {
    const view = await run();
    expect(log).toEqual([
      "GET /api/v1/cainfo?ca=ca-chair-2027",
      "module started",
      "issuer key loaded",
      "sealing key derived",
      `POST /api/v1/idemix/credential auth=${basic}`,
      "request built for bm9uY2U=",
      `POST /api/v1/idemix/credential auth=${basic} with a request`,
      "credential checked for voter1",
      "sealed cred-1",
      "saved",
      "worker terminated",
    ]);
    // Only basic authorisation, only the idemix endpoint: never an X.509 enrolment or a token.
    expect(log.filter((l) => l.startsWith("POST")).every((l) => l.includes("/api/v1/idemix/credential auth=Basic "))).toBe(true);
    expect(view).toMatchObject({ id: "cred-1", electionId: "chair-2027", title: "chair-2027", mspId: "ChairVoters2027MSP", voted: null });
  });

  it("saves the invite and public keys readable, and the secrets only sealed", async () => {
    await run();
    const record = saved[0]!;
    expect(record).toMatchObject({ issuerPublicKey: KEY_B64, revocationPublicKey: "cmV2b2NhdGlvbg==", affiliation: "voters", role: "member", title: null, createdAt: 1_800_000_000_000 });
    expect(record.invite.electionId).toBe("chair-2027");
    const readable = JSON.stringify({ ...record, sealed: null });
    for (const secret of ["c2VjcmV0IGtleQ==", "Y3JlZGVudGlhbA==", "Y3Jp", "voter1"]) expect(readable).not.toContain(secret);
  });

  it("stops before anything secret is sent when the CA's issuer key isn't the invite's", async () => {
    const e = await failure(run(invite({ issuerKeyHash: "0c55e7a9".padEnd(56, "0") + "31f4d206" })));
    expect(e).toMatchObject({
      reason: "keymismatch",
      message: "The voters' CA has a different issuer key from the invite's. Ask the election's organisers. Weft asked the CA only for its public details, and enrolled nothing.",
    });
    expect(e?.detail).toMatch(/^The invite names issuer key 0c55e7a9…31f4d206\. ca-chair-2027 at localhost:7081 serves [0-9a-f]{8}…[0-9a-f]{8}\.$/);
    expect(log).toEqual(["GET /api/v1/cainfo?ca=ca-chair-2027"]);
  });

  it("stops when the CA doesn't answer", async () => {
    ca.info = () => Promise.reject(Object.assign(new Error("signal timed out"), { name: "TimeoutError" }));
    const e = await failure(run());
    expect(e).toMatchObject({ reason: "unreachable", message: expect.stringMatching(/^Weft couldn't reach the voters' CA at localhost:7081, so nothing was enrolled\./) });
    expect(e?.detail).toBe("GET http://localhost:7081/api/v1/cainfo?ca=ca-chair-2027: no answer within 15 seconds.");
    expect(log.some((l) => l.startsWith("POST"))).toBe(false);
  });

  it("stops before the secret is sent when the module doesn't start, or can't read the key", async () => {
    module.start = new Error("CompileError: WebAssembly.instantiate(): Refused to compile");
    let e = await failure(run());
    expect(e).toMatchObject({ reason: "module", message: expect.stringMatching(/^Weft Experimental couldn't start its voting module, so nothing was sent to the voters' CA\./) });
    expect(log.some((l) => l.startsWith("POST"))).toBe(false);

    log = [];
    module = { load: new Error("the issuer key doesn't decode") };
    e = await failure(run());
    expect(e?.reason).toBe("module");
    expect(log.some((l) => l.startsWith("POST"))).toBe(false);
    expect(log.at(-1)).toBe("worker terminated");
  });

  it("stops before the secret is sent when Weft has locked", async () => {
    locked = true;
    const e = await failure(run());
    expect(e?.reason).toBe("locked");
    expect(log.some((l) => l.startsWith("POST"))).toBe(false);
  });

  it("says a second enrolment is refused, and why it may be", async () => {
    ca.nonce = () => json(401, { success: false, errors: [{ code: 20, message: "Authentication failure" }], result: null });
    const e = await failure(run());
    expect(e).toMatchObject({
      reason: "second",
      message:
        "The voters' CA refused this enrolment ID and secret. It accepts each one once, so if you enrolled before, in this browser or another, that credential is the only one. If you didn't, ask the election's organisers.",
      detail: "POST http://localhost:7081/api/v1/idemix/credential answered 401. Code 20: Authentication failure.",
    });
    expect(saved).toHaveLength(0);
  });

  it("keeps nothing from a credential that doesn't check out, and says the enrolment is spent", async () => {
    module.check = new Error("credential is not valid");
    let e = await failure(run());
    expect(e).toMatchObject({
      reason: "badcred",
      message:
        "The voters' CA sent a credential that doesn't check out against its own issuer key, so Weft didn't save it. The CA has counted your one enrolment, so ask the organisers to register you again.",
    });
    expect(e?.detail).toMatch(/credential is not valid\. Attributes: OU voters, role 1, enrolment ID voter1\.$/);
    expect(log).not.toContain("saved");

    // A valid credential for another affiliation, the admin role or another ID is refused the same way.
    for (const attrs of [{ OU: "" }, { Role: 2 }, { EnrollmentID: "voter2" }]) {
      module = { attrs };
      saved = [];
      e = await failure(run());
      expect(e?.reason).toBe("badcred");
      expect(saved).toHaveLength(0);
    }
  });

  it("keeps a sealed credential the browser refused to save, to save again", async () => {
    refuseSave = true;
    const e = await failure(run());
    expect(e).toMatchObject({ reason: "save", message: expect.stringMatching(/^Weft couldn't save the voter credential\. The voters' CA has counted your enrolment/) });
    expect(e?.pending?.id).toBe("cred-1");
    refuseSave = false;
    const view = await saveRecord(e!.pending!, deps());
    expect(view.id).toBe("cred-1");
  });

  it("names a credential Weft already holds", () => {
    const e = alreadyHeld("chair-2027", Date.UTC(2027, 2, 2, 9, 2));
    expect(e.message).toBe("Weft already holds a voter credential for chair-2027. It keeps one per election, and nothing was sent to the voters' CA.");
    expect(e.detail).toBe("The credential was added on 2 March 2027. Remove it first only if you mean to enrol again, and the CA accepts each enrolment once.");
  });
});

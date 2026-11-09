# @weftwallet/idemix

IBM's idemix library, the one Fabric's idemix MSP uses, built from Go source to WebAssembly for Weft Experimental's voter credentials ([ADR 0008](../../docs/adr/0008-idemix-voter-credentials.md)). It is a private package: it isn't published, normal Weft never contains it, and no one outside the project has reviewed it.

The module does what a wallet needs to hold a voter credential and sign with it:

- `loadIssuerKey`: decode and check an election's issuer public key, and give its `issuerKeyHash`, SHA-256 of its bytes;
- `credentialRequest`: draw a secret key and build the request for Fabric CA's `/api/v1/idemix/credential`, bound to the CA's nonce;
- `checkCredential`: check a credential against the issuer key and its OU, role and enrolment ID;
- `newIdentity`: make a one-off identity, with a new Nym and a proof that it belongs to the credential, for one transaction;
- `sign`: sign a Fabric message as that identity: the proposal, the transaction or the commit status request, never fabric-gateway's wrapper bytes;
- `pseudonym`: the credential's [per-election pseudonym](../../apps/docs/src/content/docs/experimental/private-tally-spec.md#the-per-election-pseudonym) P, the same for every identity of the credential in one election, from which Weft makes the voter tag before it makes the ballot;
- `pseudonymProof`: the proof that P and the identity's Nym hold the same secret key, for the ballot's tracking code, which is `CastAnonymousBallot`'s `pseudonymJson`;
- `verifyIdentity`: check a transaction's idemix creator against the loaded issuer key, as a peer's idemix MSP validates it, and return what it discloses: the Nym, the organisational unit and the role. The proof is checked by the contract's own `pseudonym.Key.VerifyIdentity`, which `CastAnonymousBallot` runs against the pinned key;
- `verifyPseudonym`: check a ballot's pseudonym proof against the creator's Nym, the issuer key and the ballot's tracking code, with the contract's own verifier and messages;
- `dispose` and `wipe`: zero and drop an identity's secrets, or every identity's and the issuer key.

The two `verify` functions need no secret. The explorer runs them to check anonymous ballots, in its own process as it indexes each block and in the browser's full check, so the explorer checks with the code the contract and Weft run, and there is no TypeScript verifier.

The pseudonym and its proof come from the contract's `pseudonym` package, in `contracts/private-ballot/pseudonym`, which `go.mod` requires with a replace directive. The contract verifies with the same Go source.

## Layout

| Path | What |
|---|---|
| `signer/` | The Go signer, on IBM idemix's dlog scheme through its `bridge` package, the code Fabric's MSP runs under its BCCSP. It doesn't import the BCCSP itself, which also links the BBS+ scheme Fabric doesn't use. |
| `cmd/wasm/` | The WebAssembly entry: `globalThis.weftIdemix`, string-in, string-out functions with base64 bytes and JSON results. `vectors.go` adds `pseudonymVector` to a test build with the tag `weftvectors`, which proves from a vector's fixed inputs; the module Weft runs is built without it. |
| `internal/testtool/`, `internal/cmd/testtool/` | A scratch issuer, as Fabric CA issues credentials, IBM idemix's own MSP as the verifier, set up as a peer sets it up, and the contract's pseudonym verifier. Only tests use them. |
| `_overlay/mathlib-v0.3.2/math.go` | IBM mathlib v0.3.2's `math.go` without the curves Weft doesn't use (see [Size](#size)). |
| `scripts/build.mjs`, `scripts/check.mjs` | The pinned build, and the reproducibility check. |
| `src/` | TypeScript: the typed module (`module.ts`), the dedicated worker (`worker.ts`) and the page's side of it (`client.ts`), and a loader for Node (`node.ts`). `src/pinned.ts` holds the module's committed SHA-256. |

## Building

The module isn't committed. Its SHA-256 is, in `src/pinned.ts`, and the build refuses a module with another hash.

```sh
pnpm --filter @weftwallet/idemix build:wasm   # dist/wasm/weft-idemix.wasm and wasm_exec.js
pnpm --filter @weftwallet/idemix check:wasm   # two clean builds, compared with each other and the pin
```

It needs Go on your `PATH`, any version from 1.21: the build sets `GOTOOLCHAIN=go1.26.10`, and Go downloads that toolchain if it isn't the one installed. IBM idemix v0.3.1 requires Go 1.26.3 or later. The build:

1. copies the module's sources, without tests, into a temporary folder, beside the contract module's `go.mod`, `go.sum` and `pseudonym` package at the same relative path as in the repository, and vendors its dependencies from `go.sum`;
2. checks the SHA-256 of IBM mathlib's `math.go` and puts `_overlay/mathlib-v0.3.2/math.go` in its place;
3. builds with `GOOS=js GOARCH=wasm CGO_ENABLED=0`, `-trimpath -buildvcs=false -ldflags="-s -w -buildid="`, and an environment cleared of everything else that changes Go's output;
4. copies `wasm_exec.js` from the same toolchain (`lib/wasm` since Go 1.24);
5. checks both files' SHA-256 against `src/pinned.ts`, and the module's size against its budget.

After a change to the Go code, `go.mod` or the toolchain, run `node scripts/build.mjs --update`, which writes the new hashes into `src/pinned.ts`, and commit them with the change. `--if-missing` builds only when `dist/wasm` has no module with the pinned hash.

The loaders check the hashes too: `startModule` refuses bytes whose SHA-256 isn't the pinned one, and the worker refuses a `wasm_exec.js` that isn't.

## Size

The budget is 13.5 MB, or 3.2 MB gzipped. Measured with `gzip -9`, on 8 November 2026:

| Build | Raw | Gzipped |
|---|---|---|
| The study's signer, through the BCCSP, with Go 1.24.7 | 13.03 MB | 3.02 MB |
| The same, with Go 1.25.1 | 13.26 MB | 3.08 MB |
| The same, with Go 1.26.10 | 18.45 MB | 3.91 MB |
| This module, dlog scheme only, with Go 1.26.10 | 16.91 MB | 3.63 MB |
| This module with mathlib's unused curves left out, the build above | 12.57 MB | 2.88 MB |
| The same without inlining (`-gcflags=all=-l`) | 12.35 MB | 2.45 MB |
| This module with the per-election pseudonym, from the contract's `pseudonym` package | 12.63 MB | 2.92 MB |
| The same with `verifyIdentity` and `verifyPseudonym`, for the explorer: the module pinned now | 12.68 MB | 2.93 MB |

Go 1.26 makes the same code 40% larger than Go 1.25 for WebAssembly, and IBM idemix v0.3.1 needs Go 1.26.3, so an older toolchain isn't an option. Leaving out the BBS+ scheme saves little, because IBM mathlib's `Curves` table links gnark-crypto's BN254, BLS12-377 and BLS12-381 in every program that imports it. `_overlay/mathlib-v0.3.2/math.go` sets those entries to nil, which mathlib's own decoder already checks for, and nothing in the dlog scheme reads them. The no-inlining build signs about half as fast (an identity and three signatures in about 290 ms in Node, against 155 ms), so the build keeps inlining. TinyGo wasn't tried: its release couldn't be downloaded where this was built.

A new mathlib version needs a new overlay, in a folder named for it: copy its `math.go`, set the entries that use the `gurvy` drivers to nil, remove the two `gurvy` imports, and update `MATHLIB_MATH_GO_SHA256` in `scripts/build.mjs`.

## Running it

The module's functions answer synchronously in the scope that started it. `startModule` and `startIdemixNode` return `sync`, the same functions answering at once, for a caller in that scope such as the explorer's indexer, besides the promise-based `api`.

In Weft Experimental, the page that needs the module starts it in a dedicated worker and terminates the worker when it is done, which frees every copy of the secret key the module made:

```ts
import { startIdemixWorker } from "@weftwallet/idemix";

const idemix = await startIdemixWorker({
  worker: new Worker(new URL("@weftwallet/idemix/worker", import.meta.url), { type: "module" }),
  wasmUrl: browser.runtime.getURL("/idemix/weft-idemix.wasm"),
  wasmExecUrl: browser.runtime.getURL("/idemix/wasm_exec.js"),
});
try {
  await idemix.loadIssuerKey(issuerPublicKey);
  const id = await idemix.newIdentity(credential, "ChairVoters2027MSP");
  const signature = await idemix.sign(id.handle, proposalBase64);
  await idemix.dispose(id.handle);
} finally {
  idemix.terminate();
}
```

The worker's first message is `{ type: "loaded" }`, posted as its script starts and before it fetches the module, and `startIdemixWorker` sends `start` only after it. A worker whose script never loads can fail without an `error` event, so without `loaded` within `loadTimeoutMs` (3 seconds by default) `startIdemixWorker` terminates the worker and rejects with `IdemixWorkerLoadError`. `onLoaded` is called as `start` is sent, for a caller that times the module's own start from then. The worker script isn't part of the pinned hashes, which cover the module and `wasm_exec.js` only.

The page's content security policy needs `'wasm-unsafe-eval'` in `script-src`. In Node, `startIdemixNode()` from `@weftwallet/idemix/node` reads the module from `dist/wasm`.

## Tests

- `go test ./...`: the signer against a scratch issuer, with IBM idemix's MSP accepting every signature over its message and refusing it over another, a new Nym for every identity, every changed credential refused, and `Dispose` zeroing the secret key's and the Nym randomness's words. `VerifyIdentity` accepts the module's own identities and refuses a changed proof, another identity's Nym, another organisational unit, the role admin in place of member and another issuer's key; `VerifyPseudonym` refuses a proof for another Nym, election, channel or tracking code.
- `pnpm test`: the module in Node, against the same scratch issuer and MSP through `internal/cmd/testtool`, and a module with another hash refused. Its pseudonym proofs verify with the contract's verifier, for their own Nym and ballot only, and one credential has one pseudonym per election. A test build with `pseudonymVector` reproduces every positive vector in `contracts/private-ballot/pseudonym/testdata/v1/pseudonym.json` byte for byte, and the contract's verifier refuses each negative vector past parsing with its message. Vitest's setup builds the module if `dist/wasm` has none with the pinned hash, the test build and the test tool, with Go; without Go, these tests skip.
- With `WEFT_FABRIC_CA_BIN` set to a folder with `fabric-ca-server` and `fabric-ca-client` (for example `e2e/.bin` after `e2e/scripts/fabric-ca.sh`), `pnpm test` also enrols with a real Fabric CA through HTTP, checks that `/cainfo` serves the bytes of the `IssuerPublicKey` file, that a second enrolment is refused, and that IBM's MSP accepts the signatures under the CA's own key files.

## Timings

On 8 November 2026, on a 2.1 GHz Intel Xeon with two cores, for the module above. Node 22.22.0 runs it in the process; headless Chromium 141 runs it through `startIdemixWorker`, in a module worker, three runs each.

| Step | Node | Chromium |
|---|---|---|
| Start: fetch or read, SHA-256, compile and run | 305 ms | 348 to 459 ms |
| Load the issuer key | 44 ms | 54 to 72 ms |
| Build the credential request | 10 ms | 9 to 13 ms |
| Check the credential | 90 ms | 88 to 99 ms |
| New identity | 168 ms | 123 to 145 ms |
| Signature | 6 ms | 4 to 14 ms |
| A vote's signing: one identity and three signatures | 141 ms | 135 to 158 ms |
| The pseudonym proof, measured later the same day | 11 ms | not measured |
| An anonymous ballot's checks, `verifyIdentity` and `verifyPseudonym`, in the explorer, measured later the same day | 106 to 118 ms | not measured on its own: the explorer's whole check of 5 ballots took 1.3 to 1.7 s in two workers, with the module's start 0.4 to 0.7 s |

Firefox wasn't available where these were measured.

## Versions

| Module | Version | Licence |
|---|---|---|
| Go toolchain | go1.26.10 | BSD 3-Clause |
| `github.com/IBM/idemix` | v0.3.1 | Apache 2.0 |
| `github.com/IBM/mathlib` | v0.3.2 | Apache 2.0 |
| `github.com/hyperledger/fabric-amcl` | v0.0.0-20230602173724-9e02669dceb2 | Apache 2.0 |
| `github.com/consensys/gnark-crypto` | v0.21.0, vendored by the build but not linked into the module, because of the overlay | Apache 2.0 |
| `github.com/hyperledger/fabric-protos-go-apiv2` | v0.3.7 | Apache 2.0 |
| `github.com/weftwallet/weft/contracts/private-ballot` | the repository's, by a replace directive, for its `pseudonym` package | Apache 2.0 |
| `google.golang.org/protobuf` | v1.36.11 | BSD 3-Clause |
| `golang.org/x/crypto`, `golang.org/x/sys` | v0.57.0, v0.48.0 | BSD 3-Clause |

Fabric's main branch uses IBM idemix v0.3.1 too. Fabric CA 1.5.17 issued the credentials the tests and the study used, and a Fabric 2.5.16 peer accepted transactions this module signed.

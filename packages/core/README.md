# @weftwallet/core

Runtime-agnostic wallet logic, used by the extension's background worker (and testable in Node):

| Module | What it does |
|---|---|
| `signing.ts` | WebCrypto keys; ECDSA signatures converted to the low-S DER form Fabric requires. |
| `vault.ts` | Encryption at rest: password (PBKDF2) and passkey (PRF) keys that encrypt the vault key, which wraps private keys. |
| `certificate.ts` | Reads name, NodeOU role, Fabric CA attributes, expiry and fingerprint from X.509 certificates; builds CSRs. |
| `ca.ts` | Fabric CA REST client: enrol with a secret, re-enrol with a signed token. |
| `protobuf.ts`, `fabric-messages.ts` | A minimal protobuf reader and decoders for the Gateway messages the wallet signs. |
| `verify.ts` | Refuses to sign anything that differs from what the user approved. |
| `relay-client.ts` | Relay HTTP client plus the evaluate and submit flows. |
| `status.ts` | Plain-English explanations of Fabric validation codes and endorsement errors. |
| `invite.ts` | Resolves and validates invites. |

`pnpm test` runs the unit tests. Decoding and verification are also tested against real messages built by `@hyperledger/fabric-gateway` in `apps/relay/src/offline-signing.test.ts`.

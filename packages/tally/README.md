# @weftwallet/tally

The private tally's cryptography ([ADR 0007](../../docs/adr/0007-private-tally.md)), as the [specification](../../apps/docs/src/content/docs/experimental/private-tally-spec.md) defines it, for Weft Experimental, the trustee tool and the explorer. It is a private package: it isn't published, and Weft's normal build doesn't depend on it. No one outside the project has reviewed it.

| Entry point | For | Has |
|---|---|---|
| `@weftwallet/tally` | Every side | Framing, hashing, the election context and fingerprint, voter tags, the JSON shapes and the contract's error messages. |
| `@weftwallet/tally/client` | Weft Experimental | `encryptBallot`: encrypts a choice and proves the ballot, and discards the randomness. |
| `@weftwallet/tally/trustee` | `weft-trustee` | The key ceremony's three rounds and decryption shares. Returns secrets the tool must store encrypted. |
| `@weftwallet/tally/verify` | The explorer, and tests of the contract | Every check the contract runs, with its exact messages: ballots, ceremony posts, decryption shares and the tally. |
| `@weftwallet/tally/testing` | Tests and the vectors only | The provers with their randomness as an argument, and a seeded source. |

Randomness comes only from `crypto.getRandomValues`, except through `/testing`, which nothing outside tests imports.

## Test vectors

`vectors/v1/*.json` are written by `scripts/vectors.ts` from fixed seeds and committed. The contract's Go tests in `examples/private-ballot-contract/internal/tally` read the same files.

```sh
pnpm --filter @weftwallet/tally vectors   # writes vectors/v1; running it again changes no file
pnpm --filter @weftwallet/tally test      # every vector, regeneration, and random elections end to end
pnpm --filter @weftwallet/tally bench     # timings at 3 and 10 options
```

A change to the scheme changes the vectors first. A change to an encoding needs a new label version and a new folder, `vectors/v2/`.

## Library code and hand-written code

From `@noble/curves` 2.4.0: the ristretto255 group, `expand_message_xmd` and hashing to a scalar, and the FROST DKG's three rounds (`ristretto255_FROST.DKG`). From `@noble/hashes` 2.4.0: SHA-256, SHA-512 and HKDF. AES-GCM is WebCrypto's.

Hand-written, and to be reviewed: the framing, the encryption, the 0-or-1, sum, confirmation and decryption share proofs, the share boxes' construction, the check that names the sender of a bad share, the strict JSON parser, the Lagrange combination and the count.

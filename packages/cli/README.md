# @weftwallet/cli

Command-line tools for network operators. Build your organisation's invite from the Fabric connection profile you already have, then share it as a link or QR code.

```sh
npx @weftwallet/cli invite create --profile connection-org1.json --relay https://relay.org1.example.com --channel mychannel -o invite.json
npx @weftwallet/cli invite share https://relay.org1.example.com/.well-known/weft-invite.json --qr invite.svg
npx @weftwallet/cli invite check https://relay.org1.example.com/.well-known/weft-invite.json
```

| Command | What it does |
|---|---|
| `invite create` | Builds an invite from a connection profile (JSON or YAML), or from `--msp`/`--ca` flags. |
| `invite share` | Prints the join link, the `weft://` link and the raw URL; writes a QR code (`.svg` or `.png`) or prints one in the terminal. |
| `invite check` | Validates an invite and checks its relay and CA respond. Exits non-zero on any failure, so it fits in CI. |

Run `weft --help` for every option. Guide: [Publish an org invite](../../apps/docs/src/content/docs/operators/invites.md).

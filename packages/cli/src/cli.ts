#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { checkInvite, createInvite, shareInvite } from "./commands.ts";

const HELP = `weft: tools for Weft network operators

Usage
  weft invite create --profile <file> --relay <url> [options]
  weft invite create --msp <id> --ca <url> --relay <url> --channel <name> [options]
  weft invite share  <invite-url> [--qr invite.svg|invite.png] [--terminal]
  weft invite check  <invite-url | weft-link | file>

invite create   Build an invite from your Fabric connection profile (JSON or YAML)
  --profile <file>       Connection profile, e.g. connection-org1.json
  --relay <url>          Your organisation's Weft relay (required)
  --channel <name>       Channel to offer; repeat for several (required if the profile lists none)
  --org <name>           Organisation in the profile, if it lists several
  --network <name>       Display name for the network
  --enrollment-id <id>   Pre-fill the enrollment ID (per-person invites)
  --msp, --ca, --ca-name Describe the organisation without a profile
  -o, --out <file>       Write the invite here instead of printing it

invite share    Print share links for a hosted invite, and make a QR code
  --qr <file>            Write a QR code (.svg or .png) of the join link
  --terminal             Print the QR code in the terminal
  --join-page <url>      Use your own join page instead of the hosted one

invite check    Validate an invite and check its relay and CA answer

The relay can also serve the invite for you at /.well-known/weft-invite.json;
see https://weft.ifeanyiugwu.dev/operators/invites/`;

function fail(message: string): never {
  process.stderr.write(`weft: ${message}\n`);
  process.exit(1);
}

async function main(argv: string[]) {
  const [group, command, ...rest] = argv;
  if (!group || group === "help" || group === "--help" || group === "-h") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (group !== "invite") fail(`unknown command "${group}". Run weft --help.`);

  switch (command) {
    case "create": {
      const { values } = parseArgs({
        args: rest,
        options: {
          profile: { type: "string" },
          relay: { type: "string" },
          channel: { type: "string", multiple: true },
          org: { type: "string" },
          network: { type: "string" },
          "enrollment-id": { type: "string" },
          msp: { type: "string" },
          ca: { type: "string" },
          "ca-name": { type: "string" },
          out: { type: "string", short: "o" },
        },
      });
      const invite = await createInvite({
        ...(values.profile ? { profile: values.profile } : {}),
        ...(values.relay ? { relay: values.relay } : {}),
        channels: values.channel ?? [],
        ...(values.org ? { organization: values.org } : {}),
        ...(values.network ? { network: values.network } : {}),
        ...(values["enrollment-id"] ? { enrollmentId: values["enrollment-id"] } : {}),
        ...(values.msp ? { mspId: values.msp } : {}),
        ...(values.ca ? { caUrl: values.ca } : {}),
        ...(values["ca-name"] ? { caName: values["ca-name"] } : {}),
      });
      const json = `${JSON.stringify(invite, null, 2)}\n`;
      if (values.out) {
        await writeFile(values.out, json);
        process.stderr.write(
          `Wrote ${values.out}. Host it over HTTPS, then run: weft invite share <its url> --qr invite.svg\n`,
        );
      } else {
        process.stdout.write(json);
      }
      return;
    }
    case "share": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          qr: { type: "string" },
          terminal: { type: "boolean" },
          "join-page": { type: "string" },
        },
      });
      const url = positionals[0] ?? fail("give the invite's URL, e.g. https://relay.org1.example.com/.well-known/weft-invite.json");
      const result = await shareInvite(url, {
        ...(values.qr ? { qr: values.qr } : {}),
        ...(values.terminal ? { terminal: true } : {}),
        ...(values["join-page"] ? { joinPage: values["join-page"] } : {}),
      });
      process.stdout.write(
        [
          `Join link (email, chat, docs):\n  ${result.join}`,
          `Weft link (paste into Weft):\n  ${result.weft}`,
          `Invite JSON:\n  ${result.url}`,
          ...(result.qrFile ? [`QR code of the join link: ${result.qrFile}`] : []),
          ...(result.qrTerminal ? [result.qrTerminal] : []),
        ].join("\n\n") + "\n",
      );
      return;
    }
    case "check": {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
      const input = positionals[0] ?? fail("give an invite URL, weft:// link or file to check");
      const lines = await checkInvite(input);
      for (const line of lines) process.stdout.write(`${line.ok ? "✓" : "✗"} ${line.label.padEnd(12)} ${line.detail}\n`);
      if (lines.some((l) => !l.ok)) process.exitCode = 1;
      return;
    }
    default:
      fail(`unknown invite command "${command ?? ""}". Use create, share or check.`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));

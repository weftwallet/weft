#!/usr/bin/env node
/**
 * weft-trustee: what a trustee organisation runs for a private election in
 * Weft Experimental (docs/adr/0007, key-ceremony.md). Experimental, and no
 * one outside the project has reviewed its cryptography.
 */
import { parseArgs } from "node:util";
import * as commands from "./commands.ts";
import { connectionOptions, flagsFrom, resolveConnection } from "./connection.ts";
import { loadIdentity } from "./identity.ts";
import { gatewayLedger, Unreachable, type Ledger } from "./ledger.ts";
import { consoleOutput, Failure } from "./output.ts";
import { terminalPrompt } from "./prompt.ts";

const HELP = `weft-trustee: the trustee tool for private elections in Weft Experimental.
Experimental: no one outside the project has reviewed its cryptography.

Usage
  weft-trustee <command> --election <id> --connection <file> [options]

Commands
  status    Shows the election's state and each trustee's progress
  create    Creates the election, in keygen (--title, --option, --closes-at, --trustee)
  commit    Round 1: draws the polynomial and the one-time key, and posts the commitments
  share     Round 2: encrypts a share to each other trustee, and posts them
  confirm   Round 3: checks the shares sent to you, saves your key share, and posts a proof
            that you hold it. The last confirmation opens the election
  open      Opens the election once every trustee has confirmed, if the last confirm didn't
  close     Asks to close voting. Voting closes when k trustees have asked.
            Before the planned closing time it needs --early
  decrypt   Posts your decryption share of each total. The k-th share publishes the tally
  publish   Publishes the tally once k shares are in, if the k-th decrypt didn't
  cancel    Cancels the election during the key ceremony (the creator's organisation only)
  destroy   Deletes what this machine saved for the election, after the tally

Connection
  --connection <file>      A YAML or JSON file with the settings below. Flags override it
  --peer <host:port>       Your organisation's peer
  --peer-host-alias <name> The name in the peer's TLS certificate, if not the host
  --tls-ca <file>          The peer's TLS CA certificate
  --msp <id>               Your organisation's MSP ID
  --cert <file|folder>     The trustee identity's certificate (weft.trustee=true)
  --key <file|folder>      Its private key
  --channel <name>         The election's channel
  --contract <name>        The contract, private-ballot by default
  --home <folder>          Where state folders go, ~/.weft/trustee by default (or WEFT_TRUSTEE_HOME)

Options
  --json                   status: prints the records as JSON
  --title <text>           create: the election's title
  --option <text>          create: an option; repeat for each, 2 to 20
  --closes-at <time>       create: the planned closing time, such as 2027-01-31T17:00:00.000Z
  --trustee <msp>          create: a trustee organisation; repeat, in order
  --threshold <k>          create: how many trustees decrypt, a majority by default
  --voter <msp>            create: an organisation whose X.509 identities vote; the trustees by default
  --early                  close: close before the planned closing time
  --force                  destroy: delete before the tally is published
  --yes                    destroy: don't ask for the election ID

The passphrase that encrypts the state folder is asked for in the terminal,
or read from WEFT_TRUSTEE_PASSPHRASE.`;

const COMMANDS = ["status", "create", "commit", "share", "confirm", "open", "close", "decrypt", "publish", "cancel", "destroy"] as const;
type Command = (typeof COMMANDS)[number];

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (!COMMANDS.includes(command as Command)) throw new Failure(`weft-trustee has no command ${command}.`, `Run weft-trustee --help for the commands.`);
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        ...connectionOptions,
        election: { type: "string" },
        json: { type: "boolean" },
        title: { type: "string" },
        option: { type: "string", multiple: true },
        "closes-at": { type: "string" },
        trustee: { type: "string", multiple: true },
        threshold: { type: "string" },
        voter: { type: "string", multiple: true },
        early: { type: "boolean" },
        force: { type: "boolean" },
        yes: { type: "boolean" },
      },
    }));
  } catch (err) {
    const unknown = err instanceof Error ? err.message.match(/Unknown option '([^']+)'/) : null;
    throw new Failure(unknown ? `weft-trustee has no option ${unknown[1]}.` : err instanceof Error ? err.message : String(err), "Run weft-trustee --help for the options.");
  }
  const election = values.election;
  if (typeof election !== "string" || !election) throw new Failure(`${command} needs --election <id>.`);
  const connection = resolveConnection(flagsFrom(values));
  const identity = loadIdentity(connection.msp, connection.cert, connection.key);
  let ledger: Ledger | null = null;
  const env: commands.Env = {
    connection,
    identity,
    ledger: async () => (ledger ??= await gatewayLedger(connection, identity)),
    prompt: terminalPrompt,
    out: consoleOutput,
    ...(process.env.WEFT_TRUSTEE_PASSPHRASE !== undefined ? { passphrase: process.env.WEFT_TRUSTEE_PASSPHRASE } : {}),
    now: () => new Date(),
  };
  try {
    return await run(command as Command, env, election, values);
  } catch (err) {
    if (err instanceof Unreachable) {
      const where = connection.source === "--peer and --tls-ca" ? "--peer and --tls-ca" : connection.source;
      throw new Failure(`Weft couldn't reach the peer at ${err.address}: ${err.reason}.`, `Check the peer address and its TLS CA certificate in ${where}.`);
    }
    throw err;
  } finally {
    (ledger as Ledger | null)?.close();
  }
}

function run(command: Command, env: commands.Env, election: string, v: Record<string, unknown>): Promise<number> {
  switch (command) {
    case "status":
      return commands.status(env, { election, json: v.json === true });
    case "create": {
      const title = v.title;
      const options = (v.option as string[] | undefined) ?? [];
      const closesAt = v["closes-at"];
      const trustees = (v.trustee as string[] | undefined) ?? [];
      if (typeof title !== "string" || typeof closesAt !== "string" || !trustees.length || !options.length) {
        throw new Failure("create needs --title, an --option for each option, --closes-at and a --trustee for each trustee organisation.", "Run weft-trustee --help for an example.");
      }
      let threshold: number | undefined;
      if (typeof v.threshold === "string") {
        threshold = Number(v.threshold);
        if (!Number.isInteger(threshold)) throw new Failure(`--threshold ${v.threshold} isn't a whole number.`);
      }
      return commands.create(env, {
        election,
        title,
        options,
        closesAt,
        trustees,
        ...(threshold !== undefined ? { threshold } : {}),
        ...(v.voter ? { voters: v.voter as string[] } : {}),
      });
    }
    case "commit":
      return commands.commit(env, { election });
    case "share":
      return commands.share(env, { election });
    case "confirm":
      return commands.confirm(env, { election });
    case "open":
      return commands.open(env, { election });
    case "close":
      return commands.close(env, { election, early: v.early === true });
    case "decrypt":
      return commands.decrypt(env, { election });
    case "publish":
      return commands.publish(env, { election });
    case "cancel":
      return commands.cancel(env, { election });
    case "destroy":
      return commands.destroy(env, { election, force: v.force === true, yes: v.yes === true });
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof Failure) consoleOutput.failed(err.lines[0]!, ...err.lines.slice(1));
    else consoleOutput.failed(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);

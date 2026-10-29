// Runs several of Weft's dev servers in one terminal.
//
//   pnpm dev                    # the sites: site, docs, playground and network
//   pnpm dev site playground    # just these
//   pnpm dev all                # the sites and the extension
//   pnpm dev --stream           # start on the stream rather than the tabs
//
// In a terminal it opens @laravel/multiplex: a tab for each product, or one
// stream of them all, labelled. t and s switch between the two; r restarts
// a product, / searches, f picks which products the stream shows, q quits.
// When you quit, the output is left in your terminal's scrollback. Without a
// terminal (piped, or in CI) it prints the labelled lines as they come.
//
// A product whose port is already taken (running in another terminal, or the
// playground stack's relay and explorer) is skipped with a note, rather than
// failing with "address in use".
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

/** Each product: its folder, its port (none for the extension) and its label colour. */
const PRODUCTS = {
  site: { dir: "apps/site", port: 4321, color: "cyan" },
  docs: { dir: "apps/docs", port: 4322, color: "blue" },
  playground: { dir: "apps/playground", port: 4323, color: "green" },
  network: { dir: "apps/network", port: 4324, color: "magenta" },
  ext: { dir: "apps/extension", color: "yellow" },
  relay: { dir: "apps/relay", port: 8787, color: "red", stack: true },
  explorer: { dir: "apps/explorer", port: 8790, color: "blueBright", stack: true },
};
const SITES = ["site", "docs", "playground", "network"];
const FLAGS = { "--stream": "stream", "-s": "stream", "--inline": "inline", "-i": "inline" };

/** Why a product wasn't started, for its tab. */
const why = (name) => {
  const p = PRODUCTS[name];
  return p.stack
    ? `Not started: port ${p.port} is in use, probably by the playground stack's ${name}. Stop the stack (pnpm playground:down) to work on the ${name} here.`
    : `Not started: it's already running on http://localhost:${p.port}.`;
};
// The tab of a skipped product runs this script again to print the reason.
const args = process.argv.slice(2);
if (args[0] === "--why") {
  console.log(why(args[1]));
  process.exit(0);
}

const flags = Object.fromEntries(args.filter((a) => FLAGS[a]).map((a) => [FLAGS[a], true]));
const asked = args.filter((a) => !FLAGS[a]);
const names = asked.length === 0 ? SITES : asked.includes("all") ? [...SITES, "ext"] : [...new Set(asked)];
const unknown = names.filter((n) => !PRODUCTS[n]);
if (unknown.length) {
  console.error(`Unknown: ${unknown.join(", ")}. Choose from ${Object.keys(PRODUCTS).join(", ")} or all, with --stream or --inline if you like.`);
  process.exit(1);
}

/** Whether something is already listening on a local port. */
const taken = (port) =>
  new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });

// Each product's own dev script, run the way pnpm would run it (from its
// folder, with its node_modules/.bin first on the PATH), but without pnpm:
// several pnpm runs starting at once race on pnpm's workspace state. The
// PATH entry is relative, so it means each product's own folder, and each
// tab's heading reads as plainly as the script does: cd apps/site && astro dev.
process.env.PATH = ["node_modules/.bin", join(root, "node_modules", ".bin"), process.env.PATH].join(":");
const command = (dir) => `cd ${dir} && ${JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")).scripts.dev}`;

// A skipped product still gets its tab, holding the reason, so the note is
// where you'd look for its logs.
const commands = [];
const skipped = [];
for (const name of names) {
  const p = PRODUCTS[name];
  const free = !p.port || !(await taken(p.port));
  if (!free) skipped.push(name);
  commands.push({ label: name, color: p.color, command: free ? command(p.dir) : `node scripts/dev-all.mjs --why ${name}` });
}
if (skipped.length === names.length) {
  for (const name of skipped) console.log(`${name}: ${why(name)}`);
  console.log("Nothing to start.");
  process.exit(0);
}

const { multiplex } = await import("@laravel/multiplex");
process.exit(await multiplex({ commands, title: "Weft", cwd: root, ...flags }));

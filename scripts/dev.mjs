// Runs Node with the arguments given, adding --env-file=.env when the current
// folder has a .env. The relay's and explorer's dev scripts use it because
// Node 22's --env-file-if-exists crashes under --watch when the file is
// missing. With a .env, editing it restarts the app, as --env-file does.
//
//   node ../../scripts/dev.mjs --watch src/main.ts
//
// --default NAME=value (before Node's own arguments) sets a variable for the
// app unless the shell or the .env already sets it: the explorer's dev script
// uses it to link to the local sites.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const given = process.argv.slice(2);
const env = { ...process.env };
const fromFile = existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")) : {};
while (given[0] === "--default") {
  const [name, ...value] = (given[1] ?? "").split("=");
  if (!name || value.length === 0) throw new Error(`--default needs NAME=value, not ${given[1] ?? "nothing"}.`);
  if (env[name] === undefined && fromFile[name] === undefined) env[name] = value.join("=");
  given.splice(0, 2);
}

const args = [...(existsSync(".env") ? ["--env-file=.env"] : []), ...given];
const child = spawn(process.execPath, args, { stdio: "inherit", env });
// Ctrl-C reaches both processes; anything else sent to this one is passed on.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

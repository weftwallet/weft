// Runs Node with the arguments given, adding --env-file=.env when the current
// folder has a .env. The relay's and explorer's dev scripts use it because
// Node 22's --env-file-if-exists crashes under --watch when the file is
// missing. With a .env, editing it restarts the app, as --env-file does.
//
//   node ../../scripts/dev.mjs --watch src/main.ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const args = [...(existsSync(".env") ? ["--env-file=.env"] : []), ...process.argv.slice(2)];
const child = spawn(process.execPath, args, { stdio: "inherit" });
// Ctrl-C reaches both processes; anything else sent to this one is passed on.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

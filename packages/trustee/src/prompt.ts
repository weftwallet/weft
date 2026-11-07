/**
 * Reading the passphrase and confirmations from the terminal. Scripts set
 * WEFT_TRUSTEE_PASSPHRASE instead, and destroy takes --yes.
 */
import { createInterface } from "node:readline";
import { Failure } from "./output.ts";

export interface Prompt {
  /** Reads a passphrase without showing it. */
  secret(question: string): Promise<string>;
  /** Reads a line. */
  line(question: string): Promise<string>;
}

function needTerminal(): never {
  throw new Failure(
    "weft-trustee needs a passphrase, and isn't running in a terminal.",
    "Run it in a terminal, or set WEFT_TRUSTEE_PASSPHRASE for a script.",
  );
}

export const terminalPrompt: Prompt = {
  secret(question) {
    const input = process.stdin;
    if (!input.isTTY) needTerminal();
    process.stderr.write(question);
    return new Promise((done, fail) => {
      let value = "";
      input.setRawMode(true);
      input.resume();
      input.setEncoding("utf8");
      const finish = () => {
        input.setRawMode(false);
        input.pause();
        input.off("data", onData);
        process.stderr.write("\n");
      };
      const onData = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === "\r" || ch === "\n") {
            finish();
            done(value);
            return;
          }
          if (ch === "\u0003") {
            finish();
            fail(new Failure("Stopped. Nothing was posted."));
            return;
          }
          if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
          else value += ch;
        }
      };
      input.on("data", onData);
    });
  },
  line(question) {
    if (!process.stdin.isTTY) needTerminal();
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    return new Promise((done) =>
      rl.question(question, (answer) => {
        rl.close();
        done(answer.trim());
      }),
    );
  },
};

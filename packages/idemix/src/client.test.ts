/**
 * The page's side of the worker, against a stand-in worker: a worker that
 * fires `error` (its script refused or missing, or an uncaught throw) fails
 * the start at once, terminated, instead of leaving the page to wait for
 * its own timeout.
 */
import { describe, expect, it } from "vitest";
import { startIdemixWorker } from "./client.ts";
import { IdemixError } from "./module.ts";
import type { FromWorker, ToWorker } from "./messages.ts";

class FakeWorker {
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  sent: ToWorker[] = [];
  terminated = 0;
  postMessage(message: ToWorker) {
    this.sent.push(message);
  }
  terminate() {
    this.terminated += 1;
  }
  reply(message: FromWorker) {
    this.onmessage?.({ data: message } as MessageEvent<FromWorker>);
  }
  fail(message?: string) {
    this.onerror?.(Object.assign(new Event("error"), message === undefined ? {} : { message }));
  }
}

const start = (worker: FakeWorker) => startIdemixWorker({ worker: worker as unknown as Worker, wasmUrl: "/idemix/weft-idemix.wasm", wasmExecUrl: "/idemix/wasm_exec.js" });

describe("startIdemixWorker", () => {
  it("rejects as soon as the worker fires error, and terminates it", async () => {
    const worker = new FakeWorker();
    const started = start(worker);
    expect(worker.sent).toEqual([{ type: "start", wasmUrl: "/idemix/weft-idemix.wasm", wasmExecUrl: "/idemix/wasm_exec.js" }]);
    const t = performance.now();
    worker.fail();
    await expect(started).rejects.toBeInstanceOf(IdemixError);
    await expect(started).rejects.toThrow("The idemix module's worker stopped with an error, and the browser gave no reason. Its script may have failed to load.");
    expect(performance.now() - t).toBeLessThan(100);
    expect(worker.terminated).toBe(1);
  });

  it("gives the error's message when the browser has one", async () => {
    const worker = new FakeWorker();
    const started = start(worker);
    worker.fail("Uncaught SyntaxError: Unexpected token");
    await expect(started).rejects.toThrow("The idemix module's worker stopped with an error: Uncaught SyntaxError: Unexpected token");
  });

  it("rejects the calls waiting when the worker fails after it started", async () => {
    const worker = new FakeWorker();
    const started = start(worker);
    worker.reply({ type: "started", timings: { hash: 1, compile: 2, run: 3, fetch: 4, total: 10 } });
    const idemix = await started;
    const info = idemix.info();
    worker.fail("out of memory");
    await expect(info).rejects.toThrow("out of memory");
  });

  it("rejects with the module's own reason when it refuses to start", async () => {
    const worker = new FakeWorker();
    const started = start(worker);
    worker.reply({ type: "failed", error: "wasm_exec.js isn't the one pinned with the idemix module, so Weft didn't start it." });
    await expect(started).rejects.toThrow("wasm_exec.js isn't the one pinned");
    expect(worker.terminated).toBe(1);
  });
});

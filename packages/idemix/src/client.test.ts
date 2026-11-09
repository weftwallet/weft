/**
 * The page's side of the worker, against a stand-in worker: a worker that
 * fires `error` (its script refused or missing, or an uncaught throw) fails
 * the start at once, terminated, instead of leaving the page to wait for
 * its own timeout. A worker that never says "loaded" fails after
 * LOAD_TIMEOUT_MS, terminated, with nothing sent to it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdemixWorkerLoadError, LOAD_TIMEOUT_MS, startIdemixWorker } from "./client.ts";
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

const start = (worker: FakeWorker, options: { onLoaded?: () => void } = {}) =>
  startIdemixWorker({ worker: worker as unknown as Worker, wasmUrl: "/idemix/weft-idemix.wasm", wasmExecUrl: "/idemix/wasm_exec.js", ...options });

/** Starts the worker and has it say "loaded", as worker.ts does first. */
const startLoaded = (worker: FakeWorker) => {
  const started = start(worker);
  worker.reply({ type: "loaded" });
  return started;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("startIdemixWorker", () => {
  it("sends start only once the worker's script says it has loaded", async () => {
    const worker = new FakeWorker();
    const loaded = vi.fn();
    const started = start(worker, { onLoaded: loaded });
    expect(worker.sent).toEqual([]);
    worker.reply({ type: "loaded" });
    expect(loaded).toHaveBeenCalledTimes(1);
    expect(worker.sent).toEqual([{ type: "start", wasmUrl: "/idemix/weft-idemix.wasm", wasmExecUrl: "/idemix/wasm_exec.js" }]);
    worker.reply({ type: "started", timings: { hash: 1, compile: 2, run: 3, fetch: 4, total: 10 } });
    await expect(started).resolves.toMatchObject({ timings: { total: 10 } });
    expect(worker.terminated).toBe(0);
  });

  it("rejects at about 3 seconds when the worker never says it has loaded, terminates it and sends nothing", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const started = start(worker);
    const settled = started.then(
      () => null,
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS - 1);
    expect(worker.terminated).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    const error = await settled;
    expect(LOAD_TIMEOUT_MS).toBe(3_000);
    expect(error).toBeInstanceOf(IdemixWorkerLoadError);
    expect(error).toBeInstanceOf(IdemixError);
    expect((error as Error).message).toBe("The idemix module's worker didn't load within 3 seconds, so nothing was sent to it.");
    expect(worker.terminated).toBe(1);
    expect(worker.sent).toEqual([]);
  });

  it("doesn't time out a worker that has loaded, however long the module takes", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const started = startLoaded(worker);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(worker.terminated).toBe(0);
    worker.reply({ type: "started", timings: { hash: 1, compile: 2, run: 3, fetch: 4, total: 10 } });
    await expect(started).resolves.toMatchObject({ timings: { total: 10 } });
  });

  it("rejects as soon as the worker fires error, and terminates it", async () => {
    const worker = new FakeWorker();
    const started = start(worker);
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
    const started = startLoaded(worker);
    worker.reply({ type: "started", timings: { hash: 1, compile: 2, run: 3, fetch: 4, total: 10 } });
    const idemix = await started;
    const info = idemix.info();
    worker.fail("out of memory");
    await expect(info).rejects.toThrow("out of memory");
  });

  it("rejects with the module's own reason when it refuses to start", async () => {
    const worker = new FakeWorker();
    const started = startLoaded(worker);
    worker.reply({ type: "failed", error: "wasm_exec.js isn't the one pinned with the idemix module, so Weft didn't start it." });
    await expect(started).rejects.toThrow("wasm_exec.js isn't the one pinned");
    expect(worker.terminated).toBe(1);
  });
});

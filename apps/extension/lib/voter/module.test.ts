/**
 * The voting module's worker loads from the extension's own origin, its own
 * file /idemix-worker.js, in every build: in a dev build the page's scripts
 * come from the Vite dev server, and the browser refuses a worker from
 * another origin. A worker that fails to load fails the start at once, and
 * one whose script never says it has loaded fails after 3 seconds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("wxt/browser", () => ({
  browser: { runtime: { getURL: (path: string) => `chrome-extension://weft${path}` } },
}));

class FakeWorker {
  static made: FakeWorker[] = [];
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;
  sent: unknown[] = [];
  constructor(
    readonly url: string | URL,
    readonly options?: WorkerOptions,
  ) {
    FakeWorker.made.push(this);
  }
  postMessage(message: unknown) {
    this.sent.push(message);
  }
  reply(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
  terminate() {
    this.terminated = true;
  }
}

beforeEach(() => {
  FakeWorker.made = [];
  vi.stubGlobal("Worker", FakeWorker);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const START = { type: "start", wasmUrl: "chrome-extension://weft/idemix/weft-idemix.wasm", wasmExecUrl: "chrome-extension://weft/idemix/wasm_exec.js" };
const TIMINGS = { hash: 1, compile: 2, run: 3, fetch: 4, total: 10 };

describe("startVoterModule", () => {
  it("starts the worker from the extension's own file, as a module worker", async () => {
    const { startVoterModule, workerUrl } = await import("./module");
    expect(workerUrl()).toBe("chrome-extension://weft/idemix-worker.js");
    const started = startVoterModule();
    const worker = FakeWorker.made[0]!;
    expect(String(worker.url)).toBe("chrome-extension://weft/idemix-worker.js");
    // Not a dev server's http://localhost:3000: the page's own extension origin.
    expect(String(worker.url).startsWith("chrome-extension://weft/")).toBe(true);
    expect(worker.options).toEqual({ type: "module" });
    // Nothing is sent until the worker's script says it has loaded.
    expect(worker.sent).toEqual([]);
    worker.reply({ type: "loaded" });
    expect(worker.sent).toEqual([START]);
    worker.onerror?.(new Event("error"));
    await expect(started).rejects.toThrow("The idemix module's worker stopped with an error");
  });

  it("fails at once, not after its timeout, when the worker fires error", async () => {
    vi.useFakeTimers();
    try {
      const { startVoterModule } = await import("./module");
      const started = startVoterModule();
      const settled = started.then(
        () => "started",
        (e: Error) => e.message,
      );
      FakeWorker.made[0]!.onerror?.(Object.assign(new Event("error"), { message: "Failed to fetch a worker script." }));
      // No timer has run: the rejection came from the error event alone.
      await expect(settled).resolves.toBe("The idemix module's worker stopped with an error: Failed to fetch a worker script.");
      expect(FakeWorker.made[0]!.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails at about 3 seconds, with the worker terminated and nothing sent, when the worker's script never loads", async () => {
    vi.useFakeTimers();
    const { startVoterModule } = await import("./module");
    const settled = startVoterModule().then(
      () => "started",
      (e: Error) => e.message,
    );
    const worker = FakeWorker.made[0]!;
    await vi.advanceTimersByTimeAsync(2_999);
    expect(worker.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(settled).resolves.toBe("The voting module's worker didn't load within 3 seconds, so nothing was sent to it.");
    expect(worker.terminated).toBe(true);
    expect(worker.sent).toEqual([]);
  });

  it("starts as before once the worker has loaded, with 30 seconds for the module from then", async () => {
    vi.useFakeTimers();
    const { startVoterModule } = await import("./module");
    const started = startVoterModule();
    const worker = FakeWorker.made[0]!;
    await vi.advanceTimersByTimeAsync(2_000);
    worker.reply({ type: "loaded" });
    expect(worker.sent).toEqual([START]);
    // Past the 3 seconds for loading: the module's own start has 30.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(worker.terminated).toBe(false);
    worker.reply({ type: "started", timings: TIMINGS });
    await expect(started).resolves.toMatchObject({ timings: TIMINGS });
    expect(worker.terminated).toBe(false);
  });

  it("still fails when the module hasn't started 30 seconds after the worker loaded", async () => {
    vi.useFakeTimers();
    const { startVoterModule } = await import("./module");
    const settled = startVoterModule().then(
      () => "started",
      (e: Error) => e.message,
    );
    const worker = FakeWorker.made[0]!;
    worker.reply({ type: "loaded" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(worker.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(settled).resolves.toBe("The voting module didn't start within 30 seconds.");
    expect(worker.terminated).toBe(true);
  });
});

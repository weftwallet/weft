/**
 * The voting module's worker loads from the extension's own origin, its own
 * file /idemix-worker.js, in every build: in a dev build the page's scripts
 * come from the Vite dev server, and the browser refuses a worker from
 * another origin. A worker that fails to load fails the start at once.
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
  terminate() {
    this.terminated = true;
  }
}

beforeEach(() => {
  FakeWorker.made = [];
  vi.stubGlobal("Worker", FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    expect(worker.sent).toEqual([
      { type: "start", wasmUrl: "chrome-extension://weft/idemix/weft-idemix.wasm", wasmExecUrl: "chrome-extension://weft/idemix/wasm_exec.js" },
    ]);
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
});

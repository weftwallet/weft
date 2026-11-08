/**
 * Where the indexer runs its ballot checks (ballot-checks.ts). The explorer
 * uses a pool of worker threads (check-worker.ts), so checking a block's
 * ballots, each a few dozen milliseconds of proofs and, with voter
 * credentials, the idemix module's checks, doesn't hold up the server's
 * answers: the main thread only posts each ballot and stores the result. Each
 * thread starts its own idemix module when the explorer has private
 * elections. inlineChecker runs the same checks in the calling thread, for
 * the tests and for WEFT_EXPLORER_CHECK_THREADS=0.
 */

import { Worker } from "node:worker_threads";
import type { IdemixSync } from "@weftwallet/idemix";
import { electionCache, runBallotTask, type BallotResult, type BallotTask } from "./ballot-checks.ts";
import { defaultThreads } from "./config.ts";

export interface BallotChecker {
  check(task: BallotTask): Promise<BallotResult>;
  close(): Promise<void>;
}

const inline = new WeakMap<object, BallotChecker>();
const NO_IDEMIX = {};
/** The checks in the calling thread, with `idemix` started there: one checker per module, so each election's key table is made once. */
export function inlineChecker(idemix: IdemixSync | null): BallotChecker {
  const key = idemix ?? NO_IDEMIX;
  const known = inline.get(key);
  if (known) return known;
  const electionOf = electionCache();
  const checker: BallotChecker = {
    check: async (task) => runBallotTask(task, electionOf, idemix),
    close: async () => {},
  };
  inline.set(key, checker);
  return checker;
}


const fromSource = import.meta.url.endsWith(".ts");
/** The worker's file: the built one, or in the tests and `pnpm dev` the source, which Node runs with its types stripped. */
const WORKER = new URL(fromSource ? "./check-worker.ts" : "./check-worker.js", import.meta.url);
const execArgv = fromSource
  ? [...new Set([...process.execArgv.filter((a) => !a.startsWith("--watch")), "--conditions=weft-source", "--disable-warning=ExperimentalWarning"])]
  : process.execArgv.filter((a) => !a.startsWith("--watch"));

interface Job {
  id: number;
  task: BallotTask;
  resolve: (r: BallotResult) => void;
  reject: (e: Error) => void;
  tries: number;
}

interface Thread {
  worker: Worker;
  jobs: Map<number, Job>;
}

export class CheckPool implements BallotChecker {
  private readonly threads: Thread[] = [];
  private readonly idemixDir: string | null;
  private seq = 0;
  private closed = false;

  private constructor(idemixDir: string | null) {
    this.idemixDir = idemixDir;
  }

  /**
   * Starts `size` threads and waits until each has started (with
   * `idemixDir`, its idemix module). Throws with the first thread's reason
   * when one can't.
   */
  static async start({ size = defaultThreads(), idemixDir = null }: { size?: number; idemixDir?: string | null } = {}): Promise<CheckPool> {
    const pool = new CheckPool(idemixDir);
    try {
      await Promise.all(Array.from({ length: Math.max(1, size) }, () => pool.spawn()));
    } catch (error) {
      await pool.close();
      throw error;
    }
    return pool;
  }

  get size(): number {
    return this.threads.length;
  }

  private spawn(): Promise<Thread> {
    const worker = new Worker(WORKER, { workerData: { idemixDir: this.idemixDir }, execArgv });
    const thread: Thread = { worker, jobs: new Map() };
    this.threads.push(thread);
    return new Promise((resolve, reject) => {
      let ready = false;
      worker.on("message", (m: { type?: string; message?: string; id?: number; result?: BallotResult; error?: string }) => {
        if (!ready) {
          if (m.type === "ready") {
            ready = true;
            return resolve(thread);
          }
          if (m.type === "failed") return reject(new Error(m.message));
        }
        const job = m.id === undefined ? undefined : thread.jobs.get(m.id);
        if (!job) return;
        thread.jobs.delete(job.id);
        if (m.result) job.resolve(m.result);
        else job.reject(new Error(m.error ?? "The check thread gave no result."));
      });
      const gone = (error: Error) => {
        if (!ready) return reject(error);
        this.lost(thread, error);
      };
      worker.on("error", gone);
      worker.on("exit", (code) => {
        if (!this.closed) gone(new Error(`The check thread stopped with exit code ${code}.`));
      });
    });
  }

  /** A thread that stopped: it is replaced, and each of its checks runs again once on another thread. */
  private lost(thread: Thread, error: Error): void {
    const at = this.threads.indexOf(thread);
    if (at < 0) return;
    this.threads.splice(at, 1);
    const jobs = [...thread.jobs.values()];
    thread.jobs.clear();
    void thread.worker.terminate();
    if (this.closed) return jobs.forEach((j) => j.reject(error));
    this.spawn().then(
      () => jobs.forEach((j) => (j.tries < 2 ? this.post(j) : j.reject(error))),
      (again: Error) => jobs.forEach((j) => j.reject(again)),
    );
  }

  private post(job: Job): void {
    const thread = this.threads.reduce((a, b) => (b.jobs.size < a.jobs.size ? b : a));
    job.tries += 1;
    thread.jobs.set(job.id, job);
    thread.worker.postMessage({ id: job.id, task: job.task });
  }

  check(task: BallotTask): Promise<BallotResult> {
    if (this.closed || this.threads.length === 0) return Promise.reject(new Error("The check threads have stopped."));
    return new Promise((resolve, reject) => this.post({ id: ++this.seq, task, resolve, reject, tries: 0 }));
  }

  async close(): Promise<void> {
    this.closed = true;
    const threads = this.threads.splice(0);
    for (const t of threads) for (const j of t.jobs.values()) j.reject(new Error("The explorer is stopping."));
    await Promise.all(threads.map((t) => t.worker.terminate()));
  }
}

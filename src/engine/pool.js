// Host side of the inference engine: fetch + decode on the host (extension page), inference in a
// pool of dedicated workers. Used by the Chrome offscreen document and the Firefox background page.
//
// Scheduling: the fast Stage 1 check of every queued image runs before any slow Stage 2 check,
// so pictures without people (most of a page) are released in ~0.1 s even while photos of
// people are still being examined.
import { IS_MOBILE } from '../shared/browser.js';
import { stage2Parts } from '../shared/policy.js';
import { loadBitmap, SkipImage } from './image-loader.js';

const MAX_PARALLEL_FETCHES = 6;
const PRIORITY_STAGE1 = 0;
const PRIORITY_STAGE2 = 1;

/** Each worker holds every model (~160 MB of JS + WASM heap), so size the pool by memory too. */
export function defaultPoolSize() {
  const cores = navigator.hardwareConcurrency || 4;
  const memory = navigator.deviceMemory; // GB, Chromium only (capped at 8)
  if (IS_MOBILE) return 1;
  if (cores >= 8 && memory >= 8) return 3;
  if (cores >= 4 && (memory === undefined || memory >= 4)) return 2;
  return 1;
}

class EngineWorker {
  constructor(url, onReady) {
    this.url = url;
    this.onReady = onReady;
    this.busy = false;
    this.pending = new Map();
    this.spawn();
  }

  spawn() {
    this.isReady = false;
    this.ready = new Promise((resolve, reject) => {
      this.worker = new Worker(this.url, { type: 'module', name: 'noharam-engine' });
      this.worker.onmessage = ({ data }) => {
        if (data.type === 'ready') {
          if (data.error) reject(new Error(data.error));
          else {
            this.isReady = true;
            this.crashes = 0;
            this.onReady?.(this);
            resolve();
          }
          return;
        }
        const p = this.pending.get(data.id);
        if (!p) return;
        this.pending.delete(data.id);
        if (data.error) p.reject(new Error(data.error));
        else p.resolve(data.result);
      };
      this.worker.onerror = (e) => {
        // A crashed worker (e.g. out of memory) fails its jobs and is replaced, with backoff.
        e.preventDefault?.();
        const err = new Error(`engine worker crashed: ${e.message || 'unknown'}`);
        reject(err); // no-op if it had already loaded
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        this.worker.terminate();
        this.isReady = false; // never hand jobs to the dead worker
        this.crashes = (this.crashes ?? 0) + 1;
        const delay = Math.min(30000, 1000 * 2 ** (this.crashes - 1));
        this.ready = new Promise((r) => setTimeout(r, delay)).then(() => {
          this.spawn();
          return this.ready;
        });
        this.ready.catch(() => {});
      };
    });
    this.ready.catch(() => {});
  }

  run(message, transfer = []) {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...message }, transfer);
    });
  }
}

export class WorkerPool {
  constructor({ size = defaultPoolSize(), workerUrl }) {
    this.size = size;
    this.workerUrl = workerUrl;
    this.waiters = [[], []]; // per priority
    this.fetching = 0;
    this.fetchWaiters = [];
    this.stats = newTimings();
    // Start one worker first: compiling the runtime and loading ~75 MB of models in several
    // workers at once would delay the first answer. The rest start once the first is ready.
    this.workers = [new EngineWorker(workerUrl, () => this.onWorkerReady())];
  }

  onWorkerReady() {
    while (this.workers.length < this.size) this.workers.push(new EngineWorker(this.workerUrl, () => this.wake()));
    this.wake();
  }

  wake() {
    (this.waiters[PRIORITY_STAGE1].shift() ?? this.waiters[PRIORITY_STAGE2].shift())?.();
  }

  async ready() {
    await this.workers[0].ready;
  }

  async acquire(priority) {
    for (;;) {
      // Prefer workers whose models are loaded; while all are still starting, wait on the first.
      const anyReady = this.workers.some((w) => w.isReady);
      // Stage 2 work waits while Stage 1 work is queued (unless several workers are idle).
      const stage1Waiting = priority === PRIORITY_STAGE2 && this.waiters[PRIORITY_STAGE1].length > 0;
      const free = stage1Waiting ? null : this.workers.find((w) => !w.busy && (w.isReady || !anyReady));
      if (free) {
        free.busy = true;
        try {
          await free.ready;
          return free;
        } catch (err) {
          // Models failed to load (every worker loads the same files): fail this job.
          this.release(free);
          throw err;
        }
      }
      await new Promise((resolve) => this.waiters[priority].push(resolve));
    }
  }

  release(worker) {
    worker.busy = false;
    this.wake();
  }

  async withFetchSlot(fn) {
    while (this.fetching >= MAX_PARALLEL_FETCHES) await new Promise((r) => this.fetchWaiters.push(r));
    this.fetching++;
    try {
      return await fn();
    } finally {
      this.fetching--;
      this.fetchWaiters.shift()?.();
    }
  }

  async runOn(priority, message, transfer) {
    const worker = await this.acquire(priority);
    try {
      return await worker.run(message, transfer);
    } finally {
      this.release(worker);
    }
  }

  /** job: { url, dataUrl?, w?, h?, sel, s1?, s2? } -> { s1, s2, faces, aspect, ms } | { skip } | { error, code } */
  async analyze(job) {
    const t0 = performance.now();
    let img;
    try {
      img = await this.withFetchSlot(() => loadBitmap(job));
    } catch (err) {
      if (err instanceof SkipImage) return { skip: err.message };
      this.stats.errors++;
      return { error: err.message, code: err.code || 'decode' };
    }
    const t1 = performance.now();
    const aspect = img.w / img.h;
    const result = { s1: job.s1 ?? null, s2: job.s2 ?? null, faces: 0, aspect, ms: { load: t1 - t0, queue: 0, s1: 0, s2: 0 } };
    let bitmap = img.bitmap;
    try {
      let region = null;
      if (!result.s1) {
        // Stage 1 gets a copy: the original stays here in case Stage 2 needs it.
        const copy = await createImageBitmap(bitmap);
        const tq = performance.now();
        const r1 = await this.runOn(PRIORITY_STAGE1, { phase: 'stage1', bitmap: copy }, [copy]);
        result.ms.queue += performance.now() - tq - r1.ms;
        result.s1 = r1.s1;
        result.ms.s1 = r1.ms;
        region = r1.region;
      }
      const need = stage2Parts(result.s1, job.sel, result.s2);
      if (need) {
        const tq = performance.now();
        const r2 = await this.runOn(PRIORITY_STAGE2, { phase: 'stage2', bitmap, s1: result.s1, region, opts: { need } }, [bitmap]);
        bitmap = null; // transferred
        result.ms.queue += performance.now() - tq - r2.ms;
        result.s2 = { ...result.s2, ...r2.s2 };
        result.faces = r2.faces;
        result.ms.s2 = r2.ms;
      }
      recordTimings(this.stats, result);
      return result;
    } catch (err) {
      this.stats.errors++;
      return { error: err.message, code: 'engine' };
    } finally {
      bitmap?.close();
    }
  }

  status() {
    return { workers: this.workers.length, ...summarizeTimings(this.stats) };
  }
}

export function newTimings() {
  return { jobs: 0, s1jobs: 0, stage2: 0, s1ms: 0, s2ms: 0, errors: 0 };
}

export function recordTimings(stats, result) {
  stats.jobs++;
  if (result.ms.s1) {
    stats.s1jobs++;
    stats.s1ms += result.ms.s1;
  }
  if (result.ms.s2) {
    stats.stage2++;
    stats.s2ms += result.ms.s2;
  }
}

export function summarizeTimings(s) {
  return {
    jobs: s.jobs,
    stage2Share: s.jobs ? s.stage2 / s.jobs : 0,
    avgStage1Ms: s.s1jobs ? s.s1ms / s.s1jobs : 0,
    avgStage2Ms: s.stage2 ? s.s2ms / s.stage2 : 0,
    errors: s.errors,
  };
}

// Where inference runs, per browser:
//   Chrome / Edge (MV3 service worker)  -> offscreen document hosting a worker pool
//   Firefox (MV3 event page with DOM)   -> worker pool directly in the background page
//   Anything else (Chromium forks without chrome.offscreen) -> inline in the service worker
import * as ort from 'onnxruntime-web/wasm';
import { Pipeline } from '../engine/pipeline.js';
import { loadBitmap, SkipImage } from '../engine/image-loader.js';
import { newTimings, recordTimings, summarizeTimings, WorkerPool } from '../engine/pool.js';
import { api } from '../shared/browser.js';

const IS_SERVICE_WORKER = typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope;

export function createExecutor() {
  if (IS_SERVICE_WORKER && api.offscreen?.createDocument) return new OffscreenExecutor();
  if (!IS_SERVICE_WORKER && typeof Worker !== 'undefined') {
    return new PoolExecutor(new WorkerPool({ workerUrl: api.runtime.getURL('engine-worker.js') }));
  }
  return new InlineExecutor();
}

class PoolExecutor {
  constructor(pool) {
    this.kind = 'worker-pool';
    this.pool = pool;
  }

  warmUp() {
    return this.pool.ready();
  }

  analyze(job) {
    return this.pool.analyze(job);
  }

  async status() {
    return { host: this.kind, ...this.pool.status() };
  }
}

class OffscreenExecutor {
  constructor() {
    this.kind = 'offscreen-pool';
    this.creating = null;
  }

  async ensureDocument() {
    if (api.runtime.getContexts) {
      const contexts = await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (contexts.length) return;
    }
    this.creating ??= api.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Runs the on-device image classification models in web workers.',
      })
      .catch((err) => {
        if (!/single offscreen/i.test(String(err?.message))) throw err;
      })
      .finally(() => {
        this.creating = null;
      });
    await this.creating;
  }

  async send(message) {
    for (let attempt = 0; ; attempt++) {
      await this.ensureDocument();
      try {
        return await api.runtime.sendMessage({ target: 'nh-offscreen', ...message });
      } catch (err) {
        // The document may still be loading its script; retry briefly.
        if (attempt >= 5 || !/receiving end|establish connection/i.test(String(err?.message))) throw err;
        await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
      }
    }
  }

  warmUp() {
    return this.ensureDocument(); // the document starts its workers (and loads models) on load
  }

  analyze(job) {
    return this.send({ type: 'analyze', job });
  }

  async status() {
    return { host: this.kind, ...(await this.send({ type: 'status' })) };
  }
}

class InlineExecutor {
  constructor() {
    this.kind = 'inline';
    this.ready = null;
    this.chain = Promise.resolve();
    this.stats = newTimings();
  }

  pipeline() {
    if (!this.ready) {
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmPaths = { wasm: api.runtime.getURL('ort-wasm-simd-threaded.wasm') };
      this.ready = Pipeline.create(ort, (file) => api.runtime.getURL(`models/${file}`));
      this.ready.catch(() => {
        this.ready = null;
      });
    }
    return this.ready;
  }

  warmUp() {
    return this.pipeline();
  }

  async analyze(job) {
    let img;
    try {
      img = await loadBitmap(job);
    } catch (err) {
      if (err instanceof SkipImage) return { skip: err.message };
      this.stats.errors++;
      return { error: err.message, code: err.code || 'decode' };
    }
    // One image at a time: inference shares the service worker thread.
    const run = this.chain.then(async () => {
      try {
        const pipeline = await this.pipeline();
        const result = await pipeline.analyze(img.bitmap, { sel: job.sel, s1: job.s1 ?? null, s2: job.s2 ?? null, aspect: img.w / img.h });
        recordTimings(this.stats, result);
        return result;
      } catch (err) {
        this.stats.errors++;
        return { error: String(err?.message || err), code: 'engine' };
      } finally {
        img.bitmap.close();
      }
    });
    this.chain = run.catch(() => {});
    return run;
  }

  async status() {
    return { host: this.kind, workers: 1, ...summarizeTimings(this.stats) };
  }
}

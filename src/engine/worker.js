// Dedicated inference worker. One single-threaded ONNX Runtime (WASM SIMD) instance per worker:
// multi-threaded WASM needs SharedArrayBuffer/cross-origin isolation, which extension contexts
// and mobile browsers often lack, and on big.LITTLE phones extra threads land on slow cores.
// Parallelism comes from running 1-3 of these workers side by side instead.
import * as ort from 'onnxruntime-web/wasm';
import { Pipeline } from './pipeline.js';

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.logLevel = 'error';
// Object form (not a string prefix) so ORT uses its bundled loader instead of a dynamic import.
ort.env.wasm.wasmPaths = { wasm: new URL('./ort-wasm-simd-threaded.wasm', self.location.href).href };

const ready = Pipeline.create(ort, (file) => new URL(`./models/${file}`, self.location.href).href);

ready.then(
  () => self.postMessage({ type: 'ready' }),
  (err) => self.postMessage({ type: 'ready', error: String(err?.message || err) }),
);

// phase "stage1" (fast check), "stage2" (accurate check) or absent (whole cascade).
self.onmessage = async (event) => {
  const { id, phase, bitmap, opts = {}, s1, region } = event.data;
  try {
    const pipeline = await ready;
    let result;
    if (phase === 'stage1') result = await pipeline.runStage1(bitmap, opts);
    else if (phase === 'stage2') result = await pipeline.runStage2(bitmap, s1, region, opts);
    else result = await pipeline.analyze(bitmap, opts);
    self.postMessage({ type: 'result', id, result });
  } catch (err) {
    self.postMessage({ type: 'result', id, error: String(err?.message || err) });
  } finally {
    bitmap?.close?.(); // free decoded pixels immediately (matters on low-memory phones)
  }
};

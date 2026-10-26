// Chrome/Edge only: MV3 service workers cannot start Web Workers, so this hidden offscreen
// document hosts the inference worker pool and answers the service worker's requests.
import { WorkerPool } from '../engine/pool.js';

const pool = new WorkerPool({ workerUrl: chrome.runtime.getURL('engine-worker.js') });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'nh-offscreen') return false;
  if (msg.type === 'analyze') {
    pool.analyze(msg.job).then(sendResponse, (err) => sendResponse({ error: String(err?.message || err), code: 'engine' }));
    return true;
  }
  if (msg.type === 'status') {
    sendResponse(pool.status());
    return false;
  }
  return false;
});

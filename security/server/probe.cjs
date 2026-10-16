"use strict";
const {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} = require("node:worker_threads");
const { probeMedia } = require("../../lib/security/ring-pilot.cjs");
if (!isMainThread) {
  try {
    parentPort.postMessage({ result: probeMedia(workerData.file) });
  } catch {
    parentPort.postMessage({ error: "MEDIA_PROBE_FAILED" });
  }
}
function probe(file) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { file } });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("MEDIA_PROBE_TIMEOUT"));
    }, 250000);
    worker.once("message", (out) => {
      clearTimeout(timer);
      out.error ? reject(new Error(out.error)) : resolve(out.result);
    });
    worker.once("error", () => {
      clearTimeout(timer);
      reject(new Error("MEDIA_PROBE_FAILED"));
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (code) reject(new Error("MEDIA_PROBE_FAILED"));
    });
  });
}
module.exports = { probe };

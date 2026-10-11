// Creates the object detector the UI talks to. It hides *where* inference runs:
//   1. Web Worker on a GPU backend (WebGPU/WebGL)  - best: fast and the page never blocks
//   2. Main thread on a GPU backend                - when the worker can't use the GPU (e.g. no OffscreenCanvas WebGL)
//   3. Web Worker on WASM/CPU                      - slow, but still keeps the page responsive
// If workers aren't available at all, everything runs on the main thread.

const DEFAULT_ORDER = ["webgpu", "webgl", "wasm", "cpu"];
const GPU_BACKENDS = ["webgpu", "webgl"];

// ?noworker in the URL forces main-thread inference (debugging / testing the fallback path)
const canUseWorker = () =>
  !new URLSearchParams(window.location.search).has("noworker") &&
  typeof Worker !== "undefined" &&
  typeof OffscreenCanvas !== "undefined" &&
  typeof createImageBitmap !== "undefined";

/** Backend order can be forced for debugging: ?backend=cpu  or  ?backend=webgl,wasm */
export const requestedBackendOrder = () => {
  const forced = new URLSearchParams(window.location.search).get("backend");
  return forced ? forced.split(",").map((b) => b.trim()).filter(Boolean) : DEFAULT_ORDER;
};

const createWorkerDetector = (modelUrl, order, onProgress) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./detector.worker.js", import.meta.url), { type: "module" });
    const pending = new Map();
    let nextId = 1;
    let ready = false;

    const failAll = (err) => {
      pending.forEach((p) => p.reject(err));
      pending.clear();
    };

    const request = (message) =>
      new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { resolve: res, reject: rej });
        worker.postMessage({ ...message, id });
      });

    const detector = {
      mode: "worker",
      // Grabs a snapshot of the frame, so the boxes are drawn on the exact frame that was analysed
      // even if inference takes a while. Posting without a transfer list copies the bitmap.
      run: async (source) => {
        const frame = await createImageBitmap(source);
        try {
          const r = await request({ type: "detect", bitmap: frame });
          return { ...r, frame };
        } catch (err) {
          frame.close();
          throw err;
        }
      },
      dispose: () => {
        failAll(new Error("detector disposed"));
        worker.terminate();
      },
    };

    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") {
        if (onProgress) onProgress(m.fraction);
      } else if (m.type === "ready") {
        ready = true;
        detector.backend = m.backend;
        detector.device = m.device;
        detector.inputShape = m.inputShape;
        detector.failures = m.failures;
        resolve(detector);
      } else if (m.type === "init-error") {
        worker.terminate();
        reject(new Error(m.message));
      } else if (m.type === "result") {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (p) p.resolve(m);
      } else if (m.type === "error") {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (p) p.reject(new Error(m.message));
      }
    };

    worker.onerror = (e) => {
      const err = new Error(e.message || "worker error");
      if (!ready) {
        worker.terminate();
        reject(err);
      } else {
        failAll(err);
      }
    };

    worker.postMessage({ type: "init", modelUrl, order });
  });

const createMainThreadDetector = async (modelUrl, order, onProgress) => {
  const engine = await import("./engine"); // loaded lazily so worker users never pull TensorFlow.js into the page
  const ctx = await engine.loadModelWithFallback(modelUrl, order, onProgress);
  return {
    mode: "main",
    backend: ctx.backend,
    device: ctx.device,
    inputShape: ctx.inputShape,
    failures: ctx.failures,
    run: async (source) => ({ ...(await engine.runInference(ctx.net, ctx.inputShape, source)), frame: source }),
    dispose: () => ctx.net.dispose(),
  };
};

/**
 * @param {{modelUrl: string, order?: string[], onProgress?: (fraction: number) => void}} options
 * @returns detector with { mode, backend, inputShape, run(source) => Promise<{boxes, scores, classes, ratios, frame}>, dispose() }
 */
export const createDetector = async ({ modelUrl, order = DEFAULT_ORDER, onProgress }) => {
  const gpu = order.filter((b) => GPU_BACKENDS.includes(b));
  const slow = order.filter((b) => !GPU_BACKENDS.includes(b));

  const attempts = canUseWorker()
    ? [
        ["worker", gpu],
        ["main", gpu],
        ["worker", slow],
      ]
    : [["main", order]];

  const errors = [];
  for (const [where, backends] of attempts) {
    if (backends.length === 0) continue;
    try {
      const create = where === "worker" ? createWorkerDetector : createMainThreadDetector;
      return await create(modelUrl, backends, onProgress);
    } catch (err) {
      errors.push(`${where}[${backends.join(",")}]: ${err.message}`);
      console.warn("Detector attempt failed:", where, backends, err);
    }
  }
  throw new Error(`Could not start the detector (${errors.join(" | ")})`);
};

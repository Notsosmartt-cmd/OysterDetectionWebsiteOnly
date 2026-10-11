// Runs the model off the main thread so a slow backend (WASM/CPU) never freezes the page.
import { loadModelWithFallback, runInference } from "./engine";

let ctx = null;

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === "init") {
    try {
      ctx = await loadModelWithFallback(msg.modelUrl, msg.order, (fraction) =>
        self.postMessage({ type: "progress", fraction })
      );
      self.postMessage({
        type: "ready",
        backend: ctx.backend,
        device: ctx.device,
        inputShape: ctx.inputShape,
        failures: ctx.failures,
      });
    } catch (err) {
      self.postMessage({ type: "init-error", message: String(err && err.message ? err.message : err) });
    }
    return;
  }

  if (msg.type === "detect") {
    try {
      const r = await runInference(ctx.net, ctx.inputShape, msg.bitmap);
      self.postMessage({ type: "result", id: msg.id, ...r }, [
        r.boxes.buffer,
        r.scores.buffer,
        r.classes.buffer,
      ]);
    } catch (err) {
      self.postMessage({ type: "error", id: msg.id, message: String(err && err.message ? err.message : err) });
    } finally {
      msg.bitmap.close();
    }
  }
};

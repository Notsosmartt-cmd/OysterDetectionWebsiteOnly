// Everything that touches TensorFlow.js lives here so it can run either in a Web Worker
// (preferred, keeps the page responsive) or on the main thread (fallback).
import * as tf from "@tensorflow/tfjs";
import "@tensorflow/tfjs-backend-webgl"; // set backend to webgl
import "@tensorflow/tfjs-backend-webgpu";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import wasmPlain from "@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm?url";
import wasmSimd from "@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-simd.wasm?url";
import wasmThreaded from "@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-threaded-simd.wasm?url";
import labels from "./labelsO.json";

const numClass = labels.length;

// Fastest first. Each entry is tried in turn until one loads the model and runs a warm-up.
export const DEFAULT_BACKEND_ORDER = ["webgpu", "webgl", "wasm", "cpu"];

// The .wasm binaries ship with the build; point the WASM backend at them (absolute, so it
// also works from inside a worker). Threads need the page to be cross-origin isolated.
const abs = (url) => new URL(url, self.location.href).href;
setWasmPaths({
  "tfjs-backend-wasm.wasm": abs(wasmPlain),
  "tfjs-backend-wasm-simd.wasm": abs(wasmSimd),
  "tfjs-backend-wasm-threaded-simd.wasm": abs(wasmThreaded),
});

const SOFTWARE_GPU = /swiftshader|llvmpipe|softpipe|software|basic render/i;

/**
 * A "GPU" backend that is really software rendering on the CPU is slower than WASM, so skip it.
 * Returns a short description of the device (for the debug line) or throws if it is not a real GPU.
 */
const checkRealGpu = async (name) => {
  if (name === "webgpu") {
    if (!self.navigator || !self.navigator.gpu) throw new Error("WebGPU not supported by this browser");
    const adapter = await self.navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("no WebGPU adapter");
    if (adapter.isFallbackAdapter) throw new Error("WebGPU adapter is a software fallback");
    const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
    return [info.vendor, info.architecture, info.description].filter(Boolean).join(" ") || "webgpu adapter";
  }
  if (name === "webgl") {
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (!gl) throw new Error("WebGL not available");
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "unknown renderer";
    if (SOFTWARE_GPU.test(renderer)) throw new Error(`WebGL is software rendered (${renderer})`);
    return renderer;
  }
  return "";
};

/**
 * Load the model on the first backend in `order` that works.
 * @returns {{net, inputShape, backend, device, failures}}
 */
export const loadModelWithFallback = async (modelUrl, order, onProgress) => {
  const failures = [];
  for (const name of order) {
    let net = null;
    try {
      if (!tf.findBackendFactory(name)) throw new Error("backend not available");
      const device = await checkRealGpu(name);
      if (!(await tf.setBackend(name))) throw new Error("backend failed to initialise");
      await tf.ready();
      if (tf.getBackend() !== name) throw new Error("backend not selected");

      net = await tf.loadGraphModel(modelUrl, { onProgress });
      const inputShape = net.inputs[0].shape;

      // warming up model (also proves the backend can really run it)
      const dummyInput = tf.ones(inputShape);
      const warmup = net.execute(dummyInput);
      await warmup.data();
      tf.dispose([warmup, dummyInput]);

      return { net, inputShape, backend: name, device, failures };
    } catch (err) {
      failures.push(`${name}: ${err && err.message ? err.message : err}`);
      try {
        if (net) net.dispose();
      } catch (e) {
        /* ignore */
      }
    }
  }
  throw new Error(`No usable backend (${failures.join("; ")})`);
};

/**
 * Preprocess image / frame before forwarded into the model
 * @param {HTMLVideoElement|HTMLImageElement|ImageBitmap} source
 * @param {Number} modelWidth
 * @param {Number} modelHeight
 * @returns input tensor, xRatio and yRatio
 */
const preprocess = (source, modelWidth, modelHeight) => {
  let xRatio, yRatio; // ratios for boxes

  const input = tf.tidy(() => {
    const img = tf.browser.fromPixels(source);

    // padding image to square => [n, m] to [n, n], n > m
    const [h, w] = img.shape.slice(0, 2); // get source width and height
    const maxSize = Math.max(w, h); // get max size
    const imgPadded = img.pad([
      [0, maxSize - h], // padding y [bottom only]
      [0, maxSize - w], // padding x [right only]
      [0, 0],
    ]);

    xRatio = maxSize / w; // update xRatio
    yRatio = maxSize / h; // update yRatio

    return tf.image
      .resizeBilinear(imgPadded, [modelWidth, modelHeight]) // resize frame
      .div(255.0) // normalize
      .expandDims(0); // add batch
  });

  return [input, xRatio, yRatio];
};

/**
 * Run inference + NMS on one frame.
 * @returns {{boxes: Float32Array, scores: Float32Array, classes: Int32Array, ratios: number[]}}
 *   boxes are [y1, x1, y2, x2] in model-input space; plain copies, safe to transfer.
 */
export const runInference = async (net, inputShape, source) => {
  const [modelWidth, modelHeight] = inputShape.slice(1, 3);

  tf.engine().startScope(); // start scoping tf engine
  try {
    const [input, xRatio, yRatio] = preprocess(source, modelWidth, modelHeight);

    const res = net.execute(input); // inference model
    const transRes = res.transpose([0, 2, 1]); // transpose result [b, det, n] => [b, n, det]
    const boxes = tf.tidy(() => {
      const w = transRes.slice([0, 0, 2], [-1, -1, 1]); // get width
      const h = transRes.slice([0, 0, 3], [-1, -1, 1]); // get height
      const x1 = tf.sub(transRes.slice([0, 0, 0], [-1, -1, 1]), tf.div(w, 2)); // x1
      const y1 = tf.sub(transRes.slice([0, 0, 1], [-1, -1, 1]), tf.div(h, 2)); // y1
      return tf
        .concat([y1, x1, tf.add(y1, h), tf.add(x1, w)], 2) // [y1, x1, y2, x2]
        .squeeze();
    });

    const [scores, classes] = tf.tidy(() => {
      const rawScores = transRes.slice([0, 0, 4], [-1, -1, numClass]).squeeze(0); // only squeeze axis 0 to handle 1 class models
      return [rawScores.max(1), rawScores.argMax(1)];
    });

    const nms = await tf.image.nonMaxSuppressionAsync(boxes, scores, 500, 0.5, 0.4); // NMS to filter boxes

    // async reads: sync reads are not allowed on the WebGPU backend
    const [boxesData, scoresData, classesData] = await Promise.all([
      boxes.gather(nms, 0).data(),
      scores.gather(nms, 0).data(),
      classes.gather(nms, 0).data(),
    ]);

    return {
      boxes: new Float32Array(boxesData),
      scores: new Float32Array(scoresData),
      classes: new Int32Array(classesData),
      ratios: [xRatio, yRatio],
    };
  } finally {
    tf.engine().endScope(); // always release GPU/CPU memory, even on error
  }
};

import { renderBoxes } from "./renderBox";
import { predictBoxes } from "./tracker";
import { makeSeekable } from "./remux";

// Video/webcam: how often the model may run. This is a time cap, not "every Nth frame":
// at 30 fps video, 10/s is every 3rd frame, 5/s every 6th, 2/s every 15th, 1.5/s every 20th.
// A slow backend simply runs as fast as it can (never overlapping), below this cap.
// Override while testing with ?detectfps=NN in the URL.
export const DETECTIONS_PER_SECOND = 10;

const detectionsPerSecond = () => {
  const forced = Number(new URLSearchParams(window.location.search).get("detectfps"));
  return forced > 0 ? forced : DETECTIONS_PER_SECOND;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sourceSize = (source) => ({
  width: source.videoWidth || source.naturalWidth || source.width || 0,
  height: source.videoHeight || source.naturalHeight || source.height || 0,
});

// Give the canvas the same shape as the picture (long side = model input size) instead of a square.
// Saved images / recorded videos then keep their proportions, and model-space box coordinates map
// 1:1 onto the canvas, so no extra scaling is needed. Sizes are even because H.264 needs that.
const fitCanvas = (canvas, width, height, longSide) => {
  if (!width || !height) return;
  const k = longSide / Math.max(width, height);
  const w = Math.max(2, Math.round((width * k) / 2) * 2);
  const h = Math.max(2, Math.round((height * k) / 2) * 2);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; // resizing clears the canvas, so only do it when the shape really changed
    canvas.height = h;
  }
};

/**
 * Function run inference and do detection from source (single picture).
 * @param {HTMLImageElement|HTMLVideoElement} source
 * @param {{net: object, inputShape: number[]}} model detector created by createDetector (see detector.js)
 * @param {HTMLCanvasElement} canvasRef canvas reference
 * @param {Function} onComplete function to run after detection process, receives the annotated image data URL
 */
export const detect = async (source, model, canvasRef, onComplete = () => {}) => {
  if (!model.net) return; // model still loading

  let result;
  try {
    result = await model.net.run(source); // inference runs in a worker when possible
  } catch (err) {
    console.error("Error during detection:", err);
    return;
  }

  // draw the exact frame that was analysed, then the boxes on top
  const size = sourceSize(result.frame);
  fitCanvas(canvasRef, size.width, size.height, model.inputShape[1]);
  renderBoxes(canvasRef, result.frame, result.boxes, result.scores, result.classes, [1, 1]);
  if (result.frame !== source && result.frame.close) result.frame.close(); // free the ImageBitmap snapshot

  // pull a new data URL from the canvas
  const baked = canvasRef.toDataURL("image/png");
  onComplete(baked);
};

// Pick a recording format this browser supports. H.264 first: browsers usually encode it in
// hardware, so it costs far less CPU while the model is running. Fall back to webm, then mp4.
const pickRecorderMimeType = () => {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return null;
  const candidates = [
    "video/mp4;codecs=avc1",
    "video/webm;codecs=h264",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || null;
};

/**
 * Live video with detection boxes on top.
 * Two independent loops:
 *   - display: redraws the canvas with every new video frame (smooth), boxes from the latest detection,
 *              moved along with the objects' motion so they don't lag
 *   - detection: runs the model on the newest frame as often as allowed, never overlapping itself
 * @param {HTMLVideoElement} vidSource video source
 * @param {{net: object, inputShape: number[]}} model detector created by createDetector
 * @param {HTMLCanvasElement} canvasRef canvas reference
 */
export const detectVideo = (vidSource, model, canvasRef, setRecordedBlob, onRecordingState = () => {}) => {
  // guard: don't start twice for the same video element
  if (vidSource._detecting) return;
  vidSource._detecting = true;

  let running = true;
  let recorder = null;
  let chunks = [];

  // Record the annotated canvas (video + boxes). When the video ends / the webcam is closed, the finished
  // file is handed to setRecordedBlob and the download button offers it. Recording starts with the first
  // drawn frame: by then the video size is known, and the canvas must keep its shape while recording.
  const startRecorder = () => {
    if (setRecordedBlob) setRecordedBlob(null); // forget the previous recording
    try {
      // Safari/iOS may lack captureStream or support a different container than webm
      const mimeType = setRecordedBlob ? pickRecorderMimeType() : null;
      if (mimeType) {
        const canvasStream = canvasRef.captureStream();
        // 2.5 Mbit/s is plenty for ~960 px video and keeps the recording (held in memory) small
        recorder = new MediaRecorder(canvasStream, { mimeType, videoBitsPerSecond: 2_500_000 });
      }
    } catch (e) {
      console.warn("MediaRecorder not supported or mimeType rejected:", e);
      recorder = null;
    }

    if (recorder) {
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = async () => {
        const rawBlob = new Blob(chunks, { type: recorder.mimeType });
        chunks = []; // the pieces are no longer needed once the blob exists
        onRecordingState("saving");
        const recordedBlob = await makeSeekable(rawBlob); // proper duration + working slider in players
        if (setRecordedBlob) setRecordedBlob(recordedBlob);
        onRecordingState("idle");
      };
      recorder.onerror = (e) => {
        console.error("Recording error:", e.error || e);
        onRecordingState("unavailable");
      };
      recorder.start(1000); // hand over a chunk every second instead of one giant piece at the end
      onRecordingState("recording");
    } else if (setRecordedBlob) {
      onRecordingState("unavailable"); // this browser cannot record the canvas
    }
  };
  let recorderStarted = false;

  // newest two detections (for motion), and the id of the video frame currently on screen
  let latest = null;
  let prev = null;
  let frameStamp = -1;
  let drawHandle = null;
  let useFrameCallback = "requestVideoFrameCallback" in vidSource;
  let lastDraw = performance.now();

  const cancelDraw = () => {
    if (drawHandle === null) return;
    if (useFrameCallback && vidSource.cancelVideoFrameCallback) vidSource.cancelVideoFrameCallback(drawHandle);
    else cancelAnimationFrame(drawHandle);
    drawHandle = null;
  };

  const stopAll = () => {
    running = false;
    cancelDraw();
    try {
      if (recorder && recorder.state !== "inactive") recorder.stop();
    } catch (err) {
      console.warn("Error stopping recorder:", err);
    }
    vidSource._detecting = false;
  };

  // ---- debug overlay (?debug): shows how old the boxes on screen are -------------------------
  const debugHud = new URLSearchParams(window.location.search).has("debug");
  const detectionTimes = [];
  const drawHud = () => {
    const ctx = canvasRef.getContext("2d");
    const nowMs = performance.now();
    while (detectionTimes.length && nowMs - detectionTimes[0] > 3000) detectionTimes.shift();
    const perSecond = detectionTimes.length / 3;
    const age = latest ? Math.round(nowMs - latest.t) : "-";
    const text = `${model.net.backend || "?"} · ${perSecond.toFixed(1)} detections/s · boxes ${age} ms old · ${latest ? latest.scores.length : 0} found`;
    ctx.font = "bold 26px Arial";
    ctx.textBaseline = "top";
    const w = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(0, ctx.canvas.height - 40, w + 20, 40);
    ctx.fillStyle = "#fff";
    ctx.fillText(text, 10, ctx.canvas.height - 34);
  };

  // ---- display loop -------------------------------------------------------------------------
  const draw = (now) => {
    if (!running) return;
    if (vidSource.ended || vidSource.paused) {
      stopAll();
      return;
    }

    // Every call is a new picture: requestVideoFrameCallback fires once per presented video frame, and
    // the fallback fires on every display refresh (redrawing is cheap, about 0.3 ms measured). We do not
    // compare mediaTime / currentTime: they do not advance for every stream type (e.g. canvas streams).
    const stamp = now;
    lastDraw = performance.now();
    if (stamp !== frameStamp) {
      // a new video frame: show it with the boxes moved to where the objects are now
      frameStamp = stamp;
      const size = sourceSize(vidSource);
      if (size.width && !recorder) fitCanvas(canvasRef, size.width, size.height, model.inputShape[1]);
      if (size.width && !recorderStarted) {
        recorderStarted = true;
        fitCanvas(canvasRef, size.width, size.height, model.inputShape[1]);
        startRecorder();
      }
      if (latest) {
        const boxes = predictBoxes(latest, prev, performance.now());
        renderBoxes(canvasRef, vidSource, boxes, latest.scores, latest.classes, [1, 1]);
      } else if (vidSource.readyState >= 2) {
        renderBoxes(canvasRef, vidSource, [], [], [], [1, 1]); // live video before the first detection
      }
      if (debugHud) drawHud();
    }
    schedule();
  };

  const schedule = () => {
    drawHandle = useFrameCallback ? vidSource.requestVideoFrameCallback(draw) : requestAnimationFrame(draw);
  };

  // ---- detection loop -----------------------------------------------------------------------
  const detectLoop = async () => {
    const minInterval = 1000 / detectionsPerSecond();
    let lastStart = 0;
    let lastDetectedStamp = null;

    while (running) {
      // video ended / paused / webcam closed. Checked here as well, because requestVideoFrameCallback
      // stops firing once frames stop, so the display loop alone would never notice.
      if (vidSource.ended || vidSource.paused) {
        stopAll();
        break;
      }
      // Watchdog: a playing, visible video that delivers no frame callbacks (some browsers / stream types)
      // would freeze the display. Switch to redrawing on every display refresh instead.
      if (useFrameCallback && !document.hidden && performance.now() - lastDraw > 1500) {
        console.warn("requestVideoFrameCallback is not firing; redrawing on every display refresh instead");
        cancelDraw();
        useFrameCallback = false;
        schedule();
      }
      // nothing to analyse yet / page hidden / still the same frame as last time
      if (document.hidden || vidSource.readyState < 2 || frameStamp === lastDetectedStamp) {
        await sleep(15);
        continue;
      }
      const wait = lastStart + minInterval - performance.now();
      if (wait > 0) await sleep(wait);
      if (!running) break;

      lastStart = performance.now();
      lastDetectedStamp = frameStamp;
      try {
        const t = performance.now(); // the frame is grabbed right at the start of run()
        const result = await model.net.run(vidSource);
        if (result.frame !== vidSource && result.frame.close) result.frame.close(); // only the boxes are needed
        detectionTimes.push(performance.now());
        prev = latest;
        latest = {
          boxes: result.boxes,
          scores: result.scores,
          classes: result.classes,
          ratios: result.ratios,
          t,
        };
      } catch (err) {
        console.error("Error during detection:", err);
        await sleep(200); // don't spin if something keeps failing
      }
    }
  };

  schedule();
  detectLoop();
};

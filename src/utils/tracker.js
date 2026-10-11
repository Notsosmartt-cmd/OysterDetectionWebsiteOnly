// Detections arrive a little after the frame they describe, and only a few times a second.
// To keep the boxes on moving objects we extrapolate each box from its motion between the last
// two detections. Static boxes are left alone (a dead zone), so resting oysters don't wobble.

export const MAX_LOOKAHEAD_MS = 250; // never extrapolate further than this
const MIN_IOU = 0.3; // how much two boxes must overlap to count as the same object
const DEAD_ZONE = 0.03; // movement below 3% of the box size is treated as "not moving"

// boxes are flat [y1, x1, y2, x2, ...]
const iou = (a, ai, b, bi) => {
  const y1 = Math.max(a[ai], b[bi]);
  const x1 = Math.max(a[ai + 1], b[bi + 1]);
  const y2 = Math.min(a[ai + 2], b[bi + 2]);
  const x2 = Math.min(a[ai + 3], b[bi + 3]);
  const inter = Math.max(0, y2 - y1) * Math.max(0, x2 - x1);
  const areaA = (a[ai + 2] - a[ai]) * (a[ai + 3] - a[ai + 1]);
  const areaB = (b[bi + 2] - b[bi]) * (b[bi + 3] - b[bi + 1]);
  return inter / (areaA + areaB - inter || 1);
};

/**
 * @param {{boxes, scores, classes, t}} latest newest detection (t = when its frame was captured, ms)
 * @param {{boxes, scores, classes, t}|null} prev the detection before it
 * @param {number} now current time in ms (same clock as `t`)
 * @returns {Float32Array} boxes moved to where the objects probably are at `now`
 */
export const predictBoxes = (latest, prev, now) => {
  const boxes = Float32Array.from(latest.boxes);
  if (!prev || prev.scores.length === 0 || latest.scores.length === 0) return boxes;

  const dt = latest.t - prev.t;
  if (dt <= 0 || dt > 1000) return boxes;
  const ahead = Math.min(Math.max(now - latest.t, 0), MAX_LOOKAHEAD_MS, dt * 2);
  if (ahead <= 0) return boxes;

  const used = new Set();
  for (let i = 0; i < latest.scores.length; i++) {
    let best = -1;
    let bestIou = MIN_IOU;
    for (let j = 0; j < prev.scores.length; j++) {
      if (used.has(j) || prev.classes[j] !== latest.classes[i]) continue;
      const v = iou(latest.boxes, i * 4, prev.boxes, j * 4);
      if (v > bestIou) {
        bestIou = v;
        best = j;
      }
    }
    if (best < 0) continue;
    used.add(best);

    const o = i * 4;
    const p = best * 4;
    const dy = (latest.boxes[o] + latest.boxes[o + 2] - prev.boxes[p] - prev.boxes[p + 2]) / 2; // centre movement
    const dx = (latest.boxes[o + 1] + latest.boxes[o + 3] - prev.boxes[p + 1] - prev.boxes[p + 3]) / 2;
    const size = Math.max(latest.boxes[o + 2] - latest.boxes[o], latest.boxes[o + 3] - latest.boxes[o + 1]);
    if (Math.max(Math.abs(dx), Math.abs(dy)) < DEAD_ZONE * size) continue; // resting object: keep it still

    const k = ahead / dt;
    boxes[o] += dy * k;
    boxes[o + 2] += dy * k;
    boxes[o + 1] += dx * k;
    boxes[o + 3] += dx * k;
  }
  return boxes;
};

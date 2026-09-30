/**
 * Smoke test for the face-matching pipeline.
 *
 * Proves the two ONNX models actually discriminate before any of this is wired
 * into attendance: two photos of the same person must score far above the
 * threshold, and two different people far below it.
 *
 *   node scripts/face-smoke-test.mjs
 */

import ort from "onnxruntime-node";
import sharp from "sharp";

const DETECTOR = "models/yunet.onnx";
const RECOGNISER = "models/sface.onnx";

// The canonical ArcFace 112×112 landmark template every aligned crop is mapped onto.
const TEMPLATE = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

// ---------------------------------------------------------------- detection

/** YuNet wants an even-sized input; letterboxing keeps the aspect ratio honest. */
async function loadBgr(path, targetW, targetH) {
  const { data, info } = await sharp(path)
    .resize(targetW, targetH, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const chw = new Float32Array(3 * info.height * info.width);
  const plane = info.height * info.width;
  for (let i = 0; i < plane; i++) {
    // sharp gives RGB; the models were trained on BGR.
    chw[i] = data[i * 3 + 2];
    chw[plane + i] = data[i * 3 + 1];
    chw[2 * plane + i] = data[i * 3];
  }
  return { chw, width: info.width, height: info.height };
}

function decodeYunet(outputs, width, height, scoreThreshold = 0.6) {
  const faces = [];

  for (const stride of [8, 16, 32]) {
    const cls = outputs[`cls_${stride}`].data;
    const obj = outputs[`obj_${stride}`].data;
    const bbox = outputs[`bbox_${stride}`].data;
    const kps = outputs[`kps_${stride}`].data;

    const cols = Math.floor(width / stride);
    const rows = Math.floor(height / stride);

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;
        // YuNet's confidence is the geometric mean of class and objectness.
        const score = Math.sqrt(Math.max(0, cls[idx]) * Math.max(0, obj[idx]));
        if (score < scoreThreshold) continue;

        const cx = (col + bbox[idx * 4]) * stride;
        const cy = (row + bbox[idx * 4 + 1]) * stride;
        const w = Math.exp(bbox[idx * 4 + 2]) * stride;
        const h = Math.exp(bbox[idx * 4 + 3]) * stride;

        const landmarks = [];
        for (let k = 0; k < 5; k++) {
          landmarks.push([
            (col + kps[idx * 10 + k * 2]) * stride,
            (row + kps[idx * 10 + k * 2 + 1]) * stride,
          ]);
        }

        faces.push({ x: cx - w / 2, y: cy - h / 2, w, h, score, landmarks });
      }
    }
  }

  return nms(faces, 0.3);
}

function nms(faces, iouThreshold) {
  const sorted = [...faces].sort((a, b) => b.score - a.score);
  const kept = [];

  for (const face of sorted) {
    let overlaps = false;
    for (const k of kept) {
      const x1 = Math.max(face.x, k.x);
      const y1 = Math.max(face.y, k.y);
      const x2 = Math.min(face.x + face.w, k.x + k.w);
      const y2 = Math.min(face.y + face.h, k.y + k.h);
      const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
      const iou = inter / (face.w * face.h + k.w * k.h - inter);
      if (iou > iouThreshold) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) kept.push(face);
  }
  return kept;
}

// ---------------------------------------------------------------- alignment

/**
 * Closed-form 2D similarity transform (Procrustes) mapping the detected
 * landmarks onto the canonical template — scale, rotation and translation, no
 * shear, so the face is straightened without being distorted.
 */
function similarityTransform(source, destination) {
  const n = source.length;
  const meanS = [0, 0];
  const meanD = [0, 0];
  for (let i = 0; i < n; i++) {
    meanS[0] += source[i][0] / n;
    meanS[1] += source[i][1] / n;
    meanD[0] += destination[i][0] / n;
    meanD[1] += destination[i][1] / n;
  }

  let sxx = 0;
  let num = 0;
  let numRot = 0;
  for (let i = 0; i < n; i++) {
    const px = source[i][0] - meanS[0];
    const py = source[i][1] - meanS[1];
    const qx = destination[i][0] - meanD[0];
    const qy = destination[i][1] - meanD[1];
    sxx += px * px + py * py;
    num += px * qx + py * qy;
    numRot += px * qy - py * qx;
  }

  const a = num / sxx;
  const b = numRot / sxx;
  return {
    a,
    b,
    tx: meanD[0] - (a * meanS[0] - b * meanS[1]),
    ty: meanD[1] - (b * meanS[0] + a * meanS[1]),
  };
}

/** Warps the source image into a 112×112 aligned crop by inverse mapping. */
function warpToTemplate(rgb, srcW, srcH, transform, size = 112) {
  const { a, b, tx, ty } = transform;
  const det = a * a + b * b;
  const out = new Float32Array(3 * size * size);
  const plane = size * size;

  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      // Invert the similarity transform to find the source pixel.
      const dx = u - tx;
      const dy = v - ty;
      const sx = (a * dx + b * dy) / det;
      const sy = (-b * dx + a * dy) / det;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;

      let r = 0;
      let g = 0;
      let bl = 0;
      // Bilinear sample, clamped at the edges.
      for (const [ox, oy, weight] of [
        [0, 0, (1 - fx) * (1 - fy)],
        [1, 0, fx * (1 - fy)],
        [0, 1, (1 - fx) * fy],
        [1, 1, fx * fy],
      ]) {
        const px = Math.min(srcW - 1, Math.max(0, x0 + ox));
        const py = Math.min(srcH - 1, Math.max(0, y0 + oy));
        const o = (py * srcW + px) * 3;
        r += rgb[o] * weight;
        g += rgb[o + 1] * weight;
        bl += rgb[o + 2] * weight;
      }

      const i = v * size + u;
      out[i] = bl; // B
      out[plane + i] = g; // G
      out[2 * plane + i] = r; // R
    }
  }
  return out;
}

// ---------------------------------------------------------------- pipeline

async function embed(detectorSession, recogniserSession, path) {
  const DET_W = 640;
  const DET_H = 640;

  const { chw, width, height } = await loadBgr(path, DET_W, DET_H);
  const detOut = await detectorSession.run({
    input: new ort.Tensor("float32", chw, [1, 3, DET_H, DET_W]),
  });

  const faces = decodeYunet(detOut, DET_W, DET_H);
  if (faces.length === 0) return { error: "no face detected" };

  const best = faces.reduce((a, f) => (f.score > a.score ? f : a));

  // Landmarks come back in detector space; scale them to the original image.
  const original = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const scaleX = original.info.width / DET_W;
  const scaleY = original.info.height / DET_H;
  const landmarks = best.landmarks.map(([x, y]) => [x * scaleX, y * scaleY]);

  const aligned = warpToTemplate(
    original.data,
    original.info.width,
    original.info.height,
    similarityTransform(landmarks, TEMPLATE),
  );

  const recOut = await recogniserSession.run({
    data: new ort.Tensor("float32", aligned, [1, 3, 112, 112]),
  });

  const raw = recOut.fc1.data;
  let norm = 0;
  for (const v of raw) norm += v * v;
  norm = Math.sqrt(norm);

  return {
    descriptor: Float32Array.from(raw, (v) => v / norm),
    faces: faces.length,
    score: best.score,
  };
}

function cosine(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

const detector = await ort.InferenceSession.create(DETECTOR);
const recogniser = await ort.InferenceSession.create(RECOGNISER);

const files = { a1: ".tmp-faces/a1.jpg", a2: ".tmp-faces/a2.jpg", b1: ".tmp-faces/b1.jpg" };
const embeddings = {};

for (const [key, path] of Object.entries(files)) {
  const result = await embed(detector, recogniser, path);
  if (result.error) {
    console.log(`${key}: ${result.error}`);
    continue;
  }
  embeddings[key] = result.descriptor;
  console.log(`${key}: ${result.faces} face(s), best score ${result.score.toFixed(3)}, ${result.descriptor.length}-d descriptor`);
}

console.log("\nCosine similarity (SFace threshold is 0.363):");
const pairs = [
  ["a1", "a2", "same person"],
  ["a1", "b1", "different people"],
  ["a2", "b1", "different people"],
];
for (const [x, y, label] of pairs) {
  if (!embeddings[x] || !embeddings[y]) continue;
  const score = cosine(embeddings[x], embeddings[y]);
  const verdict = score >= 0.363 ? "MATCH" : "no match";
  console.log(`  ${x} ↔ ${y}  ${score.toFixed(4)}  ${verdict.padEnd(9)} (${label})`);
}

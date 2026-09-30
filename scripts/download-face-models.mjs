/**
 * Downloads the face-recognition models.
 *
 * They are not committed — 38 MB of weights does not belong in a git history —
 * so this runs once after cloning, or whenever `models/` is missing.
 *
 *   npm run face:models
 *
 * Both are from the OpenCV Zoo and run entirely on this machine: no image, no
 * face descriptor and no employee photo ever leaves the server.
 */

import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";

const MODELS = [
  {
    file: "yunet.onnx",
    // Face *detection* — finds the face and its five landmarks.
    url: "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    approxBytes: 232_589,
  },
  {
    file: "sface.onnx",
    // Face *recognition* — turns an aligned crop into a 128-d descriptor.
    url: "https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
    approxBytes: 38_696_353,
  },
];

const dir = path.resolve("models");
await mkdir(dir, { recursive: true });

for (const model of MODELS) {
  const target = path.join(dir, model.file);

  try {
    const existing = await stat(target);
    if (existing.size === model.approxBytes) {
      console.log(`  ${model.file.padEnd(14)} already present (${existing.size} bytes)`);
      continue;
    }
    console.log(`  ${model.file.padEnd(14)} wrong size, re-downloading`);
  } catch {
    // Not there yet — fall through and fetch it.
  }

  process.stdout.write(`  ${model.file.padEnd(14)} downloading… `);
  const response = await fetch(model.url);
  if (!response.ok || !response.body) {
    console.error(`FAILED (${response.status})`);
    process.exit(1);
  }
  await pipeline(response.body, createWriteStream(target));
  const written = await stat(target);
  console.log(`${written.size} bytes`);
}

console.log("\nFace models ready. Attendance face matching runs locally on this machine.");

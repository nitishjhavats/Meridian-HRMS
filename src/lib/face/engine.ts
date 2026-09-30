import path from "node:path";
import { access } from "node:fs/promises";
import type { FaceCandidate, FaceDescriptor } from "@/domain/attendance/faceMatch";
import { detectBlink, patchOpenness } from "@/domain/attendance/blink";
import {
  type FaceBox,
  type FrameSize,
  comparableFaces,
  pickPrimary,
  trackPrimary,
} from "@/domain/attendance/primaryFace";

/** The sharp *factory*, not the module namespace -- `import("sharp").default`. */
type SharpLib = (typeof import("sharp"))["default"];

/**
 * Face detection and recognition, running entirely on this server.
 *
 * Two ONNX models from the OpenCV Zoo:
 *   • YuNet  — finds faces and their five landmarks (232 KB)
 *   • SFace  — turns an aligned 112×112 crop into a 128-d descriptor (38 MB)
 *
 * No image, descriptor or employee photo leaves the machine. That matters more
 * than usual here: this is biometric data about employees, and shipping it to a
 * third-party API would be a decision for the customer to make, not a default.
 *
 * Everything is behind the `FaceEngine` interface so a cloud provider could be
 * added later without touching a single service.
 */

export interface FaceEngine {
  readonly available: boolean;
  /**
   * Extracts a descriptor for the primary face in an image: the largest one,
   * not the sharpest. See `domain/attendance/primaryFace` for why.
   */
  describe(image: Buffer): Promise<FaceCandidate>;
  /**
   * The same, over a short burst of frames, with a liveness answer.
   *
   * The descriptor comes from whichever frame has the eyes widest open -- a
   * mid-blink frame is a worse photograph of somebody's identity, and using it
   * would lower the match score for the very people who did as they were asked.
   */
  describeSequence(frames: readonly Buffer[]): Promise<FaceCandidate>;
}

/**
 * The most frames a burst may carry.
 *
 * Each one costs a detector pass. The old note here said eight frames over a
 * second and a half "either contains a blink or the person did not blink" --
 * true about sampling, and wrong about people: sixteen of eighteen marks in one
 * morning were refused `NO_BLINK`, because the prompt appeared 360 ms into a
 * 1.4-second capture and nobody can read an instruction and react that fast.
 *
 * The window is longer now and the prompt comes first; see
 * `domain/attendance/capture.ts`. This cap has to stay at or above
 * `BURST_FRAMES` there, or the extra frames are uploaded and silently dropped.
 */
export const MAX_SEQUENCE_FRAMES = 10;

const DETECTOR_SIZE = 640; // The published YuNet graph has a fixed input.
const CROP_SIZE = 112;

/** Canonical ArcFace landmark template every crop is aligned onto. */
const TEMPLATE: readonly (readonly [number, number])[] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

/**
 * One detector hit: its box and confidence as a `FaceBox`, so the domain can
 * rank it, plus the five landmarks the recogniser aligns on.
 */
interface DetectedFace extends FaceBox {
  landmarks: [number, number][];
}

/**
 * `pickPrimary` and `trackPrimary` are generic over the box they are given and
 * hand the same objects back, so a `DetectedFace` goes in and comes out with
 * its landmarks. The domain does not know about landmarks and should not.
 */
function withLandmarks(box: DetectedFace | null | undefined): DetectedFace | null {
  return box ?? null;
}

/** What one detector pass reports: every face, and the original image's size. */
interface Detection {
  faces: DetectedFace[];
  width: number;
  height: number;
}

// Loaded lazily and kept for the process: creating a session costs ~1s and the
// 38 MB of weights should be paid for once, not per check-in.
type Session = { run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: ArrayLike<number> }>> };

let sessions: { detector: Session; recogniser: Session } | null = null;
let loadFailure: string | null = null;
let loading: Promise<void> | null = null;

function modelPath(file: string): string {
  return path.resolve(process.env.FACE_MODEL_DIR ?? "./models", file);
}

async function loadSessions(): Promise<void> {
  if (sessions || loadFailure) return;

  try {
    const detectorFile = modelPath("yunet.onnx");
    const recogniserFile = modelPath("sface.onnx");
    await access(detectorFile);
    await access(recogniserFile);

    // Imported dynamically so a deployment without the models — or without the
    // native runtime — still boots and simply reports the engine unavailable.
    const ort = await import("onnxruntime-node");

    const [detector, recogniser] = await Promise.all([
      ort.InferenceSession.create(detectorFile),
      ort.InferenceSession.create(recogniserFile),
    ]);

    sessions = {
      detector: detector as unknown as Session,
      recogniser: recogniser as unknown as Session,
    };
  } catch (error) {
    loadFailure =
      error instanceof Error && error.message.includes("ENOENT")
        ? "Face models are missing. Run `npm run face:models` to download them."
        : `Face engine could not start: ${error instanceof Error ? error.message : String(error)}`;
    console.warn(`[face] ${loadFailure}`);
  }
}

function ensureLoaded(): Promise<void> {
  loading ??= loadSessions();
  return loading;
}

// ------------------------------------------------------------------ detection

/**
 * Decodes YuNet's multi-scale heads.
 *
 * One anchor per grid cell at strides 8/16/32; the confidence is the geometric
 * mean of the classification and objectness scores, and box/landmark values are
 * offsets from the cell in stride units.
 */
function decodeDetections(
  outputs: Record<string, { data: ArrayLike<number> }>,
  scoreThreshold: number,
): DetectedFace[] {
  const found: DetectedFace[] = [];

  for (const stride of [8, 16, 32] as const) {
    const cls = outputs[`cls_${stride}`]?.data;
    const obj = outputs[`obj_${stride}`]?.data;
    const bbox = outputs[`bbox_${stride}`]?.data;
    const kps = outputs[`kps_${stride}`]?.data;
    if (!cls || !obj || !bbox || !kps) continue;

    const cols = Math.floor(DETECTOR_SIZE / stride);
    const rows = Math.floor(DETECTOR_SIZE / stride);

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const i = row * cols + col;
        const score = Math.sqrt(Math.max(0, cls[i] ?? 0) * Math.max(0, obj[i] ?? 0));
        if (score < scoreThreshold) continue;

        const cx = (col + (bbox[i * 4] ?? 0)) * stride;
        const cy = (row + (bbox[i * 4 + 1] ?? 0)) * stride;
        const w = Math.exp(bbox[i * 4 + 2] ?? 0) * stride;
        const h = Math.exp(bbox[i * 4 + 3] ?? 0) * stride;

        const landmarks: [number, number][] = [];
        for (let k = 0; k < 5; k++) {
          landmarks.push([
            (col + (kps[i * 10 + k * 2] ?? 0)) * stride,
            (row + (kps[i * 10 + k * 2 + 1] ?? 0)) * stride,
          ]);
        }

        found.push({ score, landmarks, x: cx - w / 2, y: cy - h / 2, w, h });
      }
    }
  }

  return suppressOverlaps(found, 0.3);
}

function suppressOverlaps<T extends { score: number; x: number; y: number; w: number; h: number }>(
  boxes: T[],
  iouThreshold: number,
): T[] {
  const kept: T[] = [];
  for (const box of [...boxes].sort((a, b) => b.score - a.score)) {
    const overlaps = kept.some((k) => {
      const x1 = Math.max(box.x, k.x);
      const y1 = Math.max(box.y, k.y);
      const x2 = Math.min(box.x + box.w, k.x + k.w);
      const y2 = Math.min(box.y + box.h, k.y + k.h);
      const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
      return intersection / (box.w * box.h + k.w * k.h - intersection) > iouThreshold;
    });
    if (!overlaps) kept.push(box);
  }
  return kept;
}

// ------------------------------------------------------------------ alignment

interface SimilarityTransform {
  a: number;
  b: number;
  tx: number;
  ty: number;
}

/**
 * Closed-form 2D Procrustes fit: scale, rotation and translation only.
 *
 * Allowing shear would let a stretched photo of the wrong person be squashed
 * into the template, which is precisely what we are trying to detect.
 */
function similarityTransform(
  source: readonly (readonly [number, number])[],
  destination: readonly (readonly [number, number])[],
): SimilarityTransform {
  const n = source.length;
  let meanSx = 0;
  let meanSy = 0;
  let meanDx = 0;
  let meanDy = 0;

  for (let i = 0; i < n; i++) {
    meanSx += (source[i]![0]) / n;
    meanSy += (source[i]![1]) / n;
    meanDx += (destination[i]![0]) / n;
    meanDy += (destination[i]![1]) / n;
  }

  let variance = 0;
  let dot = 0;
  let cross = 0;
  for (let i = 0; i < n; i++) {
    const px = source[i]![0] - meanSx;
    const py = source[i]![1] - meanSy;
    const qx = destination[i]![0] - meanDx;
    const qy = destination[i]![1] - meanDy;
    variance += px * px + py * py;
    dot += px * qx + py * qy;
    cross += px * qy - py * qx;
  }

  if (variance === 0) return { a: 1, b: 0, tx: 0, ty: 0 };

  const a = dot / variance;
  const b = cross / variance;
  return {
    a,
    b,
    tx: meanDx - (a * meanSx - b * meanSy),
    ty: meanDy - (b * meanSx + a * meanSy),
  };
}

/** Inverse-maps the template grid back into the source image, bilinearly sampled. */
function warpToCrop(
  rgb: Buffer,
  srcWidth: number,
  srcHeight: number,
  transform: SimilarityTransform,
): Float32Array {
  const { a, b, tx, ty } = transform;
  const determinant = a * a + b * b;
  const out = new Float32Array(3 * CROP_SIZE * CROP_SIZE);
  const plane = CROP_SIZE * CROP_SIZE;

  for (let v = 0; v < CROP_SIZE; v++) {
    for (let u = 0; u < CROP_SIZE; u++) {
      const dx = u - tx;
      const dy = v - ty;
      const sx = (a * dx + b * dy) / determinant;
      const sy = (-b * dx + a * dy) / determinant;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;

      let r = 0;
      let g = 0;
      let bl = 0;
      const corners: [number, number, number][] = [
        [0, 0, (1 - fx) * (1 - fy)],
        [1, 0, fx * (1 - fy)],
        [0, 1, (1 - fx) * fy],
        [1, 1, fx * fy],
      ];
      for (const [ox, oy, weight] of corners) {
        const px = Math.min(srcWidth - 1, Math.max(0, x0 + ox));
        const py = Math.min(srcHeight - 1, Math.max(0, y0 + oy));
        const o = (py * srcWidth + px) * 3;
        r += (rgb[o] ?? 0) * weight;
        g += (rgb[o + 1] ?? 0) * weight;
        bl += (rgb[o + 2] ?? 0) * weight;
      }

      // SFace was trained on BGR.
      const i = v * CROP_SIZE + u;
      out[i] = bl;
      out[plane + i] = g;
      out[2 * plane + i] = r;
    }
  }

  return out;
}

// ------------------------------------------------------------------ liveness

/** Patch size the eye crop is normalised to before it is scored. */
const EYE_PATCH_W = 32;
const EYE_PATCH_H = 16;

/**
 * How open both eyes are in one frame, as a fraction of the patch height.
 *
 * The two eyes are averaged rather than taken separately: a single eye can be
 * hidden by a fringe or a glare spot for the whole capture, and one steady eye
 * plus one blinking one is still a blink.
 *
 * Returns 0 when neither patch has any contrast, which `detectBlink` reads as
 * "could not tell" once the whole series looks like that.
 */
async function frameOpenness(
  sharpLib: SharpLib,
  image: Buffer,
  landmarks: readonly [number, number][],
  width: number,
  height: number,
): Promise<number> {
  const right = landmarks[0];
  const left = landmarks[1];
  if (!right || !left) return 0;

  // Everything is sized from the distance between the eyes, so the patch covers
  // the same part of the face whether somebody is near the camera or far from
  // it. A fixed pixel size would be a different feature at every distance.
  const interocular = Math.hypot(left[0] - right[0], left[1] - right[1]);
  if (!Number.isFinite(interocular) || interocular < 8) return 0;

  const boxW = Math.round(interocular * 0.5);
  const boxH = Math.round(interocular * 0.32);
  if (boxW < 4 || boxH < 4) return 0;

  const readings: number[] = [];
  for (const [cx, cy] of [right, left]) {
    const leftEdge = Math.round(cx - boxW / 2);
    const topEdge = Math.round(cy - boxH / 2);
    // Wholly inside the frame, or not measured at all -- a clamped crop would
    // silently score a different part of the face.
    if (leftEdge < 0 || topEdge < 0 || leftEdge + boxW > width || topEdge + boxH > height) continue;

    try {
      const gray = await sharpLib(image)
        .extract({ left: leftEdge, top: topEdge, width: boxW, height: boxH })
        .greyscale()
        .resize(EYE_PATCH_W, EYE_PATCH_H, { fit: "fill" })
        .raw()
        .toBuffer();
      const openness = patchOpenness(gray, EYE_PATCH_W, EYE_PATCH_H);
      if (openness > 0) readings.push(openness);
    } catch {
      // A crop that will not decode is one missing reading, not a failed check.
    }
  }

  if (readings.length === 0) return 0;
  return readings.reduce((sum, v) => sum + v, 0) / readings.length;
}

// ------------------------------------------------------------------ engine

class OnnxFaceEngine implements FaceEngine {
  get available(): boolean {
    return sessions !== null;
  }

  /**
   * One detector pass: every face in the frame, box and five landmarks in the
   * coordinates of the original image.
   *
   * Every face, deliberately. This used to keep the single highest-scoring
   * detection, and on a shop floor that was often a bystander's sharp, well-lit
   * head at the back: sixteen "several faces" refusals and four "no match" at
   * 0.02-0.33 in one week, from people whose good marks score 0.73-0.77. Which
   * face is the employee is geometry, and `domain/attendance/primaryFace`
   * answers it; this method only reports what it saw.
   *
   * Split out of `describe` so a burst can pay for detection per frame while
   * paying for recognition -- the 38 MB half -- exactly once.
   */
  private async detect(
    image: Buffer,
    sharpLib: SharpLib,
    ort: typeof import("onnxruntime-node"),
  ): Promise<Detection | null> {
    if (!sessions) return null;

    const detectorInput = await sharpLib(image)
      .resize(DETECTOR_SIZE, DETECTOR_SIZE, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const plane = DETECTOR_SIZE * DETECTOR_SIZE;
    const chw = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      chw[i] = detectorInput.data[i * 3 + 2] ?? 0;
      chw[plane + i] = detectorInput.data[i * 3 + 1] ?? 0;
      chw[2 * plane + i] = detectorInput.data[i * 3] ?? 0;
    }

    const detections = await sessions.detector.run({
      input: new ort.Tensor("float32", chw, [1, 3, DETECTOR_SIZE, DETECTOR_SIZE]),
    });

    const faces = decodeDetections(detections, 0.6);
    if (faces.length === 0) return null;

    const meta = await sharpLib(image).metadata();
    const width = meta.width ?? DETECTOR_SIZE;
    const height = meta.height ?? DETECTOR_SIZE;

    // Scaled back onto the full-resolution original: the detector input
    // distorts the aspect ratio, so its coordinates are not the image's. The
    // boxes are scaled too, because the domain ranks faces by box area and
    // centre in the image the person was actually photographed in.
    const scaleX = width / DETECTOR_SIZE;
    const scaleY = height / DETECTOR_SIZE;

    return {
      faces: faces.map((face) => ({
        score: face.score,
        x: face.x * scaleX,
        y: face.y * scaleY,
        w: face.w * scaleX,
        h: face.h * scaleY,
        landmarks: face.landmarks.map(([x, y]) => [x * scaleX, y * scaleY] as [number, number]),
      })),
      width,
      height,
    };
  }

  /** Aligns and runs the recogniser. The expensive half, called once. */
  private async encode(
    image: Buffer,
    landmarks: readonly [number, number][],
    sharpLib: SharpLib,
    ort: typeof import("onnxruntime-node"),
  ): Promise<FaceDescriptor | null> {
    if (!sessions) return null;

    const original = await sharpLib(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const crop = warpToCrop(
      original.data,
      original.info.width,
      original.info.height,
      similarityTransform(landmarks, TEMPLATE),
    );

    const recognised = await sessions.recogniser.run({
      data: new ort.Tensor("float32", crop, [1, 3, CROP_SIZE, CROP_SIZE]),
    });

    const raw = recognised.fc1?.data;
    if (!raw) return null;

    // L2-normalise so downstream comparison is a plain dot product.
    let norm = 0;
    for (let i = 0; i < raw.length; i++) norm += (raw[i] as number) ** 2;
    norm = Math.sqrt(norm) || 1;

    return Array.from({ length: raw.length }, (_, i) => (raw[i] as number) / norm);
  }

  async describe(image: Buffer): Promise<FaceCandidate> {
    const empty: FaceCandidate = { descriptor: null, faceCount: 0, detectionScore: 0 };

    await ensureLoaded();
    if (!sessions) {
      return { ...empty, engineError: loadFailure ?? "Face engine unavailable" };
    }

    try {
      const [sharpLib, ort] = await Promise.all([
        import("sharp").then((m) => m.default),
        import("onnxruntime-node"),
      ]);

      const found = await this.detect(image, sharpLib, ort);
      if (!found) return empty;

      // The employee is the largest face, and only faces of comparable size
      // count against them; a head at the back is a bystander, not a second
      // person at the camera.
      const frame: FrameSize = { width: found.width, height: found.height };
      const primary = withLandmarks(pickPrimary(found.faces, frame));
      if (!primary) return empty;
      const faceCount = comparableFaces(found.faces, primary);
      const bystanderCount = found.faces.length - faceCount;

      const descriptor = await this.encode(image, primary.landmarks, sharpLib, ort);
      if (!descriptor) return { ...empty, engineError: "Recogniser returned no descriptor" };

      // Deliberately no `blinked`: a single frame cannot answer it, and saying
      // `false` here would refuse every caller that has not moved to a burst.
      return { descriptor, faceCount, detectionScore: primary.score, bystanderCount };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[face] describe failed", message);
      return { ...empty, engineError: message };
    }
  }

  async describeSequence(frames: readonly Buffer[]): Promise<FaceCandidate> {
    const empty: FaceCandidate = { descriptor: null, faceCount: 0, detectionScore: 0 };

    if (frames.length === 0) return empty;
    if (frames.length === 1) return this.describe(frames[0] as Buffer);

    await ensureLoaded();
    if (!sessions) {
      return { ...empty, engineError: loadFailure ?? "Face engine unavailable" };
    }

    try {
      const [sharpLib, ort] = await Promise.all([
        import("sharp").then((m) => m.default),
        import("onnxruntime-node"),
      ]);

      const used = frames.slice(0, MAX_SEQUENCE_FRAMES);

      // Detection first, for every frame, so the burst can be followed as one
      // person before any single frame is judged. A burst comes from one
      // camera at one size, so the first frame with a face sets the frame.
      const detected: (Detection | null)[] = [];
      for (const frame of used) detected.push(await this.detect(frame, sharpLib, ort));
      const sized = detected.find((d) => d !== null);
      if (!sized) return { ...empty, blinked: null };

      const track = trackPrimary(
        detected.map((d) => d?.faces ?? []),
        { width: sized.width, height: sized.height },
      );
      if (track.anchor === -1) return { ...empty, blinked: null };

      const openness: number[] = [];
      let bestFrame: { image: Buffer; landmarks: [number, number][]; score: number } | null = null;
      let bestOpenness = -1;
      let framesWithAFace = 0;

      for (let i = 0; i < used.length; i++) {
        const frame = used[i] as Buffer;
        const found = detected[i] ?? null;
        // The frame's detection that continues the anchor. A frame where the
        // employee was lost and only the neighbour was found yields null here,
        // never the neighbour; it goes into the series as a no-face frame, the
        // same as a hand over the lens, and cannot contribute a reading.
        const primary = withLandmarks(track.primaries[i]);
        if (!found) {
          openness.push(0);
          continue;
        }
        if (!primary) {
          // A face was seen but it was not the tracked person -- or the
          // person moved more than half a face-width in one frame. A zero
          // here would read as a full blink (`detectBlink` takes the lowest
          // reading as the trough), so the frame is marked unreadable and
          // left out of the series instead.
          openness.push(-1);
          continue;
        }

        framesWithAFace++;

        const open = await frameOpenness(
          sharpLib,
          frame,
          primary.landmarks,
          found.width,
          found.height,
        );
        openness.push(open);

        if (open > bestOpenness) {
          bestOpenness = open;
          bestFrame = { image: frame, landmarks: primary.landmarks, score: primary.score };
        }
      }

      if (!bestFrame || framesWithAFace === 0) return { ...empty, blinked: null };

      const descriptor = await this.encode(bestFrame.image, bestFrame.landmarks, sharpLib, ort);
      if (!descriptor) return { ...empty, engineError: "Recogniser returned no descriptor" };

      // `faceCount` is the worst tracked frame's count of faces as close to
      // the camera as the tracked person, that person included; heads at the
      // back are `bystanderCount` and never refuse anybody. Still the worst
      // frame rather than the average: somebody else stepping up to the phone
      // for one frame is exactly the thing `rejectMultipleFaces` exists to
      // catch.
      return {
        descriptor,
        faceCount: track.faceCount,
        detectionScore: bestFrame.score,
        bystanderCount: track.bystanders,
        blinked: detectBlink(openness).blinked,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[face] describeSequence failed", message);
      return { ...empty, engineError: message };
    }
  }
}

/** Used when face matching is switched off, or the models are absent. */
class UnavailableFaceEngine implements FaceEngine {
  readonly available = false;
  async describe(): Promise<FaceCandidate> {
    return {
      descriptor: null,
      faceCount: 0,
      detectionScore: 0,
      engineError: "Face matching is not configured on this server.",
    };
  }
  // Same answer for a burst. Deliberately not `blinked: false`: the engine did
  // not look, so it must not report that somebody failed to blink.
  describeSequence(): Promise<FaceCandidate> {
    return this.describe();
  }
}

let engine: FaceEngine | null = null;

export function faceEngine(): FaceEngine {
  if (engine) return engine;
  engine = process.env.FACE_MATCHING === "off" ? new UnavailableFaceEngine() : new OnnxFaceEngine();
  return engine;
}

/** Exposed for tests. */
export function setFaceEngine(next: FaceEngine | null): void {
  engine = next;
}

/** Warms the models so the first check-in of the day is not the slow one. */
export async function warmFaceEngine(): Promise<boolean> {
  await ensureLoaded();
  return sessions !== null;
}

export interface FaceEngineState {
  /** `FACE_MATCHING=off` — a deliberate choice by whoever set the environment. */
  switchedOff: boolean;
  /** Whether both ONNX sessions exist right now. */
  modelsLoaded: boolean;
  /** Why they do not, when they do not. Never a path or a stack. */
  reason: string | null;
}

/**
 * Whether the face check is actually running, from outside the process.
 *
 * This is the one thing about round 4 that nothing outside the container could
 * see. If ONNX fails to load, `evaluateFaceMatch` treats it as the system's
 * fault and lets attendance through — which is right, because refusing everyone
 * at the door because a model file is missing is worse — but it means the
 * security control that round existed to add can be silently absent, with the
 * only trace a line in a boot log that is lost on the next deploy.
 *
 * It loads the models if nothing has yet, so the answer is "can they load"
 * rather than "has somebody happened to check in today". `ensureLoaded` is
 * memoised, so this costs a second once per process and nothing afterwards.
 */
export async function faceEngineState(): Promise<FaceEngineState> {
  if (process.env.FACE_MATCHING === "off") {
    return { switchedOff: true, modelsLoaded: false, reason: "FACE_MATCHING is set to off." };
  }
  await ensureLoaded();
  return {
    switchedOff: false,
    modelsLoaded: sessions !== null,
    reason: sessions !== null ? null : (loadFailure ?? "The face engine did not start."),
  };
}

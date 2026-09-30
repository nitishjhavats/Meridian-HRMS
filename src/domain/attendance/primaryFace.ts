/**
 * Which face in the frame is the person marking attendance.
 *
 * Measured on a live organisation over one week: sixteen refusals for
 * "several faces in shot" and four for "no match" at similarity 0.02–0.33,
 * all from the same handful of people whose good marks score 0.73–0.77. The
 * shop floor has other people in it. The engine kept whichever detection had
 * the highest *confidence* -- often a bystander's sharp, well-lit head at the
 * back -- counted every detection as a face, and once described the
 * bystander instead of the employee, which is where 0.02 came from.
 *
 * The person holding the phone is the largest face in the frame, and stays
 * the largest across the burst. So: the primary is the largest box (a near
 * tie goes to the one nearest the centre); a second face counts only when it
 * is of comparable size, because a head at a third of the area is somebody
 * behind, not somebody else at the camera; and across a burst the primary is
 * anchored to the frame where it was largest, so a frame in which the
 * employee is momentarily lost yields nothing rather than promoting the
 * neighbour.
 *
 * Pure geometry on detector boxes; no pixels here.
 */

export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

export interface FrameSize {
  width: number;
  height: number;
}

/** A second face counts only at this share of the primary's box area or more. */
export const BYSTANDER_AREA_RATIO = 0.5;
/** A frame continues the track only when a detection overlaps the anchor this much. */
export const TRACK_MIN_IOU = 0.3;
/** Boxes within this ratio of each other's area are a tie, settled by centrality. */
export const TIE_AREA_RATIO = 0.9;

export function boxArea(box: FaceBox): number {
  return Math.max(0, box.w) * Math.max(0, box.h);
}

export function iou(a: FaceBox, b: FaceBox): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = boxArea(a) + boxArea(b) - inter;
  return union <= 0 ? 0 : inter / union;
}

/** Distance from the box centre to the frame centre, in pixels. */
export function centreDistance(box: FaceBox, frame: FrameSize): number {
  const dx = box.x + box.w / 2 - frame.width / 2;
  const dy = box.y + box.h / 2 - frame.height / 2;
  return Math.sqrt(dx * dx + dy * dy);
}

/** The largest face; within `TIE_AREA_RATIO` of each other, the more central one. */
export function pickPrimary<T extends FaceBox>(faces: readonly T[], frame: FrameSize): T | null {
  let best: T | null = null;
  for (const face of faces) {
    if (!best) {
      best = face;
      continue;
    }
    const a = boxArea(face);
    const b = boxArea(best);
    const tie = Math.min(a, b) >= Math.max(a, b) * TIE_AREA_RATIO;
    if (tie ? centreDistance(face, frame) < centreDistance(best, frame) : a > b) best = face;
  }
  return best;
}

/** How many faces are as much "at the camera" as the primary, the primary included. */
export function comparableFaces(faces: readonly FaceBox[], primary: FaceBox): number {
  const floor = boxArea(primary) * BYSTANDER_AREA_RATIO;
  return faces.filter((face) => face === primary || boxArea(face) >= floor).length;
}

export interface PrimaryTrack<T extends FaceBox = FaceBox> {
  /** Index of the frame whose primary is the largest of the burst; -1 when no frame had a face. */
  anchor: number;
  /** Per frame: the detection that continues the anchor, or null when the person was not seen. */
  primaries: (T | null)[];
  /** The worst tracked frame's count of comparable faces (the primary included). */
  faceCount: number;
  /** The worst tracked frame's count of faces ignored as background. */
  bystanders: number;
}

/**
 * Follows one person through a burst.
 *
 * The anchor is the largest primary of any frame, and every other frame is
 * asked for the detection that overlaps it best. A frame whose detections do
 * not overlap the anchor at all -- the employee turned away and only the
 * neighbour was found -- contributes `null`, never the neighbour. `faceCount`
 * is the worst frame rather than the average, as before: a second person who
 * appears for one frame is exactly what `rejectMultipleFaces` is for.
 */
export function trackPrimary<T extends FaceBox>(
  frames: readonly (readonly T[])[],
  frame: FrameSize,
): PrimaryTrack<T> {
  const perFrame = frames.map((faces) => pickPrimary(faces, frame));
  let anchor = -1;
  for (let i = 0; i < perFrame.length; i++) {
    const candidate = perFrame[i];
    if (!candidate) continue;
    const current = anchor === -1 ? null : perFrame[anchor];
    if (!current || boxArea(candidate) > boxArea(current)) anchor = i;
  }
  if (anchor === -1) {
    return { anchor, primaries: frames.map(() => null), faceCount: 0, bystanders: 0 };
  }

  const anchorBox = perFrame[anchor] as T;
  let faceCount = 0;
  let bystanders = 0;
  const primaries = frames.map((faces, i) => {
    let tracked: T | null = null;
    let bestOverlap = 0;
    for (const face of faces) {
      const overlap = i === anchor && face === anchorBox ? 1 : iou(face, anchorBox);
      if (overlap >= TRACK_MIN_IOU && overlap > bestOverlap) {
        bestOverlap = overlap;
        tracked = face;
      }
    }
    if (!tracked) return null;
    const comparable = comparableFaces(faces, tracked);
    faceCount = Math.max(faceCount, comparable);
    bystanders = Math.max(bystanders, faces.length - comparable);
    return tracked;
  });

  return { anchor, primaries, faceCount, bystanders };
}

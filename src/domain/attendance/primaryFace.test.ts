import { describe, expect, it } from "vitest";

import {
  BYSTANDER_AREA_RATIO,
  type FaceBox,
  comparableFaces,
  iou,
  pickPrimary,
  trackPrimary,
} from "./primaryFace";

const frame = { width: 960, height: 960 };
const box = (x: number, y: number, size: number, score = 0.9): FaceBox => ({ x, y, w: size, h: size, score });

// The employee, near the centre; a bystander behind, sharp but small.
const me = box(280, 240, 400);
const behind = box(760, 120, 120, 0.99);

describe("the primary face", () => {
  it("is the largest, not the sharpest", () => {
    expect(pickPrimary([behind, me], frame)).toBe(me);
  });

  it("goes to the more central face when two are nearly the same size", () => {
    const centred = box(300, 300, 370);
    const edge = box(0, 0, 380);
    expect(pickPrimary([edge, centred], frame)).toBe(centred);
    // Outside the tie band size wins again.
    const bigger = box(0, 0, 440);
    expect(pickPrimary([bigger, centred], frame)).toBe(bigger);
  });

  it("is null in an empty frame", () => {
    expect(pickPrimary([], frame)).toBeNull();
  });
});

describe("a second face", () => {
  it("does not count when it is a head in the background", () => {
    // 120² / 400² = 9 % of the primary: somebody three metres back.
    expect(comparableFaces([me, behind], me)).toBe(1);
  });

  it("counts when it is as much at the camera as the primary", () => {
    const beside = box(0, 240, 300); // 56 % of the primary's area
    expect(comparableFaces([me, beside], me)).toBe(2);
    expect(BYSTANDER_AREA_RATIO).toBe(0.5);
  });

  it("is judged on the ratio, not the absolute size", () => {
    const smallMe = box(400, 400, 100);
    const smallBystander = box(0, 0, 60); // 36 %
    expect(comparableFaces([smallMe, smallBystander], smallMe)).toBe(1);
  });
});

describe("tracking the primary through a burst", () => {
  it("anchors on the frame where the person is largest and follows them", () => {
    const track = trackPrimary(
      [
        [me, behind],
        [box(284, 236, 404), behind],
        [box(276, 244, 396), behind],
      ],
      frame,
    );
    expect(track.anchor).toBe(1);
    expect(track.primaries.every((p) => p !== null)).toBe(true);
    expect(track.faceCount).toBe(1);
    expect(track.bystanders).toBe(1);
  });

  it("does not promote the bystander when the person is lost for a frame", () => {
    // Frame 1: only the neighbour is detected. The old engine would have
    // described that face and scored the match at 0.02.
    const track = trackPrimary([[me, behind], [behind], [me]], frame);
    expect(track.primaries[1]).toBeNull();
    expect(track.primaries[0]).toBe(me);
    expect(track.primaries[2]).toBe(me);
  });

  it("reports the worst frame's face count, not the average", () => {
    const beside = box(0, 240, 300);
    const track = trackPrimary([[me], [me, beside], [me]], frame);
    expect(track.faceCount).toBe(2);
  });

  it("is empty when no frame had a face", () => {
    const track = trackPrimary([[], []], frame);
    expect(track.anchor).toBe(-1);
    expect(track.primaries).toEqual([null, null]);
    expect(track.faceCount).toBe(0);
  });

  it("agrees with pickPrimary for a single frame", () => {
    const track = trackPrimary([[behind, me]], frame);
    expect(track.primaries[0]).toBe(pickPrimary([behind, me], frame));
  });
});

describe("iou", () => {
  it("is 1 for the same box, 0 for disjoint boxes, and symmetric", () => {
    expect(iou(me, me)).toBe(1);
    expect(iou(me, behind)).toBe(0);
    const shifted = box(480, 240, 400);
    expect(iou(me, shifted)).toBeCloseTo(iou(shifted, me));
    expect(iou(me, shifted)).toBeCloseTo(0.5 / 1.5);
  });
});

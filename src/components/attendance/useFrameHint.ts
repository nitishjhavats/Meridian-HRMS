"use client";

import { type RefObject, useEffect, useState } from "react";

import { frameHintFor, meanLuma } from "@/domain/attendance/frameHint";

/** How often the preview is sampled. Once a second is plenty for a light level. */
const SAMPLE_MS = 1_000;
/** The sample is scaled to this square. Small on purpose — it is an average. */
const SAMPLE_PX = 32;

/**
 * Live advice about the light, for any screen that points a camera at somebody.
 *
 * Extracted from the phone's check-in panel, where it worked, so that the
 * reception screen can have it too — that screen had one hardcoded "Blink now"
 * and nothing else, and a person standing at a dim desk only found out the
 * light was the problem after submitting.
 *
 * Returns null while the camera is not running, so a caller can render the
 * hint slot unconditionally and have it disappear on its own.
 */
export function useFrameHint(
  video: RefObject<HTMLVideoElement | null>,
  active: boolean,
): string | null {
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      setHint(null);
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE_PX;
    canvas.height = SAMPLE_PX;
    const context = canvas.getContext("2d", { willReadFrequently: true });

    const id = setInterval(() => {
      const element = video.current;
      if (!element || !context || element.readyState < 2) return;

      // The centre square of the frame: a face is in the middle, and the edges
      // are the room.
      const size = Math.min(element.videoWidth, element.videoHeight) || 0;
      if (size === 0) return;
      context.drawImage(
        element,
        (element.videoWidth - size) / 2,
        (element.videoHeight - size) / 2,
        size,
        size,
        0,
        0,
        SAMPLE_PX,
        SAMPLE_PX,
      );

      const { data } = context.getImageData(0, 0, SAMPLE_PX, SAMPLE_PX);
      setHint(frameHintFor(meanLuma(data)));
    }, SAMPLE_MS);

    return () => clearInterval(id);
  }, [video, active]);

  return hint;
}

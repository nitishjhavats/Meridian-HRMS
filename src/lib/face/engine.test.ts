import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The engine needs two ONNX models and a native runtime, so it cannot run
 * under vitest. What can be checked is that the wiring is the wiring: the face
 * it describes comes from `pickPrimary` / `trackPrimary`, not from whichever
 * detection scored highest.
 *
 * That pick is what this guards against coming back. Measured on a live
 * organisation over one week: sixteen "several faces" refusals and four "no
 * match" at 0.02-0.33, from people whose good marks score 0.73-0.77, because
 * the engine kept the sharpest detection -- a bystander's head at the back --
 * and counted every detection as a face at the camera. The geometry that
 * fixes it is tested in `primaryFace.test.ts`; this is that the engine uses it.
 */

const ENGINE = "src/lib/face/engine.ts";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The body of one method of `OnnxFaceEngine`, from its signature to the next `async`. */
function method(body: string, name: string): string {
  const start = body.indexOf(`async ${name}(`);
  expect(start, `${name} exists`).toBeGreaterThan(-1);
  const rest = body.slice(start + `async ${name}(`.length);
  const next = rest.search(/\n {2}(private )?async \w+\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("the face engine and the primary face", () => {
  const body = code(ENGINE);

  it("takes the choice of face from the domain", () => {
    expect(body).toMatch(
      /import \{[^}]*\bpickPrimary\b[^}]*\} from "@\/domain\/attendance\/primaryFace"/s,
    );
    expect(body).toMatch(
      /import \{[^}]*\btrackPrimary\b[^}]*\} from "@\/domain\/attendance\/primaryFace"/s,
    );
    expect(body).toMatch(
      /import \{[^}]*\bcomparableFaces\b[^}]*\} from "@\/domain\/attendance\/primaryFace"/s,
    );
  });

  it("no longer keeps the highest-scoring detection", () => {
    expect(body).not.toMatch(/faces\.reduce\(/);
    expect(body).not.toMatch(/f\.score > a\.score/);
  });

  it("returns every face from a detector pass, boxes scaled with the landmarks", () => {
    const detect = method(body, "detect");
    expect(detect).toMatch(/faces: faces\.map\(/);
    expect(detect).toMatch(/x: face\.x \* scaleX/);
    expect(detect).toMatch(/h: face\.h \* scaleY/);
    expect(detect).not.toMatch(/faceCount/);
  });

  it("describes the primary face of a single image and counts only comparable ones", () => {
    const describeOne = method(body, "describe");
    expect(describeOne).toMatch(/pickPrimary\(found\.faces, frame\)/);
    expect(describeOne).toMatch(/comparableFaces\(found\.faces, primary\)/);
    expect(describeOne).toMatch(/detectionScore: primary\.score/);
    expect(describeOne).toMatch(/bystanderCount/);
    expect(describeOne).toMatch(/this\.encode\(image, primary\.landmarks/);
  });

  it("follows one person through a burst and reads the count from the track", () => {
    const sequence = method(body, "describeSequence");
    expect(sequence).toMatch(/const track = trackPrimary\(/);
    expect(sequence).toMatch(/track\.primaries\[i\]/);
    expect(sequence).toMatch(/faceCount: track\.faceCount/);
    expect(sequence).toMatch(/bystanderCount: track\.bystanders/);
    // A frame with no face at all is a no-face frame in the blink series; a
    // frame where a face was seen but the tracked person was lost is marked
    // unreadable (-1, which `detectBlink` drops) -- never the neighbour, and
    // never a zero that would read as a full blink.
    expect(sequence).toMatch(/if \(!found\) \{\s*openness\.push\(0\);/);
    expect(sequence).toMatch(/if \(!primary\) \{\s*openness\.push\(-1\);/);
    // The single-frame shortcut still goes through `describe`, and so through `pickPrimary`.
    expect(sequence).toMatch(/if \(frames\.length === 1\) return this\.describe\(/);
    // Nothing in the burst path counts raw detections.
    expect(sequence).not.toMatch(/maxFaceCount/);
    expect(sequence).not.toMatch(/found\.faceCount/);
  });
});

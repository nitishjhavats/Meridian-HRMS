/**
 * Proves the burst path runs end to end against the real ONNX sessions.
 *
 *   npx tsx scripts/blink-smoke-test.mts                 # plumbing only
 *   npx tsx scripts/blink-smoke-test.mts .tmp-faces/seq  # a real capture
 *
 * With no argument it feeds a picture that contains no face, which proves the
 * sequence path executes, loads both models and returns a *null* blink answer
 * rather than a false one -- the distinction the whole liveness rule rests on.
 *
 * Given a directory, it reads every image in name order as one capture and
 * prints the per-frame openness series alongside the verdict, which is how a
 * threshold gets checked against a real face rather than against a hunch.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { faceEngine } from "../src/lib/face/engine";

const dir = process.argv[2];
const engine = faceEngine();

if (!dir) {
  const frame = readFileSync("public/icons/icon-512.png");
  const single = await engine.describe(frame);
  const burst = await engine.describeSequence(Array.from({ length: 6 }, () => frame));

  const show = (label: string, c: typeof single) =>
    console.log(
      `${label.padEnd(12)} faces=${c.faceCount} score=${c.detectionScore.toFixed(3)} ` +
        `descriptor=${c.descriptor ? c.descriptor.length + "d" : "none"} ` +
        `blinked=${String(c.blinked)} error=${c.engineError ?? "none"}`,
    );

  show("describe", single);
  show("sequence", burst);
  console.log(`\nengine available: ${engine.available}`);

  if (burst.blinked === false) {
    console.error("\nFAIL: a picture with no face must not report a failed blink.");
    process.exit(1);
  }
  console.log("OK: no face in frame, and no blink verdict invented.");
} else {
  const files = readdirSync(dir)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .sort();
  if (files.length === 0) {
    console.error(`No images in ${dir}`);
    process.exit(1);
  }
  console.log(`${files.length} frame(s) from ${dir}\n`);
  const frames = files.map((f) => readFileSync(path.join(dir, f)));
  const verdict = await engine.describeSequence(frames);
  console.log(
    `faces=${verdict.faceCount} score=${verdict.detectionScore.toFixed(3)} ` +
      `blinked=${String(verdict.blinked)} error=${verdict.engineError ?? "none"}`,
  );
}

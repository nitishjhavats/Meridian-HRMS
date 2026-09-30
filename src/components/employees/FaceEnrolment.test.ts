import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * On a server without the recognition models, every enrolment is refused --
 * "Face verification is unavailable, so this photo cannot be enrolled yet" --
 * and "Add photo" was live anyway: a preview that flashed and the same error
 * on every try. The button now waits for the engine, and the alert that was
 * already on the screen says that a photo cannot be added until it runs.
 * Remove stays live: deleting a photo reads no face.
 */

const PANEL = "src/components/employees/FaceEnrolment.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The Add / Replace photo button, opening tag only. */
function addPhoto(body: string): string {
  const at = body.indexOf('{enrolled ? "Replace photo" : "Add photo"}');
  expect(at, "no add-photo button").toBeGreaterThan(-1);
  const start = body.lastIndexOf("<Button", at);
  return body.slice(start, body.indexOf(">", body.indexOf("onClick", start)));
}

/** The Remove button, opening tag only. */
function remove(body: string): string {
  const at = body.indexOf("Remove\n");
  expect(at, "no remove button").toBeGreaterThan(-1);
  return body.slice(body.lastIndexOf("<Button", at), at);
}

describe("adding a reference photo", () => {
  const body = code(PANEL);

  it("waits for the face engine as well as for consent", () => {
    expect(addPhoto(body)).toMatch(/disabled=\{busy \|\| !engineAvailable \|\| \(!enrolled && !consented\)\}/);
  });

  it("says why on the button itself", () => {
    expect(addPhoto(body)).toMatch(/engineAvailable\s*\?\s*undefined\s*:\s*"Face verification is not running on this server/);
  });

  it("and in the alert that was already there", () => {
    expect(body).toMatch(/a reference photo cannot be \{enrolled \? "replaced" : "added"\} until they\s+are/);
  });

  it("removing one does not wait for the engine", () => {
    expect(remove(body)).not.toMatch(/engineAvailable/);
  });
});

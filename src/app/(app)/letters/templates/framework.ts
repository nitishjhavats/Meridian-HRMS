import { renderTemplate, type LetterValues, type RenderedLetter } from "@/domain/letters/template";

/**
 * The parts of a framework the editor can change, and the two questions the
 * editor asks about them: "has anything changed?" and "what does it look
 * like right now?".
 *
 * Both are pure so they can be tested without a browser, and both take the
 * whole editable surface rather than the four text boxes. The dirty check used
 * to compare subject, header, body and footer only, so typing a signatory or
 * flipping "Sign this letter" left Save greyed out and the change was lost on
 * the next navigation -- unless the person also happened to touch the wording,
 * which nothing told them to do.
 */

export interface EditableFramework {
  subject: string;
  header: string;
  body: string;
  footer: string;
  showLogo: boolean;
  showSignature: boolean;
  showStamp: boolean;
  signatory: { name: string | null; title: string | null };
}

/** Blank and whitespace both save as null, so they compare as null too. */
function signatoryField(value: string | null): string | null {
  return value?.trim() || null;
}

/** True when saving would write something different from what is stored. */
export function frameworkChanged(draft: EditableFramework, current: EditableFramework): boolean {
  return (
    draft.subject !== current.subject ||
    draft.header !== current.header ||
    draft.body !== current.body ||
    draft.footer !== current.footer ||
    draft.showLogo !== current.showLogo ||
    draft.showSignature !== current.showSignature ||
    draft.showStamp !== current.showStamp ||
    signatoryField(draft.signatory.name) !== signatoryField(current.signatory.name) ||
    signatoryField(draft.signatory.title) !== signatoryField(current.signatory.title)
  );
}

export interface FrameworkPreview {
  subject: string;
  header: RenderedLetter;
  body: RenderedLetter;
  footer: RenderedLetter;
}

/**
 * The editor's text, filled in.
 *
 * The server answers the preview call with the *values* it resolved for the
 * chosen employee; the text is rendered here from what is in the boxes, with
 * the same `renderTemplate` the server uses to issue. That is what makes the
 * preview show an edit before it is saved: the server only knows the stored
 * framework, and rendering that showed the old wording until Save -- which
 * defeated the point of a preview standing between an edit and a save.
 *
 * A signatory typed in the editor wins over the resolved one for the same
 * reason; the boxes are the truth the person is looking at.
 */
export function renderFrameworkPreview(
  draft: EditableFramework,
  values: LetterValues,
): FrameworkPreview {
  const merged: LetterValues = { ...values };
  const name = signatoryField(draft.signatory.name);
  const title = signatoryField(draft.signatory.title);
  if (name) merged["signatory.name"] = name;
  if (title) merged["signatory.title"] = title;

  return {
    subject: renderTemplate(draft.subject, merged).text,
    header: renderTemplate(draft.header, merged),
    body: renderTemplate(draft.body, merged),
    footer: renderTemplate(draft.footer, merged),
  };
}

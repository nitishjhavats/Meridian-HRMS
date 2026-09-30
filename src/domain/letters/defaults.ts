import { CATEGORY_LABELS, type LetterCategory } from "./template";

/**
 * A default letter for every category, in code.
 *
 * **Why code and not seeded rows.** *Restore to default* has to mean something
 * an organisation cannot damage, and a seeded row is only an editable row with
 * an earlier `createdAt` — restoring from one somebody had already edited
 * restores their edit. In code, an override is a row and restoring is deleting
 * it. A category added later also appears for every existing organisation
 * without a data migration.
 *
 * Everything here is plain text with `{{placeholders}}`, not HTML: the PDF
 * renderer emits paragraphs and has no layout engine, and a template promising
 * formatting it cannot produce is worse than one that never offered any.
 *
 * The wording is deliberately conservative, and nothing in it is invented.
 * Dates, titles and amounts come from the record. The employment terms come
 * from one of two places and never from a guess:
 *
 *   - **Probation and working hours** are answered from the organisation's own
 *     settings — `probationDays`, and the shift the person is on or the
 *     organisation's default one. These are facts the product already holds,
 *     so asking for them again would be asking somebody to retype their own
 *     configuration and get it wrong.
 *   - **The notice period** is asked for, every time, because nothing in this
 *     product stores one. `LeaveType.noticeDays` is how far ahead leave must
 *     be applied for and `ExitRecord.noticeDaysRequired` is decided when
 *     somebody resigns — neither is the term an offer is signed against.
 *
 * Either way an unresolved placeholder stops the letter being issued, so a
 * default offer letter can never go out quietly stating a ninety-day notice
 * period nobody chose. That is the rule the whole file is built around, and it
 * is what makes it safe for these bodies to state real terms at all.
 */

export interface LetterFramework {
  subject: string;
  /** Extra lines under the organisation's name and address, above the subject. */
  header: string;
  body: string;
  /** One line along the bottom of every page. */
  footer: string;
}

const FOOTER = "{{organization.name}} · {{letter.number}}";

/**
 * The valediction, and nothing else.
 *
 * This used to carry `{{signatory.name}}`, `{{signatory.title}}` and
 * `{{organization.name}}` as well — while `renderLetterPdf` draws its own
 * signature block with exactly those three items underneath. So every letter
 * issued from a default template printed the signatory's name twice, their
 * title twice, and the organisation's name four times counting the letterhead
 * and the footer. Worse, the PDF collapses single newlines into spaces, so the
 * three lines came out as one justified run stretched across the page.
 *
 * The PDF block wins because it is the only one of the two that can draw the
 * signature image, and because the rest of the product already assumed it: the
 * AI drafter is told not to write a sign-off — "the system adds all of those" —
 * and the seeded template has none. These defaults were the outlier.
 *
 * A side effect worth having: the body no longer demands a signatory title, so
 * an organisation without one stops seeing "Signatory title" in *Fill these in*
 * on every single letter. The PDF simply omits the line.
 */
const SIGN_OFF = "Yours sincerely,";

function letter(...paragraphs: string[]): string {
  return [...paragraphs, SIGN_OFF].join("\n\n");
}

export const LETTER_DEFAULTS: Record<LetterCategory, LetterFramework> = {
  OFFER: {
    subject: "Offer of employment",
    header: "Private and confidential",
    body: letter(
      "Dear {{employee.name}},",
      "We are pleased to offer you the position of {{employee.designation}} in our {{employee.department}} department at {{organization.name}}, based at {{employee.location}}.",
      "Your annual cost to company will be {{salary.annualCtc}}, which is {{salary.monthlyCtc}} per month. A detailed breakdown of the components forms part of your appointment letter.",
      "Your start date is {{employee.joiningDate}}. You will report to {{employee.manager}}. Your normal working hours are {{terms.workingHours}}, and the organisation's leave and holiday calendar applies to you from the day you join.",
      "Your appointment carries a probation period of {{terms.probationPeriod}} from your start date. Once either party has given {{terms.noticePeriod}} written notice, the employment ends at the close of that period.",
      "This offer is subject to verification of the documents and references you have provided. Please confirm your acceptance by signing and returning a copy of this letter.",
      "We look forward to working with you.",
    ),
    footer: FOOTER,
  },

  APPOINTMENT: {
    subject: "Letter of appointment",
    header: "{{organization.legalName}} · CIN {{organization.cin}}",
    body: letter(
      "Dear {{employee.name}},",
      "Further to your acceptance of our offer, we confirm your appointment as {{employee.designation}} in the {{employee.department}} department at {{organization.name}} with effect from {{employee.joiningDate}}.",
      "Your employee code is {{employee.code}} and you will report to {{employee.manager}}. Your place of work is {{employee.location}}.",
      "Your remuneration is {{salary.annualCtc}} per annum, paid monthly as {{salary.monthlyCtc}}, subject to statutory deductions.",
      "Your normal working hours are {{terms.workingHours}}. Your appointment is subject to a probation period of {{terms.probationPeriod}}, during which your performance will be reviewed; your services stand confirmed in writing at the end of it.",
      "Either party may end this employment by giving {{terms.noticePeriod}} written notice, or salary in lieu of the notice not served. You are required to return all property, records and documents belonging to {{organization.name}} on or before your last working day.",
      "You will not, during your employment or after it ends, disclose to anybody outside {{organization.name}} any confidential information about its business, its customers or its employees that you come to know through your work.",
      "Statutory benefits apply as required by law. Provident fund contributions are made under establishment code {{organization.pfCode}} and employees' state insurance under {{organization.esiCode}}, where you are eligible.",
      "Your employment is governed by the terms set out in this letter and by the policies of {{organization.name}} as amended from time to time.",
      "Please sign and return the enclosed copy in acknowledgement.",
    ),
    footer: FOOTER,
  },

  CONFIRMATION: {
    subject: "Confirmation of employment",
    header: "",
    body: letter(
      "Dear {{employee.name}},",
      "We are pleased to confirm your employment with {{organization.name}} as {{employee.designation}} in the {{employee.department}} department.",
      "Your performance during the probation period has been assessed and found satisfactory. Your services stand confirmed with effect from {{employee.confirmationDate}}.",
      "From that date the notice period applicable to your employment is {{terms.noticePeriod}}. All other terms of your appointment letter continue to apply unchanged.",
      "We thank you for your contribution and look forward to your continued association with us.",
    ),
    footer: FOOTER,
  },

  PROMOTION: {
    subject: "Letter of promotion",
    header: "",
    body: letter(
      "Dear {{employee.name}},",
      "In recognition of your performance and contribution, we are pleased to inform you that you have been promoted to the position of {{employee.designation}} in the {{employee.department}} department at {{organization.name}}, with effect from {{terms.effectiveDate}}.",
      "Your revised remuneration is {{salary.annualCtc}} per annum, being {{salary.monthlyCtc}} per month, from the same date. You will continue to report to {{employee.manager}}.",
      "All other terms and conditions of your employment remain unchanged.",
      "Congratulations, and we wish you continued success in your new role.",
    ),
    footer: FOOTER,
  },

  INCREMENT: {
    subject: "Revision of remuneration",
    header: "Private and confidential",
    body: letter(
      "Dear {{employee.name}},",
      "Following the annual review, we are pleased to inform you that your remuneration has been revised with effect from {{terms.effectiveDate}}.",
      "Your cost to company was {{salary.previousAnnualCtc}} per annum. It is revised to {{salary.annualCtc}} per annum, being {{salary.monthlyCtc}} per month, subject to statutory deductions.",
      "Your designation of {{employee.designation}} and all other terms of your employment remain unchanged.",
      "We thank you for your contribution to {{organization.name}}.",
    ),
    footer: FOOTER,
  },

  WARNING: {
    subject: "Letter of warning",
    header: "Private and confidential",
    body: letter(
      "Dear {{employee.name}},",
      "This letter is to place on record our concern regarding your conduct at work. The matter, and the date on which it occurred, are set out below.",
      "[Describe what happened and when. A warning that does not say what it is about cannot be acted on, and is worth nothing if it is ever relied upon.]",
      "We expect an immediate and sustained improvement, and this letter will be placed on your personnel file. Please treat it as a formal warning: a recurrence may result in further action under the policies of {{organization.name}}, up to and including termination of your employment.",
      "You may respond to this letter in writing within seven days if you wish to place your position on record.",
    ),
    footer: FOOTER,
  },

  EXPERIENCE: {
    subject: "Experience certificate",
    header: "To whomsoever it may concern",
    body: letter(
      "This is to certify that {{employee.name}} (employee code {{employee.code}}) was employed with {{organization.name}} from {{employee.joiningDate}} to {{employee.lastWorkingDay}}, a period of {{employee.tenure}}.",
      "At the time of leaving, they held the position of {{employee.designation}} in the {{employee.department}} department at {{employee.location}}.",
      "We found them to be sincere and diligent in the discharge of their duties, and we wish them well in their future endeavours.",
      "This certificate is issued at their request.",
    ),
    footer: FOOTER,
  },

  RELIEVING: {
    subject: "Relieving letter",
    header: "",
    body: letter(
      "Dear {{employee.name}},",
      "This is to confirm that you have been relieved from the services of {{organization.name}} with effect from the close of {{employee.lastWorkingDay}}, where you were employed as {{employee.designation}} in the {{employee.department}} department under employee code {{employee.code}}.",
      "Your resignation has been accepted and you stand relieved of your duties from that date. Your service with us was {{employee.tenure}}.",
      "Please ensure that all company property, records and documents in your possession are returned. Your full and final settlement will be processed in accordance with your appointment terms.",
      "We thank you for your service and wish you the very best.",
    ),
    footer: FOOTER,
  },

  TERMINATION: {
    subject: "Termination of employment",
    header: "Private and confidential",
    body: letter(
      "Dear {{employee.name}},",
      "This letter is to inform you that your employment with {{organization.name}} as {{employee.designation}} in the {{employee.department}} department, under employee code {{employee.code}}, stands terminated with effect from the close of {{employee.lastWorkingDay}}.",
      "The notice period applicable to your employment is {{terms.noticePeriod}}. Where notice is not served in full, salary in lieu of the unserved portion will be adjusted in your final settlement.",
      "You are required to return all company property, records and documents in your possession on or before that date, and to complete the exit formalities. Your full and final settlement will be processed in accordance with the terms of your appointment and applicable law.",
      "Your obligations of confidentiality under your appointment letter continue after your employment ends.",
    ),
    footer: FOOTER,
  },

  OTHER: {
    subject: "Letter",
    header: "",
    body: letter("Dear {{employee.name}},"),
    footer: FOOTER,
  },
};

/** Every category, in the order an organisation is likely to need them. */
export const LETTER_CATEGORY_ORDER: readonly LetterCategory[] = [
  "OFFER",
  "APPOINTMENT",
  "CONFIRMATION",
  "PROMOTION",
  "INCREMENT",
  "EXPERIENCE",
  "RELIEVING",
  "WARNING",
  "TERMINATION",
  "OTHER",
];

export function defaultFramework(category: LetterCategory): LetterFramework {
  return LETTER_DEFAULTS[category];
}

export function categoryLabel(category: LetterCategory): string {
  return CATEGORY_LABELS[category] ?? category;
}

import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { renderPayslipPdf, type PayslipInput } from "./payslip";

/**
 * That the watermark is actually drawn, and drawn *underneath*.
 *
 * `@react-pdf` has no z-index: order in the tree is order on the page, so a
 * watermark added anywhere but as the first child of the `Page` paints a solid
 * band of grey over the net pay. Nothing about that shows up in a type check or
 * in a reading of the JSX — the element is present either way — so the only way
 * to know is to render one and look at the operators.
 *
 * Read off the content stream rather than the text, because the rupee sign
 * forces a subset font and the codes in the stream are glyph indices, not
 * characters (`scripts/pdf-text.ts` explains this at length). The three things
 * checked here survive that: the rotation matrix, the pale fill colour, and
 * where in the stream they appear.
 */

const base: PayslipInput = {
  organization: { name: "Northwind Industries", address: "12 MG Road, Bengaluru, India" },
  slipNumber: "SAMPLE/202609/EMP-001",
  periodLabel: "September 2026",
  employee: { name: "Asha Rao", code: "EMP-001", designation: "Engineer" },
  net: { amount: "Rs 40,000.00", inWords: "Rupees forty thousand only" },
  earnings: [{ label: "Basic", amount: "Rs 20,000.00" }],
  deductions: [],
  totals: { gross: "Rs 40,000.00", deductions: "Rs 0.00" },
  attendance: [{ label: "Payable", value: "30" }],
};

/** Every content stream in the file, inflated, concatenated. */
function operators(pdf: Buffer): string {
  let out = "";
  for (const match of pdf.toString("latin1").matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    let body = Buffer.from(match[1]!, "latin1");
    try {
      body = inflateSync(body);
    } catch {
      // Not compressed; read it as it is.
    }
    out += `${body.toString("latin1")}\n`;
  }
  return out;
}

const textRuns = (ops: string) =>
  [...ops.matchAll(/\]\s*TJ/g)].length + [...ops.matchAll(/\)\s*Tj/g)].length;

/** rotate(-28deg) → cos 0.8829, sin -0.4695. */
const ROTATION = /0\.88\d*\s+-0\.46\d*\s+0\.46\d*\s+0\.88\d*\s+[-\d.]+\s+[-\d.]+\s+cm/;
/**
 * #e2e5ec as a non-stroking fill. `scn` rather than `rg`: `@react-pdf` sets an
 * explicit `/DeviceRGB cs` colour space first, which is what the payslip's own
 * greys are drawn with too.
 */
const PALE_GREY = /0\.886\d*\s+0\.898\d*\s+0\.925\d*\s+scn/;
/** #111111 — the colour every other word on the page is drawn in. */
const BODY_BLACK = /0\.066\d*\s+0\.066\d*\s+0\.066\d*\s+scn/;

describe("the payslip watermark", () => {
  it("draws nothing at all when there is none", async () => {
    const ops = operators(await renderPayslipPdf(base));
    expect(ROTATION.test(ops)).toBe(false);
    expect(PALE_GREY.test(ops)).toBe(false);
  });

  it("draws one more run, rotated and pale, when there is", async () => {
    const plain = operators(await renderPayslipPdf(base));
    const marked = operators(await renderPayslipPdf({ ...base, watermark: "DEMO" }));

    expect(ROTATION.test(marked)).toBe(true);
    expect(PALE_GREY.test(marked)).toBe(true);
    expect(textRuns(marked)).toBe(textRuns(plain) + 1);
  });

  it("draws it before everything else, so the figures stay readable", async () => {
    // The failure this catches is a solid grey rectangle over the net pay,
    // which is worse than no watermark: it is a payslip somebody cannot read
    // and will ask HR to re-send.
    const marked = operators(await renderPayslipPdf({ ...base, watermark: "DEMO" }));
    const pale = marked.search(PALE_GREY);
    const body = marked.search(BODY_BLACK);
    const firstRun = marked.search(/\]\s*TJ|\)\s*Tj/);

    expect(pale).toBeGreaterThanOrEqual(0);
    expect(body).toBeGreaterThanOrEqual(0);
    // Laid down before any of the page's own text, and the first thing on the
    // page at all.
    expect(pale).toBeLessThan(body);
    expect(pale).toBeLessThan(firstRun);
    expect(marked.search(ROTATION)).toBeLessThan(firstRun);
  });
});

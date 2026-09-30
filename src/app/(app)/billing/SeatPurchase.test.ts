import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A quote that fails is said, not swallowed. It used to leave "Users —",
 * "Payable —" and a disabled Continue with no word about why, which on a
 * payment screen reads as broken. And a coupon longer than the schema's 32
 * characters used to turn the whole quote into a 422 -- now the box will not
 * take one.
 */

const SCREEN = "src/app/(app)/billing/SeatPurchase.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The coupon input's opening tag. */
function couponInput(body: string): string {
  const at = body.indexOf('aria-label="Coupon or payment code"');
  expect(at, "no coupon box").toBeGreaterThan(-1);
  return body.slice(body.lastIndexOf("<Input", at), body.indexOf("/>", at));
}

describe("the seat quote", () => {
  const body = code(SCREEN);

  it("keeps the failure and still drops the stale price", () => {
    expect(body).toMatch(/const \[quoteError, setQuoteError\] = useState<unknown>\(null\)/);
    expect(body).toMatch(/catch \(error\) \{\n\s*setQuote\(null\);\n\s*setQuoteError\(error\);/);
    expect(body).toMatch(/setQuote\(result\);\n\s*setQuoteError\(null\);/);
  });

  it("says so under the bill, with a retry that re-asks for the same seats", () => {
    expect(body).toMatch(
      /<LoadFailed[\s\S]*?error=\{quoteError\}[\s\S]*?onRetry=\{\(\) => void fetchQuote\(userCount, periodMonths, appliedCoupon\)\}/,
    );
    // After the bill, before the Continue button it explains.
    const bill = body.indexOf("<dt>Payable</dt>");
    const notice = body.indexOf("error={quoteError}");
    const button = body.indexOf("Continue to payment");
    expect(bill).toBeLessThan(notice);
    expect(notice).toBeLessThan(button);
  });

  it("the coupon box will not take more than the schema does", () => {
    expect(couponInput(body)).toMatch(/maxLength=\{32\}/);
  });
});

/**
 * A refused coupon holds the Continue button.
 *
 * The server refuses the order for the same reason the quote already gave,
 * but each press counts against the ten order attempts an hour that guard
 * payment codes from being guessed. Ten presses at a dead coupon locked a
 * genuine buyer out of paying for the rest of the hour.
 */
describe("a refused coupon", () => {
  const body = code(SCREEN);

  it("holds Continue until it is removed or replaced", () => {
    const button = body.slice(body.lastIndexOf("<Button", body.indexOf("Continue to payment")));
    expect(button).toMatch(/disabled=\{[^}]*Boolean\(quote\.couponError\)/);
  });

  it("and the red line says what to do instead", () => {
    expect(body).toMatch(/\{quote\.couponError\} Remove it, or type another code and apply it, to continue\./);
    // "Type another code" needs an Apply while a refused code is still applied.
    expect(body).toMatch(/appliedCoupon && couponInput\.trim\(\) === appliedCoupon \? \(/);
  });
});

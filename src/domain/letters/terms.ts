/**
 * Employment terms, as a letter would say them.
 *
 * Pure, because the same phrase has to come out of the letter renderer, the
 * preview and any test, and because a letter is a legal document whose wording
 * should not depend on which code path produced it.
 */

/**
 * A probation length, written the way a person writes it.
 *
 * The organisation stores days, because that is what arithmetic on a joining
 * date needs. Nobody writes "your probation period is 90 days" in an
 * appointment letter; they write three months. So whole months are said in
 * months and anything else is said in days, which is exactly how the two forms
 * are used in practice.
 *
 * **Zero returns null**, and that is deliberate. An organisation that has
 * switched probation off has no probation clause to state, and inventing one
 * ("a probation period of 0 days") would put a false term in a signed letter.
 * A null leaves the placeholder unresolved, and `issueLetter` refuses to issue
 * a letter with an unresolved placeholder — so the person issuing it is told,
 * once, that their template still has a clause their organisation does not
 * use, instead of every offer going out with a nonsense sentence in it.
 */
export function probationPeriod(days: number | null): string | null {
  if (days === null || !Number.isFinite(days) || days <= 0) return null;

  const whole = Math.round(days);
  if (whole % 30 === 0) {
    const months = whole / 30;
    return months === 1 ? "one month" : `${months} months`;
  }
  return whole === 1 ? "one day" : `${whole} days`;
}

/**
 * How long somebody was here, as a letter says it.
 *
 * "2 years and 3 months", not "832 days". An experience certificate is read by
 * a bank or a visa officer counting years, and the number of days is arithmetic
 * they should not have to do.
 *
 * Both dates are `YYYY-MM-DD`, so this is calendar arithmetic on the parts and
 * never touches a timezone -- the same reason the rest of this product keeps
 * dates as strings.
 */
export function tenureBetween(from: string, to: string): string | null {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  if (!fy || !fm || !fd || !ty || !tm || !td) return null;
  if (ty < fy || (ty === fy && (tm < fm || (tm === fm && td < fd)))) return null;

  let years = ty - fy;
  let months = tm - fm;
  if (td < fd) months -= 1;
  if (months < 0) {
    years -= 1;
    months += 12;
  }

  const y = years === 1 ? "1 year" : `${years} years`;
  const m = months === 1 ? "1 month" : `${months} months`;
  if (years === 0 && months === 0) return "less than a month";
  if (years === 0) return m;
  if (months === 0) return y;
  return `${y} and ${m}`;
}

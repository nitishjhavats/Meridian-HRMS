/**
 * The visual-pass probe. Paste into the console of any page, or run it from a
 * browser tool after each navigation, at the widths that matter (375, 1280).
 *
 * Reports, for the current page:
 *   ov        document wider than the viewport (the page scrolls sideways)
 *   off       elements whose right edge leaves the viewport and that are not
 *             inside something that scrolls on purpose
 *   scrollers containers that do scroll sideways (a month grid; expected)
 *   clip      text ending in an ellipsis -- a label cut is a label lost
 *   err       an error screen is showing
 *   empty     almost nothing rendered
 *
 * Source patterns are `npm run verify:layout`'s job; this measures what those
 * cannot. See docs/06-operations.md, "The visual pass".
 */
(() => {
  const d = document, w = window, vw = d.documentElement.clientWidth;
  const o = { p: location.pathname, vw, ov: null, off: [], clip: [], scrollers: [], err: false, empty: false };
  const t = d.body.innerText || "";
  o.err = /Something went wrong|Application error|could not be loaded/i.test(t);
  o.empty = t.trim().length < 40;
  if (d.documentElement.scrollWidth > vw + 1) o.ov = d.documentElement.scrollWidth;
  const inScroller = (e) => {
    for (let a = e.parentElement; a && a !== d.body; a = a.parentElement) {
      const ox = w.getComputedStyle(a).overflowX;
      if ((ox === "auto" || ox === "scroll") && a.scrollWidth > a.clientWidth + 1) return a;
    }
    return null;
  };
  const label = (e) => e.tagName.toLowerCase() + "." + (e.className || "").toString().split(" ").slice(0, 3).join(".");
  const seen = new Set(), seenScrollers = new Set();
  for (const e of d.querySelectorAll("main *, header *, nav *")) {
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const c = w.getComputedStyle(e);
    if (c.position === "fixed") continue;
    if (r.right > vw + 2 && r.left < vw) {
      const a = inScroller(e);
      if (a) {
        const k = label(a);
        if (!seenScrollers.has(k) && o.scrollers.length < 4) { seenScrollers.add(k); o.scrollers.push(k + " " + a.scrollWidth); }
        continue;
      }
      const k = e.tagName + "|" + (e.className || "").toString().slice(0, 40);
      if (!seen.has(k) && o.off.length < 6) {
        seen.add(k);
        o.off.push(label(e) + " r=" + Math.round(r.right) + ' "' + (e.textContent || "").trim().slice(0, 30) + '"');
      }
    }
    if (!e.children.length && c.textOverflow === "ellipsis" && e.scrollWidth > e.clientWidth + 2 && o.clip.length < 6) {
      o.clip.push((e.textContent || "").trim().slice(0, 40));
    }
  }
  return JSON.stringify(o);
})();

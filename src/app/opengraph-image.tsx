import { ImageResponse } from "next/og";
import { BRAND } from "@/lib/brand";

/**
 * The card that appears when somebody shares this link.
 *
 * Drawn by the app rather than committed as a PNG: the CSP permits no external
 * images and `public/` holds nothing but the eight PWA icons, so generating it
 * is both the only option and the better one — it cannot drift out of step with
 * the brand constants.
 */
export const runtime = "nodejs";
export const alt = `${BRAND.name} — ${BRAND.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "linear-gradient(135deg, #1b2559 0%, #3b4cca 100%)",
          padding: 72,
          color: "#ffffff",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 34, opacity: 0.75, letterSpacing: 2 }}>{BRAND.name}</div>
          <div style={{ fontSize: 76, fontWeight: 700, lineHeight: 1.05, maxWidth: 880 }}>
            Attendance, leave and pay. In one place.
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 30, opacity: 0.85, maxWidth: 900 }}>
            GPS and face-verified check-in · leave with an approval chain · payroll that shows its
            working
          </div>
          <div style={{ display: "flex", fontSize: 26, opacity: 0.65 }}>
            {`${BRAND.maker.credit} · ${BRAND.maker.websiteLabel}`}
          </div>
        </div>
      </div>
    ),
    size,
  );
}

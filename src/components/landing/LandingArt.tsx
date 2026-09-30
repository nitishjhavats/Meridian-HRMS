import { CheckCircle2, MapPin } from "lucide-react";

/**
 * The landing page's illustrations.
 *
 * All hand-built. The CSP is `img-src 'self' data: blob:` — no CDN, no stock
 * photography, and `public/` holds nothing but the PWA icons — so anything
 * pictorial here is markup or inline SVG or it does not exist. That constraint
 * turned out to be the right one anyway: a mock of the product's own check-in
 * card says more than a photograph of somebody at a desk.
 *
 * Everything animates through CSS only, so these stay server components.
 * `globals.css` already flattens animation under `prefers-reduced-motion`
 * globally; the one thing that needs a local reset is the drawn rail, whose
 * `stroke-dashoffset` has to be pinned at its finished value rather than merely
 * shortened, or the line never appears at all.
 */

export function LandingKeyframes() {
  return (
    <style>{`
      @keyframes lp-rise {
        from { opacity: 0; transform: translateY(16px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      @keyframes lp-draw { to { stroke-dashoffset: 0; } }
      @keyframes lp-drift {
        0%, 100% { transform: translate3d(0, 0, 0); }
        50%      { transform: translate3d(0, -12px, 0); }
      }
      @keyframes lp-ping {
        0%   { transform: scale(.6); opacity: .55; }
        70%  { transform: scale(1.6); opacity: 0; }
        100% { transform: scale(1.6); opacity: 0; }
      }
      .lp-rise  { animation: lp-rise .8s cubic-bezier(.22,.61,.36,1) both; }
      .lp-draw  { stroke-dasharray: 300; stroke-dashoffset: 300; animation: lp-draw 2.2s ease-out .4s forwards; }
      .lp-drift { animation: lp-drift 10s ease-in-out infinite; }
      .lp-ping  { animation: lp-ping 2.8s cubic-bezier(0,0,.2,1) infinite; }

      @media (prefers-reduced-motion: reduce) {
        .lp-rise, .lp-draw, .lp-drift, .lp-ping { animation: none; }
        .lp-draw { stroke-dashoffset: 0; }
        .lp-ping { opacity: 0; }
      }
    `}</style>
  );
}

/**
 * The hero: the product's own check-in card, floating.
 *
 * Built from the same tokens the real screen uses, so it cannot drift into
 * promising a interface that does not exist.
 */
export function CheckInMock({ organizationName }: { organizationName: string | null }) {
  return (
    <div className="relative mx-auto w-full max-w-sm">
      {/* Depth, not decoration. */}
      <div
        aria-hidden
        className="lp-drift pointer-events-none absolute -right-16 -top-20 size-72 rounded-full bg-primary/20 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-24 -left-16 size-64 rounded-full bg-info/20 blur-3xl"
      />

      <div
        className="lp-rise relative rounded-2xl border border-border bg-card p-5 shadow-xl"
        style={{ animationDelay: ".15s" }}
      >
        <p className="truncate text-xs font-medium text-muted-foreground">
          {organizationName ?? "Your organisation"}
        </p>

        <div className="mt-3 flex items-baseline gap-2">
          <span className="tabular text-4xl font-semibold tracking-tight">09:04</span>
          <span className="text-sm text-muted-foreground">checked in</span>
        </div>

        <div className="mt-4 flex items-center gap-2 rounded-lg border border-success bg-success-muted px-3 py-2 text-sm text-foreground">
          <CheckCircle2 className="size-4 shrink-0" aria-hidden />
          On time — 6 minutes inside your grace period
        </div>

        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="relative grid size-6 shrink-0 place-items-center">
            <span
              aria-hidden
              className="lp-ping absolute inset-0 rounded-full bg-primary/40"
            />
            <MapPin className="relative size-3.5 text-primary" aria-hidden />
          </span>
          Head Office · 38 m from the gate
        </div>

        {/* The month, as a shape. Deliberately unlabelled — it reads as
            "this accumulates into something", which is the honest claim. */}
        <div className="mt-5 flex items-end gap-1" aria-hidden>
          {[9, 14, 11, 16, 13, 6, 4, 15, 17, 12, 16, 14].map((h, i) => (
            <span
              key={i}
              className="lp-rise flex-1 rounded-sm bg-primary/25"
              style={{ height: `${h * 3}px`, animationDelay: `${0.5 + i * 0.05}s` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Check in, the day is scored, the month becomes a payslip.
 *
 * The product's actual loop, drawn once. Same idea as the sign-in showcase, at
 * the size a first-time visitor needs it.
 */
export function LoopDiagram({ steps }: { steps: readonly string[] }) {
  return (
    <div className="w-full">
      <svg
        viewBox="0 0 340 48"
        className="h-12 w-full text-primary"
        role="img"
        aria-label={steps.join(", then ")}
      >
        <path
          d="M20 24 H320"
          className="lp-draw"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeOpacity=".35"
          strokeLinecap="round"
          fill="none"
        />
        {[20, 170, 320].map((cx, i) => (
          <g key={cx}>
            <circle cx={cx} cy="24" r="10" fill="currentColor" fillOpacity=".14" />
            <circle
              cx={cx}
              cy="24"
              r="4.5"
              fill="currentColor"
              className="lp-rise"
              style={{ animationDelay: `${0.7 + i * 0.4}s` }}
            />
          </g>
        ))}
      </svg>

      <ol className="mt-2 grid grid-cols-3 gap-2 text-center">
        {steps.map((step, i) => (
          <li
            key={step}
            className="lp-rise text-xs text-muted-foreground"
            style={{ animationDelay: `${0.8 + i * 0.4}s` }}
          >
            {step}
          </li>
        ))}
      </ol>
    </div>
  );
}

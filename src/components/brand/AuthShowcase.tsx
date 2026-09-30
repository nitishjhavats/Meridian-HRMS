import { Fingerprint, MapPin, ReceiptIndianRupee, ShieldCheck } from "lucide-react";
import type { Branding } from "@/lib/branding";
import { MakerCredit } from "./MakerCredit";

/**
 * The panel beside the sign-in form.
 *
 * It used to be a paragraph and a four-item bullet list, which nobody reads on
 * the way to typing a password. This shows the product's actual loop instead —
 * somebody checks in at a place, the day is scored, the month becomes a
 * payslip — because that sequence *is* the product, and a picture of it lands
 * faster than four sentences about it.
 *
 * The motion is CSS only, staged rather than looping fast, and it stops
 * entirely under `prefers-reduced-motion`. Nothing here is interactive, so
 * there is nothing to miss if it never animates at all.
 */
export function AuthShowcase({ branding }: { branding: Branding }) {
  const steps = [
    {
      icon: MapPin,
      title: "Check in where the work is",
      detail: "Inside your own radius, on your own shift.",
    },
    {
      icon: Fingerprint,
      title: "Verified on the device",
      // Not "the server you own": this renders on every sign-in page including
      // each tenant's door, and asserting a self-hosted deployment is false for
      // anybody on shared infrastructure.
      detail: "Face matching runs on this server. Photos are not sent to any third party.",
    },
    {
      icon: ReceiptIndianRupee,
      title: "Payroll that shows its working",
      detail: "Every rupee traceable to the rule that produced it.",
    },
  ];

  return (
    <aside className="relative hidden overflow-hidden bg-primary text-primary-foreground lg:flex lg:flex-col lg:justify-between lg:p-12">
      <style>{`
        @keyframes hrms-rise {
          from { opacity: 0; transform: translateY(14px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes hrms-draw { to { stroke-dashoffset: 0; } }
        @keyframes hrms-drift {
          0%, 100% { transform: translate3d(0, 0, 0); }
          50%      { transform: translate3d(0, -10px, 0); }
        }
        .hrms-rise { animation: hrms-rise .7s cubic-bezier(.22,.61,.36,1) both; }
        .hrms-draw { stroke-dasharray: 260; stroke-dashoffset: 260; animation: hrms-draw 2.4s ease-out .3s forwards; }
        .hrms-drift { animation: hrms-drift 9s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .hrms-rise, .hrms-draw, .hrms-drift { animation: none; }
          .hrms-draw { stroke-dashoffset: 0; }
        }
      `}</style>

      {/* Depth, not decoration: two soft fields so the flat brand colour reads
          as a surface rather than a block of paint. */}
      <div
        aria-hidden
        className="hrms-drift pointer-events-none absolute -right-24 -top-24 size-[26rem] rounded-full bg-white/10 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-32 -left-20 size-[22rem] rounded-full bg-black/10 blur-3xl"
      />

      <div />

      <div className="relative max-w-md">
        <h2 className="hrms-rise text-3xl font-semibold leading-tight tracking-tight">
          {branding.organization
            ? `${branding.organization.name} runs on its own rules.`
            : "HR, attendance and payroll that follow your rules."}
        </h2>
        <p className="hrms-rise mt-3 text-sm opacity-80" style={{ animationDelay: ".08s" }}>
          Not someone else&rsquo;s defaults.
        </p>

        {/* The loop, drawn once. */}
        <svg
          viewBox="0 0 320 60"
          className="mt-8 h-14 w-full max-w-sm"
          role="img"
          aria-label="Check in, then the day is scored, then the month becomes a payslip"
        >
          <path
            d="M16 30 H304"
            className="hrms-draw"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeOpacity=".45"
            strokeLinecap="round"
            fill="none"
          />
          {[16, 160, 304].map((cx, i) => (
            <g key={cx}>
              <circle cx={cx} cy="30" r="9" fill="currentColor" fillOpacity=".18" />
              <circle
                cx={cx}
                cy="30"
                r="4"
                fill="currentColor"
                className="hrms-rise"
                style={{ animationDelay: `${0.6 + i * 0.45}s` }}
              />
            </g>
          ))}
        </svg>

        <ul className="mt-8 space-y-5">
          {steps.map((step, i) => (
            <li
              key={step.title}
              className="hrms-rise flex gap-3.5"
              style={{ animationDelay: `${0.25 + i * 0.12}s` }}
            >
              <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-white/15">
                <step.icon className="size-4.5" aria-hidden />
              </span>
              <span>
                <span className="block text-sm font-medium">{step.title}</span>
                <span className="block text-sm opacity-75">{step.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="relative space-y-2 text-xs opacity-75">
        <p className="flex items-center gap-2">
          <ShieldCheck className="size-4" aria-hidden />
          Each organisation&rsquo;s data is separate, and changes are written to an audit log.
        </p>
        <MakerCredit tone="inverted" logoUrl={branding.platformLogoUrl} />
      </div>
    </aside>
  );
}

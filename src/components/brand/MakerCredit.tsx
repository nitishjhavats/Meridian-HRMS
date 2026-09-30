import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/utils";

/**
 * Who built this.
 *
 * The same line had been retyped by hand in four places — the app shell, the
 * sign-in showcase, the sign-in layout's mobile footer and the offline page —
 * which is three too many for something that is meant to read identically
 * everywhere. It also had no mark: the organisation gets a logo beside its name
 * and the maker got a sentence, which is the wrong way round for a credit that
 * is supposed to say *this software is Broadmate Global's*.
 *
 * `logoUrl` is the platform mark the Superadmin uploads. Without one the
 * initial stands in, so the lockup keeps its shape on a fresh instance.
 *
 * `tone="inverted"` is for the sign-in showcase, which sits on the primary
 * colour and therefore cannot use the muted foreground token.
 */
export function MakerCredit({
  logoUrl,
  className,
  tone = "muted",
}: {
  logoUrl?: string | null;
  className?: string;
  tone?: "muted" | "inverted";
}) {
  return (
    <p
      className={cn(
        "flex items-center gap-2 text-[11px]",
        tone === "muted" ? "text-muted-foreground" : "opacity-80",
        className,
      )}
    >
      {logoUrl ? (
        <img
          src={logoUrl}
          alt=""
          className="size-4 shrink-0 rounded object-contain"
        />
      ) : (
        <span
          aria-hidden
          className={cn(
            "grid size-4 shrink-0 place-items-center rounded text-[9px] font-bold",
            tone === "muted"
              ? "bg-muted-foreground/15 text-muted-foreground"
              : "bg-white/20 text-current",
          )}
        >
          {BRAND.maker.name.charAt(0)}
        </span>
      )}

      <span className="min-w-0 truncate">
        {BRAND.maker.credit} ·{" "}
        <a
          href={BRAND.maker.website}
          target="_blank"
          rel="noreferrer noopener"
          className={cn(
            "underline underline-offset-2",
            tone === "muted" ? "hover:text-foreground" : "hover:opacity-100",
          )}
        >
          {BRAND.maker.websiteLabel}
        </a>
      </span>
    </p>
  );
}

import type { Branding } from "@/lib/branding";
import { cn } from "@/lib/utils";

/**
 * The lockup: whose instance this is, and who built it.
 *
 * When an organisation has uploaded a logo it is theirs — the whole point of
 * uploading one is to stop looking like everybody else's install. Without one
 * it falls back to the platform mark, and without that to the product's own
 * letter. The maker's credit sits underneath in every case, small, because it
 * is attribution rather than the headline.
 */
export function BrandMark({
  branding,
  className,
  size = "md",
  title: titleOverride,
  subtitle,
}: {
  branding: Branding;
  className?: string;
  /**
   * `sm` is the app shell's bar, `md` a page, `lg` the product's front door.
   *
   * They differ only in how loud the top line is. `lg` exists because the front
   * door had the same 18px title as a settings page, and on a phone that left
   * the product's own name looking like a breadcrumb.
   */
  size?: "sm" | "md" | "lg";
  /** Replaces the name on the top line, for screens that are not a tenant's. */
  title?: string;
  /**
   * Replaces the maker credit on the second line.
   *
   * Inside the app the shell shows the signed-in person's role there instead —
   * on a screen you are already using, which role you hold is the more useful
   * fact, and the maker's credit is already at the foot of the same column.
   */
  subtitle?: string;
}) {
  const logo = branding.organization?.logoUrl ?? branding.platformLogoUrl;
  const title = titleOverride ?? branding.organization?.name ?? branding.product;
  const box = size === "sm" ? "size-8" : size === "lg" ? "size-11" : "size-10";

  return (
    /**
     * `min-w-0` on the whole lockup, not only on the text.
     *
     * Without it a flex parent gives this block its content width, which is the
     * organisation's name in full -- so a long name pushed the header's buttons
     * off the row instead of truncating itself.
     */
    <span className={cn("flex min-w-0 items-center gap-1.5 sm:gap-2.5", className)}>
      {logo ? (
        <img
          src={logo}
          alt=""
          className={cn(box, "shrink-0 rounded-lg object-contain")}
        />
      ) : (
        <span
          className={cn(
            box,
            "grid shrink-0 place-items-center rounded-lg bg-primary font-bold text-primary-foreground",
            size === "sm" ? "text-base" : "text-lg",
          )}
          aria-hidden
        >
          {title.charAt(0).toUpperCase()}
        </span>
      )}

      <span className="min-w-0">
        <span
          className={cn(
            "block truncate font-semibold leading-tight tracking-tight",
            size === "sm" ? "text-base" : size === "lg" ? "text-xl" : "text-lg",
          )}
        >
          {title}
        </span>
        {/**
          * The product and its maker: in full, never cut, and on one line.
          *
          * Three attempts. `truncate` clipped it to "HRMS by Broadma...", and a
          * credit that is only half there reads worse than none. Letting it
          * wrap fixed the clipping and produced the next report -- on a 375px
          * phone it broke into *three* lines, "HRMS by / Broadmate / Global",
          * which is not a credit either.
          *
          * So it is pinned to one line and the room is found elsewhere: the
          * header's own gaps and icon padding gave up the fifty pixels this
          * needs, and it drops to 10px on the narrowest screens. Measured
          * rather than guessed -- twenty-four characters is 136px at 11px and
          * 123px at 10px in this font, and the text column gets 118px at 320
          * and its full 123 from 341 upwards.
          *
          * Below 360 it is allowed to wrap again, because that is the one width
          * where the line genuinely does not fit and two whole lines beat one
          * cut one. Every phone this product will meet today is 360 or wider;
          * this is a 2016 iPhone SE, and it gets a credit rather than a
          * clipped one.
          *
          * The organisation's name above still truncates, because that one is
          * unbounded and something has to give when it is longer than the
          * screen. This one is fixed-length, so nothing has to.
          */}
        <span className="block whitespace-nowrap text-[10px] leading-tight text-muted-foreground max-[359px]:whitespace-normal sm:text-[11px]">
          {subtitle ?? `${branding.product} ${branding.maker.credit}`}
        </span>
      </span>
    </span>
  );
}

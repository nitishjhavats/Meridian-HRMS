import { BRAND, WHATSAPP_ENQUIRY } from "@/lib/brand";

/**
 * A floating enquiry button.
 *
 * Public pages only. An employee marking attendance does not need a sales
 * channel, and a button hovering over a payroll screen is in the way of
 * somebody doing their job — so this is rendered by the landing page rather
 * than by the root layout, and deliberately not on `/o/<slug>`, which belongs
 * to the customer rather than to Broadmate's sales.
 *
 * A plain anchor. No script, no widget, nothing to load — which also means no
 * argument with the CSP, and no third party watching who reads the page.
 *
 * The icon is inline SVG for the same reason every other illustration here is:
 * `img-src 'self' data: blob:` permits no external image, and `currentColor`
 * makes it theme for free.
 */
export function WhatsAppButton() {
  return (
    <a
      href={WHATSAPP_ENQUIRY}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`Ask ${BRAND.maker.name} a question on WhatsApp`}
      // Bottom-right, clear of an iOS home indicator, and above everything on
      // the page but below any dialog.
      // #128C7E rather than the brighter #25D366: white on the bright green is
      // 1.98:1, which made the label and the icon unreadable — the worst pair on
      // the public page. This is WhatsApp's own darker brand green and carries
      // white text at about 4.5:1.
      className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-[#128C7E] px-4 py-3 text-sm font-semibold text-white shadow-lg transition-transform hover:scale-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:bottom-7 sm:right-7"
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      <svg
        viewBox="0 0 24 24"
        className="size-5 shrink-0"
        fill="currentColor"
        aria-hidden
        focusable="false"
      >
        <path d="M17.47 14.38c-.3-.15-1.75-.86-2.02-.96-.27-.1-.47-.15-.67.15-.2.3-.77.96-.95 1.16-.17.2-.35.22-.65.07-.3-.15-1.25-.46-2.38-1.47-.88-.78-1.47-1.75-1.65-2.05-.17-.3-.02-.46.13-.61.14-.13.3-.35.45-.52.15-.18.2-.3.3-.5.1-.2.05-.38-.02-.53-.08-.15-.67-1.6-.92-2.2-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.38-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.22 3.08c.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.69.63.71.22 1.36.19 1.87.12.57-.09 1.75-.72 2-1.41.25-.7.25-1.29.17-1.42-.07-.13-.27-.2-.57-.35Z" />
        <path d="M12.04 2C6.6 2 2.17 6.43 2.17 11.87c0 1.74.46 3.44 1.32 4.94L2 22.5l5.85-1.53a9.83 9.83 0 0 0 4.19.94h.01c5.43 0 9.86-4.43 9.86-9.87 0-2.64-1.03-5.12-2.9-6.99A9.8 9.8 0 0 0 12.04 2Zm0 1.8c2.15 0 4.17.84 5.69 2.36a8.02 8.02 0 0 1 2.36 5.7c0 4.45-3.62 8.07-8.06 8.07a8.1 8.1 0 0 1-4.11-1.13l-.3-.17-3.05.8.81-2.97-.19-.31a8.02 8.02 0 0 1-1.24-4.3c0-4.44 3.62-8.06 8.09-8.06Z" />
      </svg>
      <span className="hidden sm:inline">Ask us on WhatsApp</span>
    </a>
  );
}

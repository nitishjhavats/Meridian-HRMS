import type { Metadata, Viewport } from "next";
import { InstallPrompt, OnlineStatus, ServiceWorkerManager } from "@/components/pwa/InstallPrompt";
import { Toaster } from "@/components/ui/toast";
import { BRAND } from "@/lib/brand";
import "./globals.css";

export const metadata: Metadata = {
  // Without this, Next resolves every absolute URL it emits against
  // localhost:3000 and warns at build time. It is the deployed origin.
  metadataBase: new URL(process.env.APP_URL ?? "http://localhost:3000"),
  title: {
    default: `${BRAND.name} — ${BRAND.tagline}`,
    template: `%s · ${BRAND.name}`,
  },
  description:
    "HR, attendance and payroll software for Indian companies. GPS and face-verified check-in, leave with an approval chain, payslips that show their working, and letters issued as PDFs. By Broadmate Global.",
  // Search engines have long stopped ranking on these, but a few crawlers and
  // several link previews still read them, and they cost nothing.
  keywords: [
    "HRMS software India",
    "payroll software",
    "attendance management system",
    "face recognition attendance",
    "leave management software",
    "employee management software",
    "HR software for small business",
  ],
  applicationName: BRAND.name,
  authors: [{ name: BRAND.maker.name, url: BRAND.maker.website }],
  creator: BRAND.maker.name,
  publisher: BRAND.maker.name,
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: BRAND.name },
  /**
   * The home-screen icon comes from the branded route, not from `public/`.
   *
   * iOS never reads the web app manifest for this — it reads
   * `apple-touch-icon` — so an instance whose manifest icons were the uploaded
   * logo still put the shipped blue "H" on an iPhone's home screen. The route
   * falls back to that same shipped mark when no logo has been uploaded, so
   * this is a branding change and never a missing icon.
   */
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/api/branding/icon/192", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/api/branding/icon/192", sizes: "192x192" }],
  },
  formatDetection: { telephone: false },
  /**
   * The marketing page is indexable; everything behind a login is not.
   *
   * This used to be `index: false` for the whole site, and the reason was
   * sound: the landing page carried a named customer's branding, and
   * publishing which companies Broadmate serves is not ours to do. That is
   * fixed — the front door is Broadmate's whatever customers exist — so the
   * objection is gone. The `(app)`, `(platform)`, `(auth)` and `/o/[slug]`
   * layouts each set `noindex` for themselves, `robots.txt` says the same, and
   * `next.config.mjs` sends `X-Robots-Tag` on those paths. Three independent
   * statements, because getting this wrong publishes a customer's name.
   */
  robots: { index: true, follow: true },
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: BRAND.name,
    locale: "en_IN",
    title: `${BRAND.name} — ${BRAND.tagline}`,
    description:
      "Attendance with GPS and face verification, leave with an approval chain, and payroll that shows its working. By Broadmate Global.",
  },
  twitter: { card: "summary_large_image" },
  category: "business",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#3b4cca" },
    { media: "(prefers-color-scheme: dark)", color: "#1b1d2b" },
  ],
  viewportFit: "cover",
  /**
   * The on-screen keyboard must shrink the page, not slide it.
   *
   * Chrome on Android defaults to `resizes-visual`: focusing a field shrinks
   * the *visual* viewport and leaves the layout viewport — and therefore every
   * `dvh` and every `fixed inset-0` frame — exactly as tall as it was. So the
   * kiosk's footer went under the keyboard the moment somebody tapped "Find
   * your name", and the browser scrolled the field into view on top of that.
   * `resizes-content` makes the frame shrink with the keyboard instead.
   */
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" suppressHydrationWarning>
      <head>
        {/*
          Applies the saved theme before paint so a dark-mode user never sees a
          white flash on first load.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("hrms.theme");var d=window.matchMedia("(prefers-color-scheme: dark)").matches;if(t==="dark"||(t!=="light"&&d))document.documentElement.classList.add("dark");}catch(e){}})();`,
          }}
        />
      </head>
      <body className="min-h-dvh antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
        >
          Skip to content
        </a>
        <OnlineStatus />
        {children}
        <Toaster />
        <InstallPrompt />
        <ServiceWorkerManager />
      </body>
    </html>
  );
}

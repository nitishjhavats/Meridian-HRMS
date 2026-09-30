import { LegalHeader, Section, P, List, Facts, Callout } from "@/components/legal/Prose";
import { LEGAL_CONTACT } from "@/lib/legal";
import { BRAND } from "@/lib/brand";

/**
 * The cookie policy.
 *
 * Short, because the honest answer is short: two strictly necessary cookies, no
 * trackers, no banner. The value of this page is that it names both cookies
 * exactly and commits to adding a consent mechanism before any third cookie
 * arrives — a promise that is checkable, which is the only kind worth making.
 */

export const metadata = {
  title: "Cookie policy",
  description: `The two cookies ${BRAND.name} sets, what else is kept in your browser, and why there is no cookie consent banner.`,
};

export const dynamic = "force-dynamic";

export default function CookiePolicyPage() {
  return (
    <article>
      <LegalHeader
        title="Cookie policy"
        summary={`${BRAND.name} sets two cookies. Both are strictly necessary to sign you in and keep you signed in. There are no analytics cookies, no advertising cookies and no third-party cookies, which is why you are not asked to accept anything.`}
      />

      <Section title="What a cookie is" id="what">
        <P>
          A cookie is a small piece of text that a website asks your browser to store and to send
          back on your next request, so that the site can tell one visit from another.
        </P>
        <P>
          Cookies are not the only way a site can keep something in your browser, so this page also
          covers the two items {BRAND.name} stores outside cookies, and the offline cache the app
          keeps. Everything we place on your device is listed below. Nothing is left out.
        </P>
      </Section>

      <Section title="The cookies we set" id="cookies">
        <P>
          There are exactly two. Both are set by {BRAND.maker.name} from the same address you are
          reading this on &mdash; they are host-only, so they are not shared with any other site or
          subdomain. Both are marked <code>httpOnly</code>, which means no script running in the
          page can read them, and both are marked <code>sameSite=lax</code>, which stops them being
          sent when another site makes a request on your behalf. In production both are also marked{" "}
          <code>secure</code>, so they only travel over HTTPS.
        </P>
        <Facts
          head={["Cookie", "What it is for", "How long it lasts", "Readable by scripts?"]}
          rows={[
            [
              <code key="n">hrms_session</code>,
              "A signed token that records which user you are, which organisation you belong to, your role, and the identifier of this sign-in session. Without it the app cannot tell one request from the next and you cannot sign in.",
              "30 days from your last use, sliding, on a personal account (the deployment can change the number of days); the browser keeps the cookie for up to 400 days but it stops working the moment the sign-in lapses or is revoked. 30 days, fixed, on a shared office-device (kiosk) account, so a shift can be marked without signing in each time.",
              "No. httpOnly.",
            ],
            [
              <code key="n">hrms_impersonation</code>,
              `Set only when a ${BRAND.maker.name} support account is signed in to your organisation's account to look into a problem. Starting one requires a typed reason, and every entry the visit writes to your audit log carries that reason and the support account behind it.`,
              "30 minutes, and it is not renewed. When it expires the support access ends.",
              "No. httpOnly.",
            ],
          ]}
        />
        <P>
          Both cookies are strictly necessary. Neither is used to profile you, to measure your
          behaviour, or for advertising. Neither is shared with anybody.
        </P>
      </Section>

      <Section title="The support access cookie, in plain terms" id="impersonation">
        <P>
          The second cookie deserves a sentence of its own, because it is unusual. When you ask us
          for help with something we cannot reproduce, a {BRAND.maker.name} support account can be
          given temporary access inside your organisation&rsquo;s account. That access is what{" "}
          <code>hrms_impersonation</code> records. It lasts thirty minutes and it cannot be extended
          without starting again. Starting a visit requires a reason to be typed in, and that reason
          is written to your organisation&rsquo;s audit log as the visit begins; every further entry
          the visit writes to that log names the support account behind it. A visit can
          be opened either read-only or with the ability to change things, and which it was is
          recorded when it starts. It is not set during normal use, and it is never set on an
          employee&rsquo;s own device.
        </P>
      </Section>

      <Callout title="There is no cookie banner, and that is deliberate">
        <P>
          Consent is required for cookies that are not strictly necessary &mdash; analytics,
          advertising, preference and tracking cookies. {BRAND.name} sets none of those. Asking you
          to accept two cookies you cannot use the product without would be a formality that teaches
          you to click through consent notices without reading them.
        </P>
        <P>
          If we ever add a cookie that is not strictly necessary, we will build a consent mechanism
          first and ask you before it is set, not after. That is the commitment that makes the
          absence of a banner mean something.
        </P>
      </Callout>

      <Section title="No third-party cookies, because there is no third-party code" id="third-party">
        <P>
          No other organisation can set a cookie through {BRAND.name}, because no other
          organisation&rsquo;s code runs in the page. There is no analytics script, no tag manager,
          no advertising pixel, no error-reporting SDK, no font loaded from an external network, no
          embedded video or map, no CAPTCHA and no iframe.
        </P>
        <P>
          This is enforced by the browser as well as promised by us. The app sends a Content Security
          Policy that permits scripts only from its own address and inline in its own pages (
          <code>script-src &rsquo;self&rsquo; &rsquo;unsafe-inline&rsquo;</code>), limits network
          connections to its own address (<code>connect-src &rsquo;self&rsquo;</code>), restricts
          images to the app&rsquo;s own address and locally generated data (
          <code>img-src &rsquo;self&rsquo; data: blob:</code>), loads fonts only from the app itself (
          <code>font-src &rsquo;self&rsquo; data:</code>), and forbids the app being framed by any
          other site (<code>frame-ancestors &rsquo;none&rsquo;</code>). A script loaded from another
          domain would be blocked rather than silently allowed, and a script that did run inside the
          page could not fetch from or send data to another server.
        </P>
      </Section>

      <Section title="Other things kept in your browser" id="storage">
        <P>
          These are not cookies. They are never sent to the server, and they stay on the device you
          are using.
        </P>
        <List>
          <li>
            <strong>Your theme choice.</strong> One value in local storage recording whether you
            picked the light or the dark appearance, so the app does not flash the wrong one when it
            loads.
          </li>
          <li>
            <strong>The install prompt dismissal.</strong> One timestamp in local storage recording
            the date two weeks after you dismissed the &ldquo;install this app&rdquo; prompt, before
            which it will not be shown to you again.
          </li>
          <li>
            <strong>An offline cache.</strong> A service worker stores the app&rsquo;s shell &mdash;
            its layout, styles, scripts and icons &mdash; so the app opens on a weak connection. It
            never caches responses from the API, so no attendance record, payslip or employee detail
            is written into that cache.
          </li>
        </List>
        <P>
          Neither stored value identifies you. A theme preference and a dismissal timestamp are the
          same for everybody who made the same choice. Clearing your browser data removes all three
          items; the app will simply follow your device&rsquo;s own light or dark setting again and
          re-download its shell.
        </P>
      </Section>

      <Section title="Controlling cookies in your browser" id="control">
        <P>
          Every major browser lets you see the cookies a site has set, delete them, and block them.
          The controls are usually under privacy or site settings, and most browsers also offer them
          for a single site from the padlock icon in the address bar. You do not need our permission
          to use any of it.
        </P>
        <P>
          The honest consequence: <code>hrms_session</code> is how the app knows who you are. If you
          block cookies for this site, or delete that cookie, you will be signed out and you will
          not be able to sign in again until you allow it. There is no alternative sign-in that
          works without it. Blocking cookies more generally in your browser, but allowing them for
          this site, works normally.
        </P>
        <P>
          You can also end a session from inside the app rather than from the browser. Signing out
          clears the cookie, and from your own account you can end another session individually or
          sign out of all your other sessions at once, which is the better option if you have signed
          in on a device you no longer have.
        </P>
      </Section>

      <Section title="Who is responsible for what" id="roles">
        <P>
          When your employer subscribes to {BRAND.name}, that organisation is the Data Fiduciary for
          its employees&rsquo; personal data: it decides what is collected and it is responsible for
          telling its own people. {BRAND.maker.name} is the Data Processor &mdash; we run the
          software and act on the organisation&rsquo;s instructions.
        </P>
        <P>
          The cookies on this page are set by the software itself, so they are the same for every
          organisation. Your employer cannot add cookies to {BRAND.name}, and neither can anyone
          else. If you are an employee with a question about your data more broadly, your first
          point of contact is your own employer, not us.
        </P>
      </Section>

      <Section title="Changes to this policy" id="changes">
        <P>
          If the cookies change, this page changes with them, and the version date at the top is
          updated. A new strictly necessary cookie would be documented here before it is used. A
          cookie that is not strictly necessary would not be set at all until a consent mechanism
          exists and you have used it.
        </P>
      </Section>

      <Section title="Contact" id="contact">
        <P>
          Questions about this policy, or about anything the app stores on your device, can go to our{" "}
          {LEGAL_CONTACT.grievanceRole} at{" "}
          <a href={`mailto:${LEGAL_CONTACT.email}`} className="underline underline-offset-4">
            {LEGAL_CONTACT.email}
          </a>{" "}
          or{" "}
          <a href={`tel:${LEGAL_CONTACT.phoneE164}`} className="underline underline-offset-4">
            {LEGAL_CONTACT.phone}
          </a>
          . If you need to write to us by post, email us first and we will arrange an address for
          the correspondence.
        </P>
        <P>
          More about {BRAND.maker.name} is at{" "}
          <a
            href={BRAND.maker.website}
            className="underline underline-offset-4"
            rel="noreferrer"
          >
            {BRAND.maker.websiteLabel}
          </a>
          .
        </P>
      </Section>
    </article>
  );
}

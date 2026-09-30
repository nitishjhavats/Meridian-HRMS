import { LegalHeader, Section, P, List, Facts, Callout } from "@/components/legal/Prose";
import { LEGAL_CONTACT } from "@/lib/legal";
import { BRAND } from "@/lib/brand";

/**
 * Refund and cancellation policy.
 *
 * Short on purpose. The Consumer Protection (E-Commerce) Rules 2020 expect a
 * refund policy that a customer can find and understand before they pay, not
 * one that hedges. The position is simple — there is a free trial first, so
 * paid periods are not refunded — and saying it plainly is fairer than burying
 * it.
 */
export const metadata = {
  title: "Refund and cancellation policy",
  description:
    "How cancellation works for HRMS, what happens to your data afterwards, and the situations in which Broadmate Global refunds a payment.",
};

export const dynamic = "force-dynamic";

export default function RefundsPage() {
  return (
    <>
      <LegalHeader
        title="Refund and cancellation policy"
        summary={`This policy explains how to cancel a ${BRAND.name} subscription, what happens to your organisation's data when you do, and the specific situations in which ${BRAND.maker.name} refunds money. It applies to every paid subscription taken directly from us.`}
      />

      <Callout title="The short version">
        <p>
          Try it free first. {BRAND.name} offers a free trial with real functionality and no card
          required, so you can decide before any money changes hands. Once a paid period has
          started, it is not refundable.
        </p>
        <p>
          Cancelling means there is no next order to pay; it does not refund the period you are
          already in. We do refund duplicate payments, payments we accepted after you asked to
          cancel, and charges caused by a billing error on our side.
        </p>
      </Callout>

      <Section title="Who this policy is between" id="scope">
        <P>
          This policy is between {BRAND.maker.name} and the organisation that subscribes to{" "}
          {BRAND.name} &mdash; the customer that pays for the seats and holds the account. Employees
          who use {BRAND.name} do not pay us and have no billing relationship with us; anything to
          do with their pay, their leave or their attendance record is a matter for their employer.
        </P>
        <P>
          It covers subscriptions bought directly from us. If you obtained {BRAND.name} through a
          reseller or partner, that party&rsquo;s own refund terms apply to the money you paid them,
          and you should raise a refund with them first.
        </P>
      </Section>

      <Section title="Why paid periods are not refundable" id="why">
        <P>
          A subscription normally starts with a free trial before any money is paid, unless you have
          agreed something different with us in writing. The trial is the full product, not a
          demonstration: you can add employees, mark attendance with the geofence and face check,
          run leave through approval, build payroll rules and generate a payslip. The trial runs for
          14 days by default with a small number of seats, and no card is required to start it.
        </P>
        <P>
          Because you can find out whether {BRAND.name} suits your organisation before paying, we do
          not refund a paid period afterwards. We would rather offer a genuine trial and be firm
          about refunds than offer a short trial and argue about them later.
        </P>
        <P>
          If the trial ended before you had a fair chance to test the product, tell us at{" "}
          {LEGAL_CONTACT.email} before you subscribe. Extending a trial is something we can do; a
          refund after the fact is not.
        </P>
      </Section>

      <Section title="What you are paying for" id="what-you-pay-for">
        <P>
          After the trial, {BRAND.name} is charged per seat per month, and each active employee uses
          a seat. The current price is the one shown on our website at the time you subscribe, and
          it is the price that applies to your subscription. We do not quote a figure in this
          document, because a figure in a legal page goes stale and then misleads.
        </P>
        <P>
          Seats are paid for before the period they cover: an administrator raises an order in the
          product, pays it by UPI, and the seats take effect when we confirm the payment. We do not
          hold a card and nothing renews by itself &mdash; a further period is a further order. A
          billing period runs from the day we confirm the payment, for the number of months that
          payment covered. Where tax is charged on a payment and that payment is later refunded
          under this policy, the tax is refunded with it.
        </P>
      </Section>

      <Section title="Seats added or removed during a period" id="seats">
        <P>
          A seat is used by an active employee; somebody who has resigned, been terminated or been
          marked inactive does not use one. When every seat you have paid for is in use, the product
          refuses to make another employee active until more seats are bought, rather than quietly
          billing you for the extra &mdash; unless we have given you a short grace window while a
          payment clears.
        </P>
        <P>
          Buying more seats mid-period is a fresh order for the total number of seats you want, paid
          before it takes effect. The new period runs from the day we confirm that payment and
          covers all your seats, so you are not charged twice for the seats you already had and
          there is no separate part-period charge to refund.
        </P>
        <P>
          Removing an employee frees their seat for somebody else straight away. It does not reduce
          what you have already paid for and does not produce a refund. The seat count itself comes
          down only when we set it: tell us the number you want before you buy your next period. If
          your headcount moves a great deal month to month, tell us before you subscribe and we will
          agree how to count it.
        </P>
      </Section>

      <Section title="How to cancel" id="how-to-cancel">
        <P>
          Email {LEGAL_CONTACT.email} from an address that belongs to an administrator on the
          account, or call {LEGAL_CONTACT.phone}, and say that you want to cancel. A phone request
          is confirmed in writing before it takes effect, so that a cancellation is never something
          somebody claims was agreed verbally.
        </P>
        <P>
          We treat a cancellation as received on the day your email arrives, not the day we get
          round to it. There is no notice period and no cancellation fee.
        </P>
        <List>
          <li>Your access continues to the end of the period you have already paid for.</li>
          <li>No further charges are taken after that period ends.</li>
          <li>
            Nothing is switched off early, and no feature is withdrawn as a consequence of your
            having cancelled.
          </li>
          <li>
            You can take an export of the organisation&rsquo;s records before the period ends
            &mdash; see below.
          </li>
        </List>
      </Section>

      <Section title="What we do refund" id="what-we-refund">
        <P>
          A refund is owed when we have taken money we should not have taken. That is a question of
          fact, not of goodwill, and we do not argue about it.
        </P>
        <Facts
          head={["Situation", "What we do", "Timeframe"]}
          rows={[
            [
              "Duplicate payment",
              "The extra payment is refunded in full to the method it came from.",
              "Approved within 3 working days of us seeing the evidence.",
            ],
            [
              "Payment accepted after you asked to cancel",
              "Any payment we accepted after the date your cancellation was received is refunded in full.",
              "Approved within 3 working days.",
            ],
            [
              "Billing error on our side",
              "The difference between what you were charged and what you should have been charged is refunded.",
              "Approved within 5 working days of us confirming the error.",
            ],
            [
              "Change of mind, or the product not being used",
              "Not refunded. Cancel, and the next period is not charged.",
              "—",
            ],
          ]}
        />
        <P>
          Approved refunds go back to the account the money came from, by UPI or bank transfer. We
          cannot send the money somewhere else. Once we release a refund, how long it takes to
          appear is up to your bank. We will tell you the date we released it, so you have something
          to quote to them.
        </P>
      </Section>

      <Section title="How to raise a refund" id="raise-a-refund">
        <P>
          Email {LEGAL_CONTACT.email} with the account name, the amount, the date of the payment and
          whatever identifies it &mdash; the order number, or the UPI reference you submitted when
          you confirmed the payment. A screenshot of the statement line is usually enough.
        </P>
        <P>
          We acknowledge refund requests within 2 working days and tell you our decision, with a
          reason, within 7 working days. If a request is refused, the reason will point at the part
          of this policy it rests on.
        </P>
        <P>
          If you think a payment is wrong, please raise it with us before asking your bank to
          reverse it. A bank dispute takes weeks; an email to us is usually settled in days.
        </P>
      </Section>

      <Section title="Your data after cancellation" id="data-after-cancellation">
        <P>
          Cancelling is not the same as deleting. Nothing is held hostage against payment, and
          nothing is erased the moment you stop paying.
        </P>
        <List>
          <li>
            When the paid period ends, the account becomes read-only. Administrators can still sign
            in and read what is there. Nothing new can be recorded, and it stays that way until you
            pay for another period or ask us to close the account.
          </li>
          <li>
            Take your export before the paid period ends. An administrator can export the
            organisation&rsquo;s records &mdash; employees, attendance, leave and payroll &mdash; as
            an encrypted archive. Encrypted identifiers such as PAN, Aadhaar and bank details are
            redacted from it, and uploaded files are described rather than included.
          </li>
          <li>
            Generating an export and downloading one both count as activity the read-only state
            blocks, so neither works once the paid period has ended. A generated export file is
            deleted 48 hours after it is created, for its own safety, and you can generate another
            while the account is still active.
          </li>
          <li>
            If you need an export after the period has ended, email us. We will re-open the account
            for long enough for an administrator to take one.
          </li>
          <li>
            Nothing is deleted because you stopped paying. The records stay as they are until you
            ask us in writing to delete them; we then delete them from the live system and tell you
            when it is done.
          </li>
        </List>
        <P>
          Export while the account is still active. Indian payroll and employment records carry
          statutory retention obligations that fall on you as the employer, not on us, and once your
          data is deleted we cannot produce it again.
        </P>
      </Section>

      <Section title="What this policy does not promise" id="limits">
        <P>
          We do not offer an uptime service level agreement, and there are therefore no service
          credits for downtime. Saying so plainly is more useful to you than implying a guarantee we
          have not made. We work to keep {BRAND.name} available and we will tell you what happened
          when it is not.
        </P>
        <P>
          If a fault on our side genuinely prevents you from using {BRAND.name} for a sustained
          period, write to us. We will look at the period in question and decide what is fair, which
          may include extending your subscription. That is a case-by-case judgement, not an
          entitlement created by this policy.
        </P>
        <P>
          This policy does not cover money you pay to anybody else &mdash; a third-party AI provider
          you use your own key with, your bank&rsquo;s charges, or a reseller&rsquo;s fees.
        </P>
      </Section>

      <Section title="Disputes and grievances" id="disputes">
        <P>
          If you are not satisfied with a decision on a refund, cancellation or charge, write to{" "}
          {LEGAL_CONTACT.email} with &ldquo;{LEGAL_CONTACT.grievanceRole}&rdquo; in the subject
          line, or call {LEGAL_CONTACT.phone}. Say what you asked for, what we said, and what you
          think the right outcome is.
        </P>
        <P>
          As the Consumer Protection (E-Commerce) Rules 2020 require, we acknowledge a grievance
          within 48 hours of receiving it and resolve it within one month. In practice most billing
          questions are settled the same week, and we will keep you informed rather than letting the
          month run down in silence.
        </P>
        <P>
          We do not publish a postal address. If you need to send us something on paper, email{" "}
          {LEGAL_CONTACT.email} first and we will arrange where to send it.
        </P>
      </Section>

      <Section title="Governing law" id="law">
        <P>
          This policy is governed by the laws of India, and the courts of India have jurisdiction
          over any dispute arising from it. Nothing here removes a right you have under the Consumer
          Protection Act 2019 or the Consumer Protection (E-Commerce) Rules 2020; where this policy
          and those rights disagree, those rights win.
        </P>
      </Section>

      <Section title="Changes to this policy" id="changes">
        <P>
          If we change this policy, the version date at the top of the page changes with it. A
          change never applies backwards: the policy that governs a payment is the one published on
          the day the payment was taken. We tell account administrators about substantive changes
          before they take effect.
        </P>
      </Section>

      <Section title="Contact" id="contact">
        <P>
          {BRAND.maker.name}, maker of {BRAND.name}. For anything about billing, cancellation or
          refunds:
        </P>
        <List>
          <li>
            Email: <a href={`mailto:${LEGAL_CONTACT.email}`}>{LEGAL_CONTACT.email}</a>
          </li>
          <li>
            Phone: <a href={`tel:${LEGAL_CONTACT.phoneE164}`}>{LEGAL_CONTACT.phone}</a>
          </li>
          <li>
            Website:{" "}
            <a href={BRAND.maker.website} rel="noreferrer">
              {BRAND.maker.websiteLabel}
            </a>
          </li>
        </List>
        <P>
          Please include the account name and the date of the charge in a billing email. It saves a
          round of questions and gets the money back to you sooner.
        </P>
      </Section>
    </>
  );
}

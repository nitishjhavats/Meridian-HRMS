import { LegalHeader, Section, P, List, Facts, Callout } from "@/components/legal/Prose";
import { LEGAL_CONTACT } from "@/lib/legal";
import { BRAND } from "@/lib/brand";

/**
 * The privacy policy.
 *
 * Written against what the code actually does — the two cookies, the two
 * sub-processors, the real retention windows — rather than against a template.
 * If the code changes, this page is wrong until it is changed with it.
 */
export const metadata = {
  title: "Privacy policy",
  description:
    "How Broadmate Global handles personal data in HRMS: what is collected, what is encrypted, how face verification and location work, who else sees it, and how long it is kept.",
};

export const dynamic = "force-dynamic";

export default function PrivacyPolicyPage() {
  return (
    <article>
      <LegalHeader
        title="Privacy policy"
        summary={`How personal data is handled in ${BRAND.name}, the HR, attendance, leave and payroll software made by ${BRAND.maker.name}. This page describes the software and what ${BRAND.maker.name} does with the data inside it. Your employer decides what goes in.`}
      />

      <Callout title="If you are an employee and you are here about the face check">
        <p>
          Your face photo and the numeric template derived from it are processed on our own
          server. No image and no template is sent to any other service, and no advertising or
          analytics code runs anywhere in this product. Enrolment is refused unless a consent
          record exists, and removing your reference photo deletes the template with it. The
          detail is in <a href="#biometrics">Face verification</a>. Ask your employer first &mdash;
          they control your record, not us.
        </p>
      </Callout>

      <Section title="Who we are, and who is responsible for your data" id="roles">
        <P>
          {BRAND.name} is made and operated by {BRAND.maker.name} ({BRAND.maker.websiteLabel}). We
          are not a company registered under that name; &ldquo;we&rdquo; in this document means{" "}
          {BRAND.maker.name}. We do not publish a postal address. If you need to write to us on
          paper, email {LEGAL_CONTACT.email} and we will arrange it.
        </P>
        <P>
          The software is multi-tenant. Each customer organisation has its own separated space and
          puts its own employees&rsquo; data into it. That matters for who is accountable:
        </P>
        <List>
          <li>
            <strong>The customer organisation is the Data Fiduciary</strong> (the controller). It
            decides which employees are added, which fields are filled in, whether face
            verification and geofencing are switched on, and what it does with the results. Under
            the Digital Personal Data Protection Act 2023 it carries the duties owed to its
            employees, including telling them what it collects and why.
          </li>
          <li>
            <strong>{BRAND.maker.name} is the Data Processor.</strong> We run the software and
            process the data on the organisation&rsquo;s instructions. We do not decide what an
            organisation collects about its people, and we do not use that data for our own
            purposes.
          </li>
          <li>
            <strong>Employees are Data Principals.</strong> Their first point of contact is their
            own employer, not us.
          </li>
        </List>
        <P>
          We are a Data Fiduciary in our own right for one narrow thing: the account and billing
          details of the person who signs an organisation up, and our own support correspondence.
        </P>
      </Section>

      <Section title="If you are an organisation using HRMS" id="for-organisations">
        <P>
          You own your data. We hold it to run the service for you. Practically, this means:
        </P>
        <List>
          <li>
            You choose what to collect. Most fields in an employee record are optional and blank
            until somebody fills them in.
          </li>
          <li>
            You are responsible for telling your employees that you use this software, what it
            records, and why &mdash; particularly the face check and the location capture at the
            moment of marking attendance. We give you the facts on this page to make that notice
            accurate. We do not send that notice for you.
          </li>
          <li>
            You must have a lawful basis for what you switch on. Face templates and bank and
            statutory identifiers are sensitive personal data under the Information Technology
            (Reasonable Security Practices and Procedures and Sensitive Personal Data or
            Information) Rules 2011.
          </li>
          <li>
            You can export your organisation&rsquo;s records yourself, as an encrypted archive,
            without asking us. It is a copy of the database tables rather than of literally
            everything: the encrypted columns &mdash; PAN, Aadhaar, bank details, authentication
            secrets &mdash; come out as &ldquo;[redacted]&rdquo;, uploaded files appear as metadata
            rather than as bytes, sign-in and password-reset telemetry is left out, and the audit
            log is capped at the ten thousand most recent entries. The archive says all of this
            about itself.
          </li>
          <li>
            We act on your instructions. If you tell us to delete something, we delete it. If one of
            your employees asks us directly, we will normally refer them to you, because the record
            is yours.
          </li>
        </List>
      </Section>

      <Section title="If you are an employee whose employer uses HRMS" id="for-employees">
        <P>
          Your employer put your details into this system and decided what to record. We process
          them for your employer. So:
        </P>
        <List>
          <li>
            To see, correct or remove something in your record, ask your employer&rsquo;s HR or
            administrator first. They can do it. We generally cannot act on your instruction alone,
            because the data is not ours to change.
          </li>
          <li>
            You can export your own record from within the app without going through anyone. PAN,
            Aadhaar, bank account and UAN appear in that file masked to their last four digits, so
            that a download sitting in a folder is not a copy of your identity documents; the full
            values are visible to you inside the app.
          </li>
          <li>
            If you have raised something with your employer and it has not been dealt with, you can
            write to us at {LEGAL_CONTACT.email}. We will pass it to the organisation, tell you we
            have done so, and help where the answer is technical rather than a matter for your
            employer.
          </li>
          <li>
            Nothing here removes your right to complain to the Data Protection Board of India.
          </li>
        </List>
      </Section>

      <Section title="What is collected and how it is stored" id="what-we-hold">
        <P>
          The table below is the full picture, by category. Be aware of the distinction in the last
          column: identifiers that could be used to impersonate you or to reach your money are
          encrypted at rest with AES-256-GCM, and most ordinary directory fields are not &mdash;
          they sit in plain form inside the database, protected by access control, per-organisation
          separation and the security of the server, not by their own encryption.
        </P>
        <Facts
          head={["Category", "What it can include", "How it is stored"]}
          rows={[
            [
              "Account and sign-in",
              "Name, work email, role, the organisation you belong to, password, sessions, and optionally two-factor authentication",
              "The password is stored only as a bcrypt hash. It is never stored in readable form and cannot be read back or recovered by us.",
            ],
            [
              "Directory and personal details",
              "Name, date of birth, gender, personal and work email, phone number, postal address, emergency contact name, phone and relationship, blood group",
              "Plain, in the database",
            ],
            [
              "Employment record",
              "Joining, confirmation and exit dates, department, designation, work location, shift",
              "Plain, in the database",
            ],
            [
              "Statutory and financial identifiers",
              "PAN, the last four digits of an Aadhaar number, bank name, account number, IFSC, UAN, PF number",
              "Encrypted at rest with AES-256-GCM. Only four digits of an Aadhaar number are held — enough to confirm which number you mean, and not enough to be used as an identity.",
            ],
            [
              "Face template",
              "A numeric template derived from an enrolled reference photo, plus the date consent was recorded",
              "Encrypted at rest with AES-256-GCM. It is never returned by any API.",
            ],
            [
              "Attendance marks",
              "Server time, coordinates rounded to about one metre, GPS accuracy, distance from the assigned work location, whether it was inside the geofence, the selfie, and the face-match result",
              "Plain, then trimmed automatically on the schedule below",
            ],
            [
              "Payroll",
              "Salary structure and components, deductions, payslips and payroll runs",
              "Plain, in the database. It is the record your organisation must be able to reproduce.",
            ],
            [
              "Files and documents",
              "Profile photo, attendance selfies, and documents your organisation uploads",
              "In the database, in a private Supabase Storage bucket, or on the server's own disk, depending on how the deployment is configured. Never in a public bucket: every read goes through an authorised route rather than a public link. EXIF metadata — which carries a second copy of GPS coordinates and the device serial — is stripped from every uploaded image when it is re-encoded. PDFs are stored as uploaded, so a PDF's own internal metadata is left as it came.",
            ],
            [
              "Records of use",
              "Audit log entries for changes, sign-in attempts including failed ones with the email typed and the IP address, and device details such as browser, platform and screen size",
              "Plain, then trimmed automatically on the schedule below",
            ],
          ]}
        />
        <P>
          We take no data from anywhere else. There is no enrichment, no data broker, no scraping,
          no import from social accounts. Everything in an organisation&rsquo;s space was put there
          by that organisation or by its employees using the app.
        </P>
      </Section>

      <Section title="Face verification" id="biometrics">
        <P>
          Face verification is optional and is switched on by the organisation. When it is on, an
          attendance mark is checked against an enrolled reference photo. Here is exactly how that
          works.
        </P>
        <List>
          <li>
            <strong>Enrolment.</strong> A reference photo is taken. From it, the server derives a
            face template &mdash; a list of numbers describing measurable features of the face. It
            is not a picture and cannot be displayed as one, but it identifies you and is treated as
            biometric data.
          </li>
          <li>
            <strong>Where it happens.</strong> The template is derived and every later comparison is
            made entirely on our own server, by models running inside the application process. No
            image and no template is sent to any third party, any cloud vision service, or any AI
            provider. There is no exception to this.
          </li>
          <li>
            <strong>Consent is a precondition.</strong> Enrolment is refused unless a consent record
            exists. The employee, or an administrator confirming the employee has agreed, must tick
            the consent box, and the date is stored alongside the record. There is no path through
            the software that enrols a face without one.
          </li>
          <li>
            <strong>Storage.</strong> The template is encrypted at rest with AES-256-GCM and is
            never returned by any API &mdash; not to an administrator, not to a report, not to an
            export.
          </li>
          <li>
            <strong>Withdrawal.</strong> Consent can be withdrawn by removing the reference photo.
            Deleting it deletes the template with it. Ask your administrator, who can do this from
            your employee record. Withdrawing it stops future face checks; it does not erase past
            attendance records, which remain as payroll evidence.
          </li>
        </List>
        <P>
          A face template is sensitive personal data under the SPDI Rules 2011 and is treated as
          such throughout. If your employer has made face verification a condition of marking
          attendance, that is your employer&rsquo;s decision, and it is a question for them.
        </P>
      </Section>

      <Section title="Location" id="location">
        <P>
          Location is recorded only at the instant an attendance mark is made. The app does not
          track you in the background, does not record a route, and has nothing to record between
          marks.
        </P>
        <List>
          <li>
            What is stored with a mark: coordinates rounded to about one metre, the accuracy your
            device reported, the distance from the assigned work location, and whether that put you
            inside the geofence.
          </li>
          <li>
            The time on the record is taken from our server, never from your device. That is a
            correctness measure &mdash; a device clock can be changed &mdash; and it means the time
            is reliable evidence for payroll.
          </li>
          <li>
            Coordinates are cleared automatically on the retention schedule below, together with the
            IP address and device details. What survives is the fact of attendance: the day, the
            time, and whether the fence and face checks passed.
          </li>
          <li>
            If your device or browser refuses location permission, the mark cannot record a
            position. Whether that is accepted is a matter for your employer&rsquo;s policy, not
            ours.
          </li>
        </List>
      </Section>

      <Section title="Cookies and what is stored in your browser" id="cookies">
        <P>
          Two cookies, both strictly necessary, both <code>httpOnly</code>, both{" "}
          <code>sameSite=lax</code> and host-only, and both secure in production:{" "}
          <code>hrms_session</code>, which keeps you signed in, and{" "}
          <code>hrms_impersonation</code>, set only while our support is acting inside a
          customer&rsquo;s account and expiring after 30 minutes without renewal.
        </P>
        <P>
          There are no analytics, advertising or preference cookies, so there is no consent banner
          to click through. The browser also keeps two small local settings &mdash; your light or
          dark theme choice, and a timestamp noting that you dismissed the &ldquo;install this
          app&rdquo; prompt &mdash; and a service worker cache of the app shell and static files.
          The service worker never caches API responses. The full detail is in the{" "}
          <a href="/legal/cookies">cookie policy</a>.
        </P>
      </Section>

      <Section title="Who else touches the data" id="sub-processors">
        <P>
          There is no third-party code in your browser at all: no analytics, no tag manager, no
          advertising pixel, no error-reporting SDK, no font CDN, no embedded video or map, no
          CAPTCHA, no iframes. This is enforced by a Content-Security-Policy that permits scripts
          and network connections only from this site, and forbids the page being framed at all.
        </P>
        <P>
          On the server, apart from the infrastructure the application and its database run on, only
          two outside services ever receive anything, and only in the circumstances below.
        </P>
        <Facts
          head={["Service", "When it is used", "What is sent"]}
          rows={[
            [
              "OpenRouter (openrouter.ai)",
              "Only if your organisation uses the optional AI features",
              "For letter drafting: the type of letter and the administrator's own typed instruction. The model writes a template full of {{placeholders}}; real employee values are substituted locally afterwards. For editing a letter framework: the current header, body or footer text — which is placeholder text, not any one person's letter — and the instruction. For AI payroll-rule generation: the organisation's payroll rule configuration — component names, percentages, thresholds — and the administrator's instruction. The product itself puts no employee record, name or salary figure into any of these requests; what an administrator types into the instruction box is sent as they wrote it, so they should not type such details there either. An organisation may use its own OpenRouter key; if it has not set one, ours is used.",
            ],
            [
              "Supabase Storage",
              "Only if the deployment is configured to store uploaded files there rather than in the database",
              "Uploaded files: attendance selfies, profile photos and documents. They are held in a private bucket, not a public one.",
            ],
          ]}
        />
        <P>
          Nothing else leaves the server. If that ever changes, this list changes with it before the
          feature ships.
        </P>
      </Section>

      <Section title="How long things are kept" id="retention">
        <P>
          Some of this is automatic and runs whether anyone asks for it or not. The periods below
          are the ones in the running system; the first two are configurable by the platform owner
          and 60 days is the current setting.
        </P>
        <Facts
          head={["What", "Removed after", "What remains"]}
          rows={[
            [
              "Attendance selfies",
              "60 days",
              "The attendance record itself, without the photograph",
            ],
            [
              "Coordinates, IP address and device details on an attendance record",
              "60 days, cleared on the same run",
              "The day, the time, whether the geofence and face checks passed — kept because it is payroll evidence",
            ],
            [
              "Sign-in attempt records, including failed attempts with the email typed and the IP address",
              "90 days",
              "Nothing",
            ],
            [
              "IP address and browser details on audit log entries",
              "180 days",
              "The audit entry itself: who changed what, and when. Audit entries are kept, because they are the payroll audit trail.",
            ],
            [
              "Chat messages between employees",
              "30 days",
              "Nothing. The conversation itself is removed once it is empty.",
            ],
            [
              "Encrypted data exports",
              "48 hours after they are generated",
              "Nothing. Download it and keep it somewhere safe.",
            ],
            [
              "Employee records, payroll history and documents",
              "Not automatic",
              "Held while your organisation has an account, and deleted when your organisation deletes them or instructs us to. We do not silently purge a customer's records, and we do not keep them against a customer's instruction.",
            ],
          ]}
        />
      </Section>

      <Section title="Messages between colleagues" id="chat">
        <P>
          If your organisation has switched chat on, you can send direct messages to colleagues.
          What that means for your data is worth being exact about, because the promise has two
          halves that sound contradictory and are not.
        </P>
        <P>
          <strong>Nobody can delete a message.</strong> Not you, not the person you sent it to, not
          an administrator, not us. There is no delete anywhere in the software. And{" "}
          <strong>every message disappears after 30 days</strong>, automatically, whether anyone
          wants it to or not. Those are the same policy seen from two sides: nothing can be quietly
          removed from a conversation, and nothing is kept forever.
        </P>
        <P>
          Messages are private between the two of you. They are <strong>not</strong> included in the
          data export your organisation&rsquo;s owner can download &mdash; deliberately, because
          that file is described to them as their organisation&rsquo;s data and it must not be the
          thing that hands them every private conversation in the company.
        </P>
        <P>
          There is one exception, and it is the reason this section exists. An administrator or the
          organisation&rsquo;s owner can <strong>export one conversation</strong> &mdash; for
          example when somebody reports it. Doing so requires them to write down why, records their
          name and that reason on your organisation&rsquo;s audit log, and, by default,{" "}
          <strong>notifies both people that it happened and what reason was given</strong>. They can
          turn that notification off, and turning it off is itself recorded.
        </P>
        <P>
          You can block somebody. Their messages then never reach you, and they are not told &mdash;
          being told you have been blocked is what makes blocking risky for the person who needed
          it. You can also report a conversation, which sends it to your HR team and administrators
          along with your reason.
        </P>
        <P>
          A limit of 50 messages a day per person applies. It is there to stop the feature being
          used to flood somebody.
        </P>
      </Section>

      <Section title="Why we are allowed to hold this" id="grounds">
        <P>
          Your employer holds your data because it needs to in order to employ you &mdash; to run
          attendance, leave, payroll, and the statutory filings that go with them. Under the Digital
          Personal Data Protection Act 2023 that is a legitimate use for employment purposes. Where
          consent is the basis rather than employment necessity &mdash; face enrolment being the
          clear case &mdash; the software requires the consent record before it will proceed.
        </P>
        <P>
          Biometric, financial and health-related details are sensitive personal data under the SPDI
          Rules 2011, which is why they are the fields we encrypt and why section 43A of the
          Information Technology Act 2000 &mdash; reasonable security practices for such data
          &mdash; shapes how they are handled. We hold all of it as a processor, on your
          employer&rsquo;s instructions.
        </P>
      </Section>

      <Section title="Your rights, and how to use them" id="rights">
        <P>
          Under the Digital Personal Data Protection Act 2023 you have the right to know what is
          held about you, to have it corrected or completed, to have it erased where it is no longer
          needed, to nominate someone to act for you, and to have a grievance answered. Because your
          employer is the Data Fiduciary, these are exercised through your employer. The machinery
          to answer them exists in the product today:
        </P>
        <List>
          <li>
            <strong>See what is held.</strong> An employee can export their own record. An
            organisation can export its records as an encrypted archive, with the two limits noted
            above: encrypted identifiers are redacted and uploaded files appear as metadata.
          </li>
          <li>
            <strong>Correct it.</strong> Your administrator can edit any field in your record. Every
            change is written to the audit log.
          </li>
          <li>
            <strong>Delete a document.</strong> Documents are removed through a request-and-approval
            flow, so a deletion has a record and an approver.
          </li>
          <li>
            <strong>Withdraw face consent.</strong> Removing the reference photo deletes the face
            template.
          </li>
          <li>
            <strong>End sessions.</strong> Sessions can be revoked one at a time or all at once, on
            all devices.
          </li>
          <li>
            <strong>See what was done.</strong> An organisation can read its own audit log.
          </li>
        </List>
        <P>
          Ask your employer first. If they have not answered, write to {LEGAL_CONTACT.email} and we
          will route it and help with the technical part. Some things cannot be undone by anyone:
          attendance and payroll records are evidence your employer may be required to keep, and a
          password cannot be retrieved because it was never stored in readable form.
        </P>
      </Section>

      <Section title="Security" id="security">
        <P>
          What is in place, stated plainly and without adjectives:
        </P>
        <List>
          <li>HTTPS is enforced, with HSTS, and the usual protective response headers are set.</li>
          <li>
            A Content-Security-Policy restricts scripts and network connections to this site and
            forbids the page being framed.
          </li>
          <li>Passwords are hashed with bcrypt. Two-factor authentication is available.</li>
          <li>
            PAN, Aadhaar, bank details, UAN, PF number and face templates are encrypted at rest with
            AES-256-GCM.
          </li>
          <li>
            Each organisation&rsquo;s data is separated from every other organisation&rsquo;s, and
            that separation is enforced in the application layer on every request.
          </li>
          <li>Sign-in and password reset are rate limited.</li>
          <li>
            Support can only act inside a customer&rsquo;s account through an impersonation session
            that is recorded, expires in 30 minutes and cannot be renewed.
          </li>
          <li>Every change of consequence is written to an audit log the organisation can read.</li>
        </List>
        <P>
          We do not claim the system is impossible to breach, and you should not believe anyone who
          claims that of theirs. We also do not promise an uptime guarantee. If we become aware of a
          personal data breach affecting an organisation&rsquo;s data, we will tell that organisation
          without undue delay and give it what it needs to meet its own obligations under the Digital
          Personal Data Protection Act 2023.
        </P>
      </Section>

      <Section title="What we do not do" id="what-we-do-not-do">
        <P>
          Short list, all of it true today and all of it verifiable by looking at what the app
          loads:
        </P>
        <List>
          <li>
            <strong>We do not sell your data</strong>, or share it with anyone for money, ever.
          </li>
          <li>
            <strong>We do not train models on customer data.</strong> No employee record, payslip,
            selfie or face template is used to train or fine-tune anything.
          </li>
          <li>
            <strong>We run no advertising</strong> and there is no advertising or marketing pixel
            anywhere in the product.
          </li>
          <li>
            <strong>We use no third-party analytics or trackers.</strong> Not one. No Google
            Analytics, no tag manager, no session recorder, no heatmap tool, no error-reporting SDK,
            no third-party fonts.
          </li>
          <li>
            <strong>The product sends no email at all.</strong> Not notifications, not marketing, not
            even a password reset. Password resets are handled by a person: an administrator issues a
            code and hands it over directly. If you receive an email claiming to be a password reset
            for this product, it did not come from the product.
          </li>
          <li>
            <strong>We do not read your data for our own purposes.</strong> Running the accounts
            means our platform console shows us account-level information without impersonation
            &mdash; an organisation&rsquo;s name and status, its administrator logins with their
            names, emails and last sign-in, its headcount and its billing. Anything inside the
            records themselves &mdash; an employee&rsquo;s details, attendance, payroll or documents
            &mdash; is reached only through the recorded, time-limited impersonation session
            described above.
          </li>
        </List>
      </Section>

      <Section title="Where data is processed" id="transfers">
        <P>
          The application, its database and the face-matching models run on servers operated for{" "}
          {BRAND.maker.name}. Face templates are derived and matched on those servers and go nowhere
          else.
        </P>
        <P>
          There are two ways data can leave India, and only two. The first is the optional AI
          features: if your organisation uses them, the request goes to OpenRouter, a service based
          outside India. What is sent is described above &mdash; instructions and configuration, not
          employee records. If your organisation would rather nothing went to a model at all, do not
          switch the AI features on. The second is file storage: where a deployment keeps uploaded
          files in Supabase Storage, they sit in whichever region that bucket is configured for,
          which may be outside India. Ask us and we will tell you which one applies to your
          account.
        </P>
      </Section>

      <Section title="Children" id="children">
        <P>
          This is workplace software for adults in employment. It is not directed at children and is
          not to be used by anyone under 18. We do not knowingly hold the personal data of a child.
          If a customer organisation has entered a child&rsquo;s details, tell us at{" "}
          {LEGAL_CONTACT.email} and we will work with that organisation to remove them.
        </P>
      </Section>

      <Section title="Changes to this policy" id="changes">
        <P>
          The version date at the top of this page changes when the substance changes, not for a
          typo. If we change something material &mdash; a new sub-processor, a different retention
          period, a new category of data &mdash; we will update this page before the change reaches
          production and tell customer organisations. Existing customers keep the version they
          accepted for the purposes of their agreement.
        </P>
      </Section>

      <Section title="Contact and grievances" id="contact">
        <P>
          For anything about this policy, or to raise a grievance, write to our{" "}
          {LEGAL_CONTACT.grievanceRole}:
        </P>
        <List>
          <li>
            Email: <a href={`mailto:${LEGAL_CONTACT.email}`}>{LEGAL_CONTACT.email}</a>
          </li>
          <li>
            Phone: <a href={`tel:${LEGAL_CONTACT.phoneE164}`}>{LEGAL_CONTACT.phone}</a>
          </li>
          <li>
            Website: <a href={BRAND.maker.website}>{BRAND.maker.websiteLabel}</a>
          </li>
        </List>
        <P>
          We do not publish a postal address. If correspondence has to be on paper, email us and we
          will arrange where to send it. We aim to acknowledge a grievance within a few working days
          and to resolve it, or explain why we cannot, within thirty.
        </P>
        <P>
          If you are an employee, please raise it with your employer first &mdash; they hold your
          record and can usually fix it the same day. If that route fails, come to us, and you may
          also complain to the Data Protection Board of India.
        </P>
      </Section>
    </article>
  );
}

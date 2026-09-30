// Imported explicitly: this module is also rendered outside Next.js (scripts,
// jobs), where the automatic JSX runtime is not configured.
import React from "react";
import {
  Document,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";
import { PDF_FONT, PDF_FONT_BOLD } from "./fonts";

/**
 * Letter PDFs.
 *
 * Deliberately plain. A letter of employment is a document somebody may show to
 * a bank or a visa officer, so it is laid out to be read and photocopied rather
 * than to look designed: black text, generous margins, no colour that fails on
 * a monochrome printer.
 *
 * No fonts are registered, so the built-in Helvetica is used. Registering a web
 * font would mean a network fetch during PDF generation, which is a failure mode
 * nobody wants on the issue button.
 */

const styles = StyleSheet.create({
  /**
   * Large, pale, and rotated across the middle of the page.
   *
   * `position: absolute` with `fixed` so it repeats on every page of a long
   * letter, and a grey light enough to read the text through — a watermark that
   * makes the document unreadable gets screenshotted with the mark cropped out,
   * which defeats the purpose.
   */
  watermark: {
    position: "absolute",
    top: 320,
    left: 40,
    right: 40,
    textAlign: "center",
    fontSize: 68,
    letterSpacing: 8,
    color: "#e2e5ec",
    transform: "rotate(-28deg)",
  },
  page: {
    paddingTop: 48,
    paddingBottom: 64,
    paddingHorizontal: 56,
    fontSize: 10.5,
    lineHeight: 1.6,
    color: "#111111",
    fontFamily: PDF_FONT,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: "#111111",
    paddingBottom: 10,
    marginBottom: 24,
  },
  identity: { flexDirection: "row", alignItems: "flex-start", gap: 10, maxWidth: 340 },
  identityText: { flexShrink: 1 },
  logo: { width: 52, height: 52, objectFit: "contain" },
  orgStatutory: { fontSize: 7.5, color: "#666666", marginTop: 2, maxWidth: 260 },
  orgName: { fontSize: 15, fontFamily: PDF_FONT_BOLD, fontWeight: 700 },
  orgAddress: { fontSize: 8.5, color: "#555555", marginTop: 2, maxWidth: 240 },
  metaBlock: { alignItems: "flex-end" },
  meta: { fontSize: 8.5, color: "#555555" },
  subject: {
    fontSize: 11.5,
    fontFamily: PDF_FONT_BOLD, fontWeight: 700,
    marginBottom: 14,
    textDecoration: "underline",
  },
  paragraph: { marginBottom: 10, textAlign: "justify" },
  // A row now, so the seal can sit beside the signature rather than under it.
  // The content width is 483 pt and the signature column is 110, so there is
  // room for both without either being squeezed.
  signatureBlock: { marginTop: 36, flexDirection: "row", alignItems: "flex-end" },
  signatureColumn: { flexGrow: 1 },
  signatureImage: { width: 110, height: 40, objectFit: "contain", marginBottom: 4 },
  // Beside, not over. An overlapping seal looks more like a real letter and
  // reliably obscures the one line nobody can afford to have obscured — the
  // name of the person who signed it.
  stampImage: { width: 90, height: 90, objectFit: "contain", marginLeft: 24 },
  signatoryName: { fontFamily: PDF_FONT_BOLD, fontWeight: 700 },
  signatoryTitle: { fontSize: 9, color: "#555555" },
  footer: {
    position: "absolute",
    bottom: 28,
    left: 56,
    right: 56,
    borderTopWidth: 0.5,
    borderTopColor: "#cccccc",
    paddingTop: 6,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  footerText: { fontSize: 7.5, color: "#888888" },
  headerNote: { marginTop: 18 },
  headerNoteText: { fontSize: 9, color: "#555555", lineHeight: 1.4 },
});

export interface LetterPdfInput {
  organization: {
    name: string;
    address?: string | null;
    logoDataUri?: string | null;
    /** Beneath the address, on one line: phone, email, website. */
    contact?: string | null;
    /** Beneath that: CIN, GSTIN and whatever else the organisation chose to show. */
    statutory?: string | null;
  };
  letterNumber: string;
  issuedOn: string;
  subject: string;
  /** Already rendered — no placeholders remain by the time this is called. */
  body: string;
  /**
   * Extra lines under the organisation block, above the subject — a
   * confidentiality marking, a registered name and CIN, "to whomsoever it may
   * concern". Plain text, rendered one line per newline.
   */
  headerText?: string | null;
  signatory?: { name?: string | null; title?: string | null; signatureDataUri?: string | null };
  /**
   * Drawn diagonally across the page, behind the text.
   *
   * A preview of a letter that is not finished must not be mistakable for one
   * that was issued — the two are the same document but only one of them is a
   * commitment. It is also what makes it safe to render a draft at all: a
   * preview shows `[Monthly salary]` where a value is still missing, and that
   * page should never be able to reach an employee looking like the real thing.
   */
  watermark?: string | null;
  /** The company seal, if the organisation has uploaded one. */
  stampDataUri?: string | null;
  footerNote?: string;
}

/**
 * Splits the body into paragraphs.
 *
 * Blank lines separate paragraphs; single newlines inside one are treated as
 * soft wraps, because people composing in a textarea use both and mean the same
 * thing by a single break.
 */
function paragraphs(body: string): string[] {
  return body
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\n/g, " ").trim())
    .filter((p) => p.length > 0);
}

function LetterDocument(input: LetterPdfInput) {
  const blocks = paragraphs(input.body);

  return (
    <Document
      title={`${input.subject} — ${input.letterNumber}`}
      author={input.organization.name}
      creator={input.organization.name}
    >
      <Page size="A4" style={styles.page}>
        {/* First child, so everything else paints over it. `@react-pdf` has no
            z-index; order in the tree is the order on the page. */}
        {input.watermark ? (
          <Text fixed style={styles.watermark}>
            {input.watermark}
          </Text>
        ) : null}
        {/* Logo *and* name, side by side. The logo used to replace the name
            entirely, so an organisation whose logo is a bare glyph had no name
            anywhere in its own letterhead — the one thing a letterhead is
            for. */}
        <View style={styles.header} fixed>
          <View style={styles.identity}>
            {input.organization.logoDataUri ? (
              <Image style={styles.logo} src={input.organization.logoDataUri} />
            ) : null}
            <View style={styles.identityText}>
              <Text style={styles.orgName}>{input.organization.name}</Text>
              {input.organization.address ? (
                <Text style={styles.orgAddress}>{input.organization.address}</Text>
              ) : null}
              {input.organization.contact ? (
                <Text style={styles.orgAddress}>{input.organization.contact}</Text>
              ) : null}
              {input.organization.statutory ? (
                <Text style={styles.orgStatutory}>{input.organization.statutory}</Text>
              ) : null}
            </View>
          </View>
          <View style={styles.metaBlock}>
            <Text style={styles.meta}>Ref: {input.letterNumber}</Text>
            <Text style={styles.meta}>Date: {input.issuedOn}</Text>
          </View>
        </View>

        {input.headerText?.trim() ? (
          <View style={styles.headerNote}>
            {input.headerText
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean)
              .map((line, i) => (
                <Text key={i} style={styles.headerNoteText}>
                  {line}
                </Text>
              ))}
          </View>
        ) : null}

        <Text style={styles.subject}>{input.subject}</Text>

        {blocks.map((block, i) => (
          <Text key={i} style={styles.paragraph}>
            {block}
          </Text>
        ))}

        {/* Rendered when there is a signatory *or* a seal. The gate used to be
            the name alone, so an organisation that had uploaded a stamp and left
            the signatory blank would have printed neither. */}
        {input.signatory?.name || input.stampDataUri ? (
          <View style={styles.signatureBlock} wrap={false}>
            <View style={styles.signatureColumn}>
              {input.signatory?.signatureDataUri ? (
                <Image style={styles.signatureImage} src={input.signatory.signatureDataUri} />
              ) : null}
              {input.signatory?.name ? (
                <Text style={styles.signatoryName}>{input.signatory.name}</Text>
              ) : null}
              {input.signatory?.title ? (
                <Text style={styles.signatoryTitle}>{input.signatory.title}</Text>
              ) : null}
              <Text style={styles.signatoryTitle}>{input.organization.name}</Text>
            </View>
            {input.stampDataUri ? (
              <Image style={styles.stampImage} src={input.stampDataUri} />
            ) : null}
          </View>
        ) : null}

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            {input.footerNote ?? `${input.organization.name} · ${input.letterNumber}`}
          </Text>
          <Text
            style={styles.footerText}
            render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  );
}

export async function renderLetterPdf(input: LetterPdfInput): Promise<Buffer> {
  return renderToBuffer(<LetterDocument {...input} />);
}

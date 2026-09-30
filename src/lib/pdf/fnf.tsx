// Imported explicitly: this module is also rendered outside Next.js (scripts,
// jobs), where the automatic JSX runtime is not configured.
import React from "react";
import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { PDF_FONT, PDF_FONT_BOLD } from "./fonts";

/**
 * The full and final settlement statement.
 *
 * Unlike a payslip, this document carries the *formula* for every line. A
 * payslip is one of twelve and its arithmetic is familiar; an F&F is the last
 * thing an employer ever sends someone and every figure on it is unusual —
 * gratuity, encashment, notice recovery. Showing how each was reached is what
 * stops the statement becoming a dispute.
 *
 * Amounts arrive pre-formatted, and carry the rupee sign whenever the PDF font
 * is present -- see `lib/pdf/fonts.ts`, which falls back to "Rs" rather than
 * printing a character the font cannot draw.
 */

const styles = StyleSheet.create({
  page: {
    paddingTop: 40,
    paddingBottom: 56,
    paddingHorizontal: 44,
    fontSize: 9,
    color: "#111111",
    fontFamily: PDF_FONT,
  },
  brand: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  logo: { width: 44, height: 44, objectFit: "contain" },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    borderBottomWidth: 1.5,
    borderBottomColor: "#111111",
    paddingBottom: 8,
  },
  orgName: { fontSize: 14, fontFamily: PDF_FONT_BOLD, fontWeight: 700 },
  orgAddress: { fontSize: 7.5, color: "#555555", marginTop: 2, maxWidth: 260 },
  title: { fontSize: 11, fontFamily: PDF_FONT_BOLD, fontWeight: 700, textAlign: "right" },
  meta: { fontSize: 7.5, color: "#555555", textAlign: "right", marginTop: 2 },

  employee: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: 12,
    marginBottom: 14,
    borderWidth: 0.5,
    borderColor: "#dddddd",
    padding: 8,
  },
  field: { width: "33.33%", paddingVertical: 2, paddingRight: 6 },
  fieldLabel: { fontSize: 7, color: "#777777", textTransform: "uppercase" },
  fieldValue: { fontSize: 9 },

  sectionTitle: {
    fontSize: 8.5,
    fontFamily: PDF_FONT_BOLD, fontWeight: 700,
    textTransform: "uppercase",
    borderBottomWidth: 1,
    borderBottomColor: "#111111",
    paddingBottom: 3,
    marginBottom: 3,
    marginTop: 10,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingVertical: 3,
    borderBottomWidth: 0.5,
    borderBottomColor: "#eeeeee",
  },
  rowLeft: { flex: 1, paddingRight: 12 },
  rowLabel: { fontSize: 9 },
  // The working, in smaller grey type under the label.
  rowFormula: { fontSize: 7, color: "#888888", marginTop: 1 },
  rowAmount: { fontSize: 9 },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 4,
    marginTop: 2,
    borderTopWidth: 1,
    borderTopColor: "#111111",
  },
  totalText: { fontSize: 9, fontFamily: PDF_FONT_BOLD, fontWeight: 700 },
  empty: { fontSize: 9, color: "#888888", paddingVertical: 4 },

  netBanner: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#f2f4f7",
    borderLeftWidth: 3,
    borderLeftColor: "#111111",
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginTop: 16,
  },
  netLabel: { fontSize: 9, color: "#555555" },
  netWords: { fontSize: 7.5, color: "#777777", marginTop: 2, maxWidth: 320 },
  netAmount: { fontSize: 17, fontFamily: PDF_FONT_BOLD, fontWeight: 700 },

  note: { fontSize: 7.5, color: "#777777", marginTop: 12, lineHeight: 1.4 },
  signature: { flexDirection: "row", justifyContent: "space-between", marginTop: 40 },
  signBox: { width: "45%", borderTopWidth: 0.5, borderTopColor: "#999999", paddingTop: 4 },
  signLabel: { fontSize: 7.5, color: "#777777" },

  footer: {
    position: "absolute",
    bottom: 24,
    left: 44,
    right: 44,
    borderTopWidth: 0.5,
    borderTopColor: "#cccccc",
    paddingTop: 5,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  footerText: { fontSize: 6.5, color: "#999999" },
});

export interface FnfPdfLine {
  label: string;
  /** Already formatted by `formatPdfMoney`, e.g. "₹24,596.77". */
  amount: string;
  formula?: string | null;
}

export interface FnfPdfInput {
  /**
   * The same letterhead the letter and the payslip carry.
   *
   * This document used to build its own from four of the seven address fields
   * -- no country, no contact line, no logo and no statutory identifiers -- so a
   * settlement, which is the last thing an employer hands somebody, was the one
   * document that did not look like it came from the same company.
   */
  organization: {
    name: string;
    address?: string | null;
    contact?: string | null;
    statutory?: string | null;
    logoDataUri?: string | null;
  };
  employee: {
    name: string;
    code: string;
    designation?: string | null;
    department?: string | null;
    joinedOn?: string | null;
    lastWorkingDay?: string | null;
  };
  issuedOn: string;
  earnings: FnfPdfLine[];
  deductions: FnfPdfLine[];
  totals: { earnings: string; deductions: string; net: string; netInWords?: string | null };
  note?: string | null;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue}>{value}</Text>
    </View>
  );
}

function LineTable({
  title,
  lines,
  total,
  totalLabel,
}: {
  title: string;
  lines: FnfPdfLine[];
  total: string;
  totalLabel: string;
}) {
  return (
    <View>
      <Text style={styles.sectionTitle}>{title}</Text>

      {lines.length === 0 ? (
        <Text style={styles.empty}>Nothing under this heading.</Text>
      ) : (
        lines.map((line, i) => (
          <View key={i} style={styles.row} wrap={false}>
            <View style={styles.rowLeft}>
              <Text style={styles.rowLabel}>{line.label}</Text>
              {line.formula ? <Text style={styles.rowFormula}>{line.formula}</Text> : null}
            </View>
            <Text style={styles.rowAmount}>{line.amount}</Text>
          </View>
        ))
      )}

      <View style={styles.totalRow}>
        <Text style={styles.totalText}>{totalLabel}</Text>
        <Text style={styles.totalText}>{total}</Text>
      </View>
    </View>
  );
}

function FnfDocument(input: FnfPdfInput) {
  return (
    <Document
      title={`Full and final settlement — ${input.employee.name}`}
      author={input.organization.name}
    >
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View style={styles.brand}>
            {input.organization.logoDataUri ? (
              // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image takes no alt
              <Image src={input.organization.logoDataUri} style={styles.logo} />
            ) : null}
            <View>
              <Text style={styles.orgName}>{input.organization.name}</Text>
              {input.organization.address ? (
                <Text style={styles.orgAddress}>{input.organization.address}</Text>
              ) : null}
              {input.organization.contact ? (
                <Text style={styles.orgAddress}>{input.organization.contact}</Text>
              ) : null}
              {input.organization.statutory ? (
                <Text style={styles.orgAddress}>{input.organization.statutory}</Text>
              ) : null}
            </View>
          </View>
          <View>
            <Text style={styles.title}>Full &amp; Final Settlement</Text>
            <Text style={styles.meta}>Issued {input.issuedOn}</Text>
          </View>
        </View>

        <View style={styles.employee}>
          <Field label="Employee" value={input.employee.name} />
          <Field label="Code" value={input.employee.code} />
          <Field label="Designation" value={input.employee.designation ?? "—"} />
          <Field label="Department" value={input.employee.department ?? "—"} />
          <Field label="Date of joining" value={input.employee.joinedOn ?? "—"} />
          <Field label="Last working day" value={input.employee.lastWorkingDay ?? "—"} />
        </View>

        <LineTable
          title="Payable to the employee"
          lines={input.earnings}
          total={input.totals.earnings}
          totalLabel="Total payable"
        />

        <LineTable
          title="Recoverable from the employee"
          lines={input.deductions}
          total={input.totals.deductions}
          totalLabel="Total recoverable"
        />

        <View style={styles.netBanner}>
          <View>
            <Text style={styles.netLabel}>Net settlement</Text>
            {input.totals.netInWords ? (
              <Text style={styles.netWords}>{input.totals.netInWords}</Text>
            ) : null}
          </View>
          <Text style={styles.netAmount}>{input.totals.net}</Text>
        </View>

        {input.note ? <Text style={styles.note}>{input.note}</Text> : null}

        <Text style={styles.note}>
          Each figure above shows the basis on which it was calculated. If anything looks wrong,
          raise it with HR before accepting the settlement.
        </Text>

        <View style={styles.signature}>
          <View style={styles.signBox}>
            <Text style={styles.signLabel}>For {input.organization.name}</Text>
          </View>
          <View style={styles.signBox}>
            <Text style={styles.signLabel}>
              Received and accepted — {input.employee.name}
            </Text>
          </View>
        </View>

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            {input.organization.name} · {input.employee.code} · Confidential
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

export async function renderFnfPdf(input: FnfPdfInput): Promise<Buffer> {
  return renderToBuffer(<FnfDocument {...input} />);
}

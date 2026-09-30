// Imported explicitly: this module is also rendered outside Next.js (scripts,
// jobs), where the automatic JSX runtime is not configured.
import React from "react";
import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { PDF_FONT, PDF_FONT_BOLD } from "./fonts";

/**
 * Salary slips.
 *
 * The layout answers, in order, the three questions somebody actually opens a
 * payslip to answer: what did I get, what was it made of, and why is it not the
 * number I expected. Hence net pay first and large, then the earnings and
 * deductions side by side, then the attendance that drove the proration —
 * because "why is this less than last month" is nearly always a days question.
 *
 * Every figure arrives pre-formatted. This file does no arithmetic at all: the
 * engine already computed and rounded, and a second rounding here would be a
 * quiet way to make a payslip disagree with the payroll it came from.
 */

const styles = StyleSheet.create({
  /**
   * The same mark `letter.tsx` draws, inset to this page's own padding rather
   * than the letter's wider one, so the word sits over the figures instead of
   * hanging off the side of them.
   *
   * Pale enough to read the numbers through on purpose: a watermark that makes
   * the amounts illegible gets screenshotted with the mark cropped out, and
   * then the sample is loose without it.
   */
  watermark: {
    position: "absolute",
    top: 300,
    left: 40,
    right: 40,
    textAlign: "center",
    fontSize: 68,
    letterSpacing: 8,
    color: "#e2e5ec",
    transform: "rotate(-28deg)",
  },
  page: {
    paddingTop: 36,
    paddingBottom: 52,
    paddingHorizontal: 40,
    fontSize: 9,
    color: "#111111",
    fontFamily: PDF_FONT,
  },

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
  slipTitle: { fontSize: 11, fontFamily: PDF_FONT_BOLD, fontWeight: 700, textAlign: "right" },
  slipMeta: { fontSize: 7.5, color: "#555555", textAlign: "right", marginTop: 2 },

  // --- employee block
  employee: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: 12,
    marginBottom: 12,
    borderWidth: 0.5,
    borderColor: "#dddddd",
    padding: 8,
  },
  field: { width: "33.33%", paddingVertical: 2, paddingRight: 6 },
  fieldLabel: { fontSize: 7, color: "#777777", textTransform: "uppercase" },
  fieldValue: { fontSize: 9 },

  // --- net banner
  netBanner: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#f2f4f7",
    borderLeftWidth: 3,
    borderLeftColor: "#111111",
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 12,
  },
  netLabel: { fontSize: 9, color: "#555555" },
  netWords: { fontSize: 7.5, color: "#777777", marginTop: 2, maxWidth: 300 },
  netAmount: { fontSize: 18, fontFamily: PDF_FONT_BOLD, fontWeight: 700 },

  // --- money tables
  columns: { flexDirection: "row", gap: 12 },
  column: { flex: 1 },
  tableHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: "#111111",
    paddingBottom: 3,
    marginBottom: 2,
  },
  tableHeadText: { fontSize: 8, fontFamily: PDF_FONT_BOLD, fontWeight: 700, textTransform: "uppercase" },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 2.5,
    borderBottomWidth: 0.5,
    borderBottomColor: "#eeeeee",
  },
  rowLabel: { flex: 1, paddingRight: 8 },
  rowAmount: { fontFamily: PDF_FONT },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 4,
    marginTop: 2,
    borderTopWidth: 1,
    borderTopColor: "#111111",
  },
  totalText: { fontSize: 9, fontFamily: PDF_FONT_BOLD, fontWeight: 700 },
  muted: { color: "#777777" },

  // --- attendance
  sectionTitle: {
    fontSize: 8,
    fontFamily: PDF_FONT_BOLD, fontWeight: 700,
    textTransform: "uppercase",
    marginTop: 14,
    marginBottom: 4,
  },
  attendance: { flexDirection: "row", flexWrap: "wrap", borderWidth: 0.5, borderColor: "#dddddd" },
  cell: {
    width: "16.66%",
    paddingVertical: 5,
    paddingHorizontal: 4,
    borderRightWidth: 0.5,
    borderRightColor: "#eeeeee",
  },
  cellValue: { fontSize: 10, fontFamily: PDF_FONT_BOLD, fontWeight: 700 },
  cellLabel: { fontSize: 6.5, color: "#777777", textTransform: "uppercase" },

  note: { fontSize: 7.5, color: "#777777", marginTop: 10, lineHeight: 1.4 },

  footer: {
    position: "absolute",
    bottom: 24,
    left: 40,
    right: 40,
    borderTopWidth: 0.5,
    borderTopColor: "#cccccc",
    paddingTop: 5,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  footerText: { fontSize: 6.5, color: "#999999" },
  identity: { flexDirection: "row", alignItems: "flex-start", gap: 8, maxWidth: 330 },
  identityText: { flexShrink: 1 },
  logo: { width: 40, height: 40, objectFit: "contain" },
  orgStatutory: { fontSize: 6.8, color: "#666666", marginTop: 1.5, maxWidth: 250 },
});

export interface PayslipLine {
  label: string;
  /** Already formatted, e.g. "₹24,596.77". */
  amount: string;
}

export interface PayslipInput {
  organization: {
    name: string;
    address?: string | null;
    /**
     * The organisation's logo, already read into a data URI.
     *
     * `@react-pdf/renderer` cannot fetch a URL from inside a server render, and
     * the CSP would not permit it anyway. Absent, the name is set in type —
     * which is what every payslip did before this existed.
     */
    logoDataUri?: string | null;
    /** Phone, email and website on one line, when the organisation has them. */
    contact?: string | null;
    /** CIN, GSTIN, PAN, TAN, PF and ESI — only when the organisation asks for them. */
    statutory?: string | null;
  };
  /** One line along the bottom, in place of the default. */
  footerNote?: string | null;
  /**
   * Drawn diagonally across the page, behind the figures.
   *
   * A payslip for money nobody has been paid must not be mistakable for one
   * somebody has. The sample an employee can open for themselves is built from
   * their real salary through the real engine, so the arithmetic on it is
   * correct for a month that never happened — which is exactly the document
   * that has to say so on its face rather than in a note at the bottom.
   */
  watermark?: string | null;
  slipNumber: string;
  periodLabel: string;
  employee: {
    name: string;
    code: string;
    designation?: string | null;
    department?: string | null;
    joiningDate?: string | null;
    bankAccount?: string | null;
    pan?: string | null;
    uan?: string | null;
    pfNumber?: string | null;
  };
  net: { amount: string; inWords?: string | null };
  earnings: PayslipLine[];
  deductions: PayslipLine[];
  totals: { gross: string; deductions: string };
  attendance: { label: string; value: string }[];
  /** Shown verbatim under the tables — engine warnings, arrears notes. */
  notes?: string[];
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue}>{value}</Text>
    </View>
  );
}

function MoneyTable({
  title,
  lines,
  total,
  totalLabel,
}: {
  title: string;
  lines: PayslipLine[];
  total: string;
  totalLabel: string;
}) {
  return (
    <View style={styles.column}>
      <View style={styles.tableHead}>
        <Text style={styles.tableHeadText}>{title}</Text>
        <Text style={styles.tableHeadText}>Amount</Text>
      </View>

      {lines.length === 0 ? (
        <Text style={[styles.rowLabel, styles.muted, { paddingVertical: 4 }]}>None</Text>
      ) : (
        lines.map((line, i) => (
          <View key={i} style={styles.row}>
            <Text style={styles.rowLabel}>{line.label}</Text>
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

function PayslipDocument(input: PayslipInput) {
  return (
    <Document
      title={`Payslip ${input.periodLabel} — ${input.employee.name}`}
      author={input.organization.name}
    >
      <Page size="A4" style={styles.page}>
        {/* First child, so everything else paints over it. `@react-pdf` has no
            z-index; order in the tree is the order on the page. */}
        {input.watermark ? (
          <Text fixed style={styles.watermark}>
            {input.watermark}
          </Text>
        ) : null}
        {/* Logo *and* name. It used to be one or the other, so a payslip from
            an organisation with a glyph logo carried no company name at all --
            on the document somebody hands to a bank. */}
        <View style={styles.header}>
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
          <View>
            <Text style={styles.slipTitle}>Salary Slip</Text>
            <Text style={styles.slipMeta}>{input.periodLabel}</Text>
            <Text style={styles.slipMeta}>{input.slipNumber}</Text>
          </View>
        </View>

        <View style={styles.employee}>
          <Field label="Employee" value={input.employee.name} />
          <Field label="Code" value={input.employee.code} />
          <Field label="Designation" value={input.employee.designation ?? "—"} />
          <Field label="Department" value={input.employee.department ?? "—"} />
          <Field label="Date of joining" value={input.employee.joiningDate ?? "—"} />
          <Field label="Bank account" value={input.employee.bankAccount ?? "—"} />
          {/* `pan` was in this type and populated by the preview route from the
              day it was written, and never rendered. UAN and PF number are what
              an employee is asked for when they transfer a provident fund. */}
          <Field label="PAN" value={input.employee.pan ?? "—"} />
          <Field label="UAN" value={input.employee.uan ?? "—"} />
          <Field label="PF number" value={input.employee.pfNumber ?? "—"} />
        </View>

        <View style={styles.netBanner}>
          <View>
            <Text style={styles.netLabel}>Net pay for {input.periodLabel}</Text>
            {input.net.inWords ? <Text style={styles.netWords}>{input.net.inWords}</Text> : null}
          </View>
          <Text style={styles.netAmount}>{input.net.amount}</Text>
        </View>

        <View style={styles.columns}>
          <MoneyTable
            title="Earnings"
            lines={input.earnings}
            total={input.totals.gross}
            totalLabel="Gross"
          />
          <MoneyTable
            title="Deductions"
            lines={input.deductions}
            total={input.totals.deductions}
            totalLabel="Total deductions"
          />
        </View>

        <Text style={styles.sectionTitle}>Attendance for the period</Text>
        <View style={styles.attendance}>
          {input.attendance.map((a, i) => (
            <View key={i} style={styles.cell}>
              <Text style={styles.cellValue}>{a.value}</Text>
              <Text style={styles.cellLabel}>{a.label}</Text>
            </View>
          ))}
        </View>

        {input.notes && input.notes.length > 0 ? (
          <View>
            <Text style={styles.sectionTitle}>Notes</Text>
            {input.notes.map((note, i) => (
              <Text key={i} style={styles.note}>
                • {note}
              </Text>
            ))}
          </View>
        ) : null}

        <Text style={styles.note}>
          This is a computer-generated statement and does not require a signature. If any figure
          looks wrong, raise it with HR before the next payroll is locked.
        </Text>

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            {input.footerNote?.trim() ||
              `${input.organization.name} · ${input.slipNumber} · Confidential`}
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

export async function renderPayslipPdf(input: PayslipInput): Promise<Buffer> {
  return renderToBuffer(<PayslipDocument {...input} />);
}

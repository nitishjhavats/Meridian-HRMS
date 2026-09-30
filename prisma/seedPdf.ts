/**
 * A minimal one-page PDF, hand-assembled.
 *
 * The seed needs documents a viewer will actually open — a vault whose every
 * "Open" link 404s makes a working feature look broken. Assembling ~20 lines of
 * PDF here beats pulling a rendering library into the seed script to draw one
 * sentence; the real letters and payslips use a proper renderer.
 */
export function placeholderPdf(text: string): Buffer {
  // Parentheses and backslashes are PDF string delimiters and must be escaped.
  const escaped = text.replace(/([\\()])/g, "\\$1");
  const content =
    `BT /F1 16 Tf 60 760 Td (${escaped}) Tj ` +
    `0 -28 Td /F1 10 Tf (Sample document generated for the demo dataset.) Tj ET`;

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];

  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  // The cross-reference table records where each object starts, so a reader can
  // seek rather than scan. Byte offsets, hence latin1 below.
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}

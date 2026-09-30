import { requireContext } from "@/lib/auth/context";
import { requireWrite } from "@/lib/auth/guard";
import { route } from "@/lib/http/handler";
import { toCsv } from "@/domain/csv";
import { importTemplateRows } from "@/domain/employees/import";
import { templateReference } from "@/services/employees/import";

/**
 * The blank the importer promises to read back.
 *
 * Generated from the same column list the parser matches against, so the two
 * cannot drift — a template with a column the importer ignores is worse than no
 * template, because the person fills it in and never learns it was dropped.
 */
export const GET = route(async () => {
  const ctx = await requireContext();
  requireWrite(ctx, "employee.create");

  // The example rows name this organisation's own department, designation,
  // location, shift and week-off pattern, so the file can be imported exactly
  // as it downloads. Inventing names would fail every row that used them, and
  // "Must already exist" is not a thing a person can act on without a list.
  const reference = await templateReference(ctx);

  // A BOM, so Excel opens it as UTF-8 rather than mangling any name with an
  // accent in it. The parser strips it back off on the way in.
  const body = `\uFEFF${toCsv(importTemplateRows(reference))}`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="employee-import-template.csv"',
      "Cache-Control": "no-store",
    },
  });
});

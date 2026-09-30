import { requireContext } from "@/lib/auth/context";
import { json, route } from "@/lib/http/handler";
import { ValidationError } from "@/lib/errors";
import {
  commitEmployeeImport,
  employeeImportGuide,
  previewEmployeeImport,
} from "@/services/employees/import";
import {
  isEmployeeLoginRole,
  type EmployeeLoginRole,
} from "@/domain/employees/loginRoles";

/**
 * Preview and commit share one endpoint and one payload.
 *
 * The browser sends the whole file both times. That is deliberate: the commit
 * rebuilds the plan from the bytes rather than accepting a list of rows the
 * client says are fine, which would let a client create employees of its own
 * design. Re-sending a spreadsheet of a few hundred rows costs nothing.
 */

/** A spreadsheet of employees is text; a megabyte is tens of thousands of rows. */
const MAX_BYTES = 1024 * 1024;

type LoginRole = EmployeeLoginRole;

function loginRole(value: FormDataEntryValue | null): LoginRole | undefined {
  return isEmployeeLoginRole(value) ? value : undefined;
}

async function readCsv(request: Request): Promise<{
  csv: string;
  commit: boolean;
  skip: boolean;
  createLogins: boolean;
  loginRole: LoginRole | undefined;
}> {
  const form = await request.formData().catch(() => null);
  if (!form) throw new ValidationError("Attach the CSV file.");

  const file = form.get("file");
  if (!(file instanceof File)) throw new ValidationError("Attach the CSV file.");
  if (file.size === 0) throw new ValidationError("That file is empty.");
  if (file.size > MAX_BYTES) {
    throw new ValidationError("That file is larger than 1 MB. Split it and import in batches.");
  }

  return {
    csv: await file.text(),
    commit: form.get("commit") === "true",
    skip: form.get("skipRowsWithErrors") === "true",
    createLogins: form.get("createLogins") === "true",
    loginRole: loginRole(form.get("loginRole")),
  };
}

/**
 * What the columns are, before anybody has a file to check.
 *
 * The screen used to open on a file picker and a download link, and every
 * question a person actually had -- which columns exist, which are required,
 * what Gender will accept, which departments this organisation has -- was
 * answerable only by downloading the template and guessing, or by uploading
 * something wrong and reading the refusal.
 */
export const GET = route(async () => {
  const ctx = await requireContext();
  return json(await employeeImportGuide(ctx));
});

export const POST = route(async (request) => {
  const ctx = await requireContext();
  const { csv, commit, skip, createLogins, loginRole: role } = await readCsv(request);

  if (!commit) return json(await previewEmployeeImport(ctx, csv));
  return json(
    await commitEmployeeImport(ctx, csv, {
      skipRowsWithErrors: skip,
      createLogins,
      loginRole: role,
    }),
  );
});

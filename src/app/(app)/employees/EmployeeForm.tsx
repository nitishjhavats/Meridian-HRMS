"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Alert } from "@/components/ui/states";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { api, mutate } from "@/lib/client/api";
import { formatMoney } from "@/lib/utils";
import { EMPLOYEE_LOGIN_ROLE_LABELS } from "@/domain/employees/loginRoles";
import { suggestManagers } from "@/domain/org/suggestManager";
import {
  confirmationDatePatch,
  isProvisional,
  suggestedConfirmationDate,
} from "@/domain/employees/probation";
import {
  autoSuggestedManager,
  employmentStatePatch,
  reportsToPatch,
} from "@/domain/employees/editPayload";
import { CredentialHandover, type Credential } from "@/components/auth/CredentialHandover";

/**
 * Adding and editing one person.
 *
 * The service and its routes have existed for a while with nothing to call
 * them, which meant an organisation could hold exactly the people a seed script
 * had put there. This is that missing surface.
 *
 * It is deliberately not the whole employee record. Salary lives in the salary
 * structure, employment state moves through its own transition so the reason is
 * recorded, and the reference photo has its own control on the profile. What is
 * here is what somebody needs to get a person into the directory and payable.
 */

export interface FormOptions {
  departments: { id: string; name: string }[];
  designations: { id: string; title: string }[];
  locations: { id: string; name: string }[];
  shifts: { id: string; name: string }[];
  patterns: { id: string; name: string }[];
  nextCode: string;
  /** Days a new hire stays on probation here, for the suggested date. */
  probationDays: number;
  /** And in training, when they start there instead. */
  trainingDays: number;
  /** Roles this actor may actually assign. Worked out server-side. */
  assignableRoles: string[];
  /** Whether this actor may set pay at all. `employee.salary.manage`. */
  canSetSalary: boolean;
  /** Everybody who could be somebody's manager, with their designation. */
  managers: { id: string; name: string; designationId: string | null; designation: string | null }[];
  /** designationId -> the designations it reports to. */
  designationParents: Record<string, string[]>;
}

export interface EmployeeValues {
  id?: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  joiningDate: string;
  workEmail: string;
  /** Their own address. Letters fall back to it when there is no work email. */
  personalEmail: string;
  phone: string;
  gender: string;
  dateOfBirth: string;
  employmentType: string;
  workMode: string;
  /** Where they start: training, probation, or straight to permanent. */
  employmentState: string;
  /** When training or probation ends. Blank for somebody starting permanent. */
  confirmationDate: string;
  departmentId: string;
  designationId: string;
  workLocationId: string;
  shiftId: string;
  weeklyOffPatternId: string;
  /**
   * Who approves their leave and their attendance corrections.
   *
   * On an edit this must be the *live primary* manager -- the one
   * `updateEmployee` compares against -- so that an untouched field sends
   * nothing and the line stays exactly as it was.
   */
  reportsToEmployeeId: string;
  /** Annual cost to company, in rupees, as agreed. */
  annualCtc: string;
  /** What they were told they would take home, annually. Compared, never stored. */
  expectedAnnualInHand: string;
  /** "" follows the organisation; "yes" and "no" are explicit overrides. */
  allowSelfMarking: "" | "yes" | "no";
}

/** Roles a new employee's login may be given, most common first. */

const EMPTY: EmployeeValues = {
  employeeCode: "",
  firstName: "",
  lastName: "",
  joiningDate: "",
  workEmail: "",
  personalEmail: "",
  phone: "",
  gender: "",
  dateOfBirth: "",
  employmentType: "FULL_TIME",
  workMode: "ONSITE",
  employmentState: "PROBATION",
  confirmationDate: "",
  departmentId: "",
  designationId: "",
  workLocationId: "",
  shiftId: "",
  weeklyOffPatternId: "",
  reportsToEmployeeId: "",
  annualCtc: "",
  expectedAnnualInHand: "",
  allowSelfMarking: "",
};

export function EmployeeForm({
  employee,
  trigger,
}: {
  /** Absent for a new person. */
  employee?: Partial<EmployeeValues> & { id: string };
  trigger?: React.ReactNode;
}) {
  const router = useRouter();
  const editing = Boolean(employee?.id);

  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<FormOptions | null>(null);
  const [form, setForm] = useState<EmployeeValues>({ ...EMPTY, ...employee });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const probationDays = options?.probationDays ?? 90;
  const trainingDays = options?.trainingDays ?? 30;

  /**
   * Who the org chart says should manage this person.
   *
   * A suggestion, never a decision. One candidate is pre-selected and named;
   * several leaves the field empty and says how many, because picking one of
   * three Engineering Managers at random hands somebody's leave approvals to a
   * stranger. None leaves it empty and says so.
   *
   * The rule itself is in `domain/org/suggestManager` because the backfill
   * script has to reach the same answer.
   */
  const suggestedManagers = options
    ? suggestManagers({
        designationId: form.designationId,
        designationParents: options.designationParents,
        managers: options.managers,
        excludeEmployeeId: employee?.id,
      })
    : [];

  /**
   * What the CTC works out to per month, and whether the in-hand they were
   * promised is plausible against it.
   *
   * The in-hand is **not stored**. Payroll computes net from attendance,
   * deductions and the salary structure, and a second number sitting on the
   * employee record would disagree with it the first month somebody took unpaid
   * leave — and then nobody could say which was right. This is a sanity check
   * at the moment of the offer, and it says so.
   */
  const annualCtcPaise = form.annualCtc ? Math.round(Number(form.annualCtc) * 100) : 0;
  const monthlyCtc = annualCtcPaise ? formatMoney(Math.round(annualCtcPaise / 12)) : null;
  const inHandPaise = form.expectedAnnualInHand
    ? Math.round(Number(form.expectedAnnualInHand) * 100)
    : 0;
  const inHandHint =
    inHandPaise && annualCtcPaise
      ? inHandPaise > annualCtcPaise
        ? "That is more than the CTC. Take-home cannot exceed cost to company."
        : `${Math.round((1 - inHandPaise / annualCtcPaise) * 100)}% of CTC goes to deductions and employer contributions. Payroll works out the real figure each month — this is only a check on what was promised.`
      : "Optional. Only compared against the CTC; nothing stores it.";

  const managerHint = form.reportsToEmployeeId
    ? "They approve this person's leave and attendance corrections."
    : suggestedManagers.length === 1
      ? `The org chart suggests ${suggestedManagers[0]!.name}.`
      : suggestedManagers.length > 1
        ? `${suggestedManagers.length} people hold the designation above this one — choose which.`
        : "Left empty, their leave and corrections go to HR and Admin.";

  /**
   * Whether the designation has been changed in this dialog.
   *
   * The suggestion below used to run the moment an edit dialog opened, and an
   * existing employee arrived with an empty manager field -- so anybody whose
   * designation had exactly one parent-holder was reassigned to that person by
   * a save that only meant to fix their phone number. The rule, in
   * `domain/employees/editPayload`, is that the chart may only speak while a
   * designation is being chosen.
   */
  const designationTouched = useRef(false);

  // Fill it in the moment the chart is unambiguous, and only while nobody has
  // chosen for themselves.
  useEffect(() => {
    const suggestion = autoSuggestedManager({
      editing,
      designationChanged: designationTouched.current,
      chosen: form.reportsToEmployeeId,
      candidates: suggestedManagers,
    });
    if (!suggestion) return;
    setForm((f) => (f.reportsToEmployeeId ? f : { ...f, reportsToEmployeeId: suggestion }));
  }, [editing, form.reportsToEmployeeId, suggestedManagers]);

  /** The suggestion, from the rule in `domain/employees/probation`. */
  function suggestedConfirmation(state: string = form.employmentState): string {
    return suggestedConfirmationDate({
      joiningDate: form.joiningDate,
      state,
      trainingDays,
      probationDays,
    });
  }

  /**
   * Whether somebody has typed their own date, in which case nothing may move
   * it again.
   *
   * An employee being edited already has an answer, and it is theirs — the
   * suggestion must never overwrite a date that came off the record.
   */
  const confirmationTouched = useRef(editing);

  /**
   * Keep "permanent from" in step with the joining date.
   *
   * This used to hang off the *state* dropdown's `onChange` alone, so the
   * ordinary path — type a joining date, leave "On probation" selected, save —
   * left the date blank, because nobody ever touched the dropdown. Watching the
   * two values instead means the suggestion appears however you get there, and
   * `confirmationTouched` still keeps it off a typed answer.
   */
  useEffect(() => {
    if (confirmationTouched.current) return;
    const next = suggestedConfirmation(form.employmentState);
    setForm((f) => (f.confirmationDate === next ? f : { ...f, confirmationDate: next }));
    // `suggestedConfirmation` reads the joining date and the two org defaults,
    // all of which are listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.joiningDate, form.employmentState, probationDays, trainingDays]);

  const [createLogin, setCreateLogin] = useState(false);
  const [loginRole, setLoginRole] = useState<string>("TEAM_MEMBER");
  const [credential, setCredential] = useState<Credential | null>(null);

  function set<K extends keyof EmployeeValues>(key: K, value: EmployeeValues[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // Options are fetched when the dialog opens rather than with the page: a
  // directory of two hundred people should not pay for five lookups nobody has
  // asked for yet.
  useEffect(() => {
    if (!open || options) return;
    let cancelled = false;
    void api<FormOptions>("/api/employees/options")
      .then((data) => {
        if (cancelled) return;
        setOptions(data);
        // Only suggest a code for somebody new, and only if nothing was typed.
        if (!editing) setForm((f) => (f.employeeCode ? f : { ...f, employeeCode: data.nextCode }));
      })
      .catch(() => {
        if (!cancelled) setError("The department and shift lists could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [open, options, editing]);

  async function save() {
    setBusy(true);
    setError(null);

    const body = {
      employeeCode: form.employeeCode.trim(),
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim() || null,
      joiningDate: form.joiningDate,
      workEmail: form.workEmail.trim() || null,
      personalEmail: form.personalEmail.trim() || null,
      phone: form.phone.trim() || null,
      gender: form.gender || null,
      dateOfBirth: form.dateOfBirth || null,
      employmentType: form.employmentType,
      workMode: form.workMode,
      // Only for somebody new. The PATCH schema admits only the states a
      // person can start in, so an edit that carried a resigned or terminated
      // employee's state -- read off their record, never shown -- failed
      // validation with nothing highlighted, and their personal email could
      // not be corrected before the settlement letter.
      ...employmentStatePatch(editing, form.employmentState),
      // Only when the field was actually on screen. `updateEmployee` applies
      // any `confirmationDate` it is handed, so sending a blank one from a form
      // that never showed the input -- which is what a permanent employee's
      // edit dialog is -- erased the date that person was confirmed on.
      ...confirmationDatePatch(form.employmentState, form.confirmationDate),
      departmentId: form.departmentId || null,
      designationId: form.designationId || null,
      workLocationId: form.workLocationId || null,
      shiftId: form.shiftId || null,
      weeklyOffPatternId: form.weeklyOffPatternId || null,
      // Only when somebody changed it. `updateEmployee` opens a new reporting
      // line for any manager that differs from the live one, so an edit must
      // never send a manager the person at the keyboard did not pick.
      ...reportsToPatch({
        editing,
        initial: employee?.reportsToEmployeeId ?? "",
        current: form.reportsToEmployeeId,
      }),
      // Rupees in the form, paise on the wire. The expected in-hand is never
      // sent: it is a check against what was promised, not a second number for
      // the engine to disagree with.
      annualCtcPaise: form.annualCtc ? Math.round(Number(form.annualCtc) * 100) : null,
      allowSelfMarking:
        form.allowSelfMarking === "" ? null : form.allowSelfMarking === "yes",
    };

    const result = await mutate<{ credential: Credential | null }>(
      () =>
        editing
          ? api(`/api/employees/${employee!.id}`, { method: "PATCH", body })
          : api("/api/employees", {
              method: "POST",
              body: {
                ...body,
                login: createLogin ? { create: true, role: loginRole } : { create: false },
              },
            }),
      {
        success: editing ? "Saved." : `${form.firstName} added.`,
        error: editing ? "Nothing was saved" : "That person was not added",
      },
    );

    setBusy(false);
    if (result) {
      setOpen(false);
      if (!editing) {
        setForm(EMPTY);
        setCreateLogin(false);
        // Held outside the form dialog: closing this is the last chance anybody
        // has to read the password.
        if (result.credential) setCredential(result.credential);
      }
      router.refresh();
    }
  }

  const ready =
    form.employeeCode.trim() !== "" && form.firstName.trim() !== "" && form.joiningDate !== "";

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm">
            <UserPlus className="size-4" aria-hidden />
            Add employee
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit employee" : "Add an employee"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Employment state and salary are changed elsewhere, so the reason is recorded."
              : "They start on probation. Salary and the reference photo come next, on their profile."}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {error ? <Alert tone="danger">{error}</Alert> : null}

          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
            <Field label="Employee code" htmlFor="employeeCode" required>
              <Input
                id="employeeCode"
                value={form.employeeCode}
                onChange={(e) => set("employeeCode", e.target.value)}
              />
            </Field>
            <Field label="Joining date" htmlFor="joiningDate" required>
              <Input
                id="joiningDate"
                type="date"
                value={form.joiningDate}
                onChange={(e) => set("joiningDate", e.target.value)}
              />
            </Field>
            <Field label="First name" htmlFor="firstName" required>
              <Input
                id="firstName"
                value={form.firstName}
                onChange={(e) => set("firstName", e.target.value)}
              />
            </Field>
            <Field label="Last name" htmlFor="lastName">
              <Input
                id="lastName"
                value={form.lastName}
                onChange={(e) => set("lastName", e.target.value)}
              />
            </Field>
            <Field label="Work email" htmlFor="workEmail" hint="Becomes their sign-in later.">
              <Input
                id="workEmail"
                type="email"
                value={form.workEmail}
                onChange={(e) => set("workEmail", e.target.value)}
              />
            </Field>
            <Field
              label="Personal email"
              htmlFor="personalEmail"
              hint="Used on letters when there is no work email."
            >
              <Input
                id="personalEmail"
                type="email"
                value={form.personalEmail}
                onChange={(e) => set("personalEmail", e.target.value)}
              />
            </Field>
            <Field label="Phone" htmlFor="phone">
              <Input id="phone" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
            </Field>
            <Field label="Date of birth" htmlFor="dateOfBirth">
              <Input
                id="dateOfBirth"
                type="date"
                value={form.dateOfBirth}
                onChange={(e) => set("dateOfBirth", e.target.value)}
              />
            </Field>
            <Field label="Gender" htmlFor="gender">
              <Select id="gender" value={form.gender} onChange={(e) => set("gender", e.target.value)}>
                <option value="">Not stated</option>
                <option value="FEMALE">Female</option>
                <option value="MALE">Male</option>
                <option value="OTHER">Other</option>
                <option value="UNDISCLOSED">Prefer not to say</option>
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 border-t border-border pt-4 sm:grid-cols-2">
            <Field label="Department" htmlFor="departmentId">
              <Select
                id="departmentId"
                value={form.departmentId}
                onChange={(e) => set("departmentId", e.target.value)}
              >
                <option value="">None</option>
                {options?.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Designation" htmlFor="designationId">
              <Select
                id="designationId"
                value={form.designationId}
                onChange={(e) => {
                  designationTouched.current = true;
                  set("designationId", e.target.value);
                }}
              >
                <option value="">None</option>
                {options?.designations.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Work location"
              htmlFor="workLocationId"
              hint="Decides the geofence their check-in is measured against."
            >
              <Select
                id="workLocationId"
                value={form.workLocationId}
                onChange={(e) => set("workLocationId", e.target.value)}
              >
                <option value="">None</option>
                {options?.locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
            {/* Honest about what this does. A shift is recorded against the
                person and stamped on each attendance day, but the times
                attendance is *judged* against come from the organisation's
                attendance rules, not from here. Per-employee shift windows are
                a real gap; pretending this control sets them would be worse. */}
            <Field
              label="Shift"
              htmlFor="shiftId"
              hint="Recorded on their record. Late and half-day rules come from the organisation's attendance settings."
            >
              <Select id="shiftId" value={form.shiftId} onChange={(e) => set("shiftId", e.target.value)}>
                <option value="">Organisation default</option>
                {options?.shifts.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Weekly off pattern"
              htmlFor="weeklyOffPatternId"
              hint="Organisation default means the organisation's own default pattern. Days of their own, whatever the pattern says, are set from the Week off card on their profile."
            >
              <Select
                id="weeklyOffPatternId"
                value={form.weeklyOffPatternId}
                onChange={(e) => set("weeklyOffPatternId", e.target.value)}
              >
                <option value="">Organisation default</option>
                {options?.patterns.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Reports to"
              htmlFor="reportsToEmployeeId"
              hint={managerHint}
            >
              <Select
                id="reportsToEmployeeId"
                value={form.reportsToEmployeeId}
                onChange={(e) => set("reportsToEmployeeId", e.target.value)}
              >
                <option value="">Nobody — HR and Admin approve for them</option>
                {(options?.managers ?? [])
                  .filter((m) => m.id !== employee?.id)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {m.designation ? ` — ${m.designation}` : ""}
                    </option>
                  ))}
              </Select>
            </Field>
            {/* Pay is offered only to somebody who may set it:
                `employee.salary.manage` is an Admin permission while
                `employee.create` reaches HR, so showing this to everybody would
                be a field the server refuses. */}
            {!editing && options?.canSetSalary ? (
              <>
                <Field
                  label="Annual CTC (₹)"
                  htmlFor="annualCtc"
                  hint={
                    monthlyCtc
                      ? `${monthlyCtc} per month, which is the figure payroll works from.`
                      : "Cost to company for the year, as agreed."
                  }
                >
                  <Input
                    id="annualCtc"
                    type="number"
                    min={0}
                    className="tabular"
                    placeholder="720000"
                    value={form.annualCtc}
                    onChange={(e) => set("annualCtc", e.target.value)}
                  />
                </Field>
                <Field
                  label="Expected in-hand (₹ a year)"
                  htmlFor="expectedAnnualInHand"
                  hint={inHandHint}
                >
                  <Input
                    id="expectedAnnualInHand"
                    type="number"
                    min={0}
                    className="tabular"
                    placeholder="660000"
                    value={form.expectedAnnualInHand}
                    onChange={(e) => set("expectedAnnualInHand", e.target.value)}
                  />
                </Field>
              </>
            ) : null}

            <Field label="Employment type" htmlFor="employmentType">
              <Select
                id="employmentType"
                value={form.employmentType}
                onChange={(e) => set("employmentType", e.target.value)}
              >
                <option value="FULL_TIME">Full time</option>
                <option value="PART_TIME">Part time</option>
                <option value="CONTRACT">Contract</option>
                <option value="INTERN">Intern</option>
                <option value="CONSULTANT">Consultant</option>
              </Select>
            </Field>
            {/* Only at creation. `updateEmployee` deliberately ignores this --
                a state change moves through `changeEmploymentState` so the
                reason and the date are recorded -- and a control that silently
                does nothing is worse than no control. The profile page has the
                real one. */}
            {editing ? null : (
              <Field
                label="Starting as"
                htmlFor="employmentState"
                hint="Recorded in their employment history from day one."
              >
                <Select
                  id="employmentState"
                  value={form.employmentState}
                  // The date follows from the effect above, which watches this
                  // and the joining date together. Training and probation have
                  // different lengths, so moving between them moves the date --
                  // but only while it is still the one we filled in.
                  onChange={(e) => set("employmentState", e.target.value)}
                >
                  <option value="TRAINING">In training</option>
                  <option value="PROBATION">On probation</option>
                  <option value="REGULAR">Permanent from the start</option>
                </Select>
              </Field>
            )}

            {isProvisional(form.employmentState) ? (
              <Field
                label="Permanent from"
                htmlFor="confirmationDate"
                hint={
                  form.employmentState === "TRAINING"
                    ? `Filled in from your ${trainingDays}-day training default. Change it if theirs differs.`
                    : `Filled in from your ${probationDays}-day probation default. Change it if theirs differs.`
                }
              >
                <Input
                  id="confirmationDate"
                  type="date"
                  value={form.confirmationDate}
                  onChange={(e) => {
                    confirmationTouched.current = true;
                    set("confirmationDate", e.target.value);
                  }}
                />
              </Field>
            ) : null}

            <Field label="Work mode" htmlFor="workMode">
              <Select
                id="workMode"
                value={form.workMode}
                onChange={(e) => set("workMode", e.target.value)}
              >
                <option value="ONSITE">On site</option>
                <option value="REMOTE">Remote</option>
                <option value="HYBRID">Hybrid</option>
              </Select>
            </Field>
          </div>

          <div className="border-t border-border pt-4">
            <Field
              label="Marking attendance from their own device"
              htmlFor="allowSelfMarking"
              hint="An exception for this person only. Field staff who cannot reach the office device need it when the organisation is set to office-device-only."
            >
              <Select
                id="allowSelfMarking"
                value={form.allowSelfMarking}
                onChange={(e) => set("allowSelfMarking", e.target.value as EmployeeValues["allowSelfMarking"])}
              >
                <option value="">Follow the organisation&rsquo;s rule</option>
                <option value="yes">Always allowed, whatever the rule says</option>
                <option value="no">Never — office device only</option>
              </Select>
            </Field>
          </div>

          {!editing ? (
            <div className="space-y-3 rounded-lg border border-border p-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Give them a login</p>
                  <p className="text-xs text-muted-foreground">
                    Without one they are a directory entry: they cannot check in, apply for leave
                    or open a payslip. Needs an email address above.
                  </p>
                </div>
                <Switch
                  checked={createLogin}
                  disabled={busy || !form.workEmail.trim()}
                  aria-label="Give them a login"
                  onCheckedChange={setCreateLogin}
                />
              </div>

              {createLogin ? (
                <>
                  <Field label="What they may do" htmlFor="loginRole">
                    <Select
                      id="loginRole"
                      value={loginRole}
                      onChange={(e) => setLoginRole(e.target.value)}
                    >
                      {EMPLOYEE_LOGIN_ROLE_LABELS.filter((role) =>
                        (options?.assignableRoles ?? []).includes(role.value),
                      ).map((role) => (
                        <option key={role.value} value={role.value}>
                          {role.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <p className="text-xs text-muted-foreground">
                    A one-time password is shown once when you save. They choose their own the
                    first time they sign in.
                  </p>
                </>
              ) : null}
            </div>
          ) : null}
        </DialogBody>

        <DialogFooter>
          <Button loading={busy} disabled={!ready || busy} onClick={() => void save()}>
            {editing ? "Save changes" : "Add employee"}
          </Button>
        </DialogFooter>
      </DialogContent>

      </Dialog>

      {/* Its own root, so closing the form does not take the password off screen. */}
      <Dialog open={credential !== null} onOpenChange={(o) => !o && setCredential(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{credential?.name} can sign in</DialogTitle>
            <DialogDescription>Pass these details to them directly.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {credential ? <CredentialHandover credential={credential} /> : null}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The pencil on a profile, so the trigger does not have to be rebuilt there. */
export function EditEmployeeButton(props: { employee: Partial<EmployeeValues> & { id: string } }) {
  return (
    <EmployeeForm
      employee={props.employee}
      trigger={
        <Button variant="secondary" size="sm">
          <Pencil className="size-4" aria-hidden />
          Edit
        </Button>
      }
    />
  );
}

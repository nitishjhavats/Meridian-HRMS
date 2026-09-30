"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Alert } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";
import { useFieldIssues } from "@/lib/client/fieldIssues";
import type { MyProfile } from "@/services/account/profile";

/**
 * The rule the route enforces, applied before the button is live.
 *
 * A one-letter name used to reach the server, fail zod's `min(2)`, and come
 * back as "Please check the highlighted fields" with nothing highlighted --
 * the person had cleared the box, typed a letter, and the only thing that
 * lit up was the Save button. Now the box says why, and Save waits.
 */
const NAME_MIN = 2;
const NAME_MAX = 120;

function nameProblem(name: string): string | undefined {
  const length = name.trim().length;
  if (length < NAME_MIN) return `At least ${NAME_MIN} characters.`;
  if (length > NAME_MAX) return `At most ${NAME_MAX} characters.`;
  return undefined;
}

/**
 * What your letters say you are.
 *
 * Deliberately two fields and nothing else. This is not "my account" — it is
 * the pair `issueLetter` falls back to when a letter type has no signatory of
 * its own, which until now could be read and never written.
 */
export function ProfileForm({ initial }: { initial: MyProfile }) {
  const router = useRouter();
  const [profile, setProfile] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [designationId, setDesignationId] = useState(initial.designationId ?? "");
  const [busy, setBusy] = useState(false);
  // Whatever the server refuses field by field lands under the field. The
  // name rule is checked here first, so this is for the rest -- and for the
  // day the route's rule and the one above drift apart.
  const fieldIssues = useFieldIssues();

  const dirty = name.trim() !== profile.name || (designationId || null) !== profile.designationId;
  const nameError = dirty ? nameProblem(name) : undefined;

  function applied(next: MyProfile) {
    setProfile(next);
    setName(next.name);
    setDesignationId(next.designationId ?? "");
    router.refresh();
  }

  async function save() {
    setBusy(true);
    const result = await mutate<{ profile: MyProfile }>(
      () =>
        fieldIssues.watch(
          api("/api/account/profile", {
            method: "PUT",
            body: { name: name.trim(), designationId: designationId || null },
          }),
        ),
      { success: "Saved. Letters will use this from now on.", error: "Nothing was saved" },
    );
    setBusy(false);
    if (result) applied(result.profile);
  }

  async function join() {
    setBusy(true);
    const result = await mutate<{ profile: MyProfile }>(
      () => api("/api/account/profile", { method: "POST" }),
      { success: "You are in the directory.", error: "Nothing was added" },
    );
    setBusy(false);
    if (result) applied(result.profile);
  }

  return (
    <div className="space-y-4 p-4">
      {profile.employeeId === null ? (
        <Alert tone="warning" title="Your login is not in the employee directory">
          <p>
            A designation lives on an employee record, and this login has none — organisations
            created before owners were added to the directory automatically are missing it. Your
            name below still saves without one.
          </p>
          <p className="mt-2">
            Adding yourself uses one seat, the same as any other employee, because that is how
            seats are counted.
          </p>
          <Button size="sm" className="mt-2" disabled={busy} onClick={() => void join()}>
            Add me to the directory
          </Button>
        </Alert>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
        <Field
          label="Your name"
          htmlFor="profileName"
          required
          error={nameError ?? fieldIssues.messageFor("name")}
          hint="As it should appear at the bottom of a letter."
        >
          <Input
            id="profileName"
            value={name}
            disabled={busy}
            maxLength={NAME_MAX}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>

        <Field
          label="Your designation"
          htmlFor="profileDesignation"
          error={fieldIssues.messageFor("designationId")}
          hint={
            profile.employeeId === null
              ? "Needs an employee record first."
              : "From your organisation's list. Manage the list in Settings → Organisation."
          }
        >
          <Select
            id="profileDesignation"
            value={designationId}
            disabled={busy || profile.employeeId === null}
            onChange={(e) => setDesignationId(e.target.value)}
          >
            <option value="">No designation</option>
            {profile.designations.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button loading={busy} disabled={busy || !dirty || Boolean(nameError)} onClick={() => void save()}>
          Save
        </Button>
        {dirty ? (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setName(profile.name);
              setDesignationId(profile.designationId ?? "");
              fieldIssues.clear();
            }}
          >
            Discard
          </Button>
        ) : null}
      </div>
    </div>
  );
}

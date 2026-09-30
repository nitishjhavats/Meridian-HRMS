"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Play, Send, Star, Target, Trash2, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Alert, EmptyState } from "@/components/ui/states";
import { Section } from "@/components/ui/stat";
import { api, mutate } from "@/lib/client/api";
import { formatDate } from "@/lib/utils";
import {
  type RecognitionUnitKey,
  UNIT_LABELS,
  formatRecognitionValue,
} from "@/domain/recognition/units";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NumberField } from "@/components/ui/number-field";
import { Select } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import type { PickablePerson } from "@/components/employees/EmployeePicker";
import { AssignGoal } from "./AssignGoal";

/**
 * Reviews and goals.
 *
 * Scores are 0–5 on a row of buttons rather than a slider or a number box: a
 * rating is a judgement from a small set, and making it feel like a measurement
 * invites false precision like 3.7.
 */

export interface Review {
  id: string;
  status: "NOT_STARTED" | "SELF_REVIEW" | "MANAGER_REVIEW" | "COMPLETED";
  cycle: { id: string; name: string; competencies: { code: string; label: string; weight: number }[] };
  employee: { id: string; name: string; code: string };
  reviewer: { id: string; name: string };
  selfComment: string | null;
  managerComment: string | null;
  selfRating: number | null;
  managerRating: number | null;
  finalRating: number | null;
  ratings: { competency: string; selfScore: number | null; managerScore: number | null }[];
  role: "SUBJECT" | "REVIEWER" | "OBSERVER";
}

export interface Goal {
  id: string;
  title: string;
  description: string | null;
  status: string;
  dueOn: string | null;
  currentValue: string | null;
  targetValue: string | null;
  /** The measure, when the goal has one. Null on a goal written as words. */
  unit: RecognitionUnitKey | null;
  targetNumber: number | null;
  currentNumber: number | null;
  /** Null rather than zero when there is nothing to measure against. */
  percent: number | null;
  /** Decided by the service, so the screen never offers a refused control. */
  canRecordProgress: boolean;
  canEdit: boolean;
  recentProgress: { id: string; value: number; note: string | null; at: string }[];
  overdue: boolean;
  /** Whose goal it is. Only ever somebody else's for a viewer who reviews them. */
  employee: { id: string; name: string; code: string };
}

export interface Cycle {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: "DRAFT" | "ACTIVE" | "CLOSED";
  reviews: { total: number; selfReview: number; managerReview: number; completed: number };
}

/**
 * Who opening a cycle would reach, counted before the button is pressed.
 *
 * `openCycle` writes one review per active employee with a primary manager and
 * skips the rest -- the right rule, and one that in a new organisation, where
 * nobody has a reporting line yet, opens the cycle for nobody. It used to do
 * that silently: "Cycle opened", badge green, zero reviews, and the cycle could
 * never be opened again. The numbers are shown before the click and the
 * service's answer is read after it.
 */
export interface Reviewable {
  /** Active employees. */
  total: number;
  /** Of those, the ones with a primary manager -- the ones who get a review. */
  withManager: number;
}

/** What `openCycle` answers with. */
interface Opened {
  opened: number;
  skipped: string[];
}

const STATUS_TONE = {
  NOT_STARTED: "neutral",
  SELF_REVIEW: "warning",
  MANAGER_REVIEW: "info",
  COMPLETED: "success",
} as const;

function Scores({
  competencies,
  values,
  onChange,
  disabled,
}: {
  competencies: { code: string; label: string }[];
  values: Record<string, number>;
  onChange: (code: string, score: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      {competencies.map((c) => (
        <div key={c.code} className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm">{c.label}</span>
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map((score) => (
              <button
                key={score}
                type="button"
                disabled={disabled}
                onClick={() => onChange(c.code, score)}
                aria-label={`${c.label}: ${score} of 5`}
                className={`grid size-8 place-items-center rounded-md border text-sm ${
                  values[c.code] === score
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-muted"
                } disabled:opacity-50`}
              >
                {score}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Performance({
  reviews,
  goals,
  cycles,
  people,
  canManage,
  canAssign,
  employeeId,
  reviewable,
}: {
  reviews: Review[];
  goals: Goal[];
  cycles: Cycle[];
  /** Who this viewer may set a goal for. Empty unless they review people. */
  people: PickablePerson[];
  canManage: boolean;
  canAssign: boolean;
  employeeId: string | null;
  /** Only counted for somebody who can open a cycle. */
  reviewable?: Reviewable;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [comment, setComment] = useState("");
  const [newCycle, setNewCycle] = useState({ name: "", startDate: "", endDate: "" });
  /** The draft cycle whose Open is being confirmed. */
  const [opening, setOpening] = useState<Cycle | null>(null);
  const [newGoal, setNewGoal] = useState("");
  /** Goal being rewritten, removed, or moved along. All three were missing. */
  const [editing, setEditing] = useState<Goal | null>(null);
  const [removing, setRemoving] = useState<Goal | null>(null);
  const [progressFor, setProgressFor] = useState<Goal | null>(null);
  const [progressValue, setProgressValue] = useState("");
  const [progressNote, setProgressNote] = useState("");

  const mine = reviews.filter((r) => r.role === "SUBJECT");
  const toReview = reviews.filter((r) => r.role === "REVIEWER" && r.status === "MANAGER_REVIEW");

  // Goals used to be your own by definition, so nothing on the row said whose
  // it was. A reviewer now gets their team's as well, and a list mixing the two
  // silently would be worse than not showing them at all.
  const myGoals = goals.filter((g) => g.employee.id === employeeId);
  const theirGoals = goals.filter((g) => g.employee.id !== employeeId);

  async function submit(review: Review, as: "self" | "manager") {
    const competencies = review.cycle.competencies;
    const missing = competencies.filter((c) => !scores[c.code]);
    if (missing.length > 0) return;

    setBusy(review.id);
    const ok = await mutate(
      () =>
        api("/api/performance/reviews", {
          method: "POST",
          body: {
            action: as,
            reviewId: review.id,
            comment: comment.trim(),
            scores: competencies.map((c) => ({ competency: c.code, score: scores[c.code]! })),
          },
        }),
      {
        success: as === "self" ? "Sent to your manager." : "Review completed.",
        error: "That was not saved",
      },
    );
    setBusy(null);
    if (ok !== null) {
      setOpen(null);
      setScores({});
      setComment("");
      router.refresh();
    }
  }

  function startEditing(review: Review) {
    setOpen(review.id);
    setScores(
      Object.fromEntries(
        review.ratings
          .filter((r) => r.selfScore != null)
          .map((r) => [r.competency, r.selfScore!]),
      ),
    );
    setComment("");
  }

  const formatMeasure = (value: number, unit: RecognitionUnitKey) =>
    formatRecognitionValue(value, unit);

  const nobody = reviewable !== undefined && reviewable.withManager === 0;
  const headcount = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

  /**
   * Opens the cycle and says what that did.
   *
   * The service has always answered with how many reviews it wrote and whom
   * it skipped; this toasted "Cycle opened." and threw the answer away. So an
   * organisation with no reporting lines saw success, and the fact that
   * nobody had been given a review -- or told -- was nowhere on the screen.
   */
  async function openCycle(cycle: Cycle) {
    setBusy(cycle.id);
    const result = await mutate<Opened>(
      () =>
        api("/api/performance/cycles", {
          method: "POST",
          body: { action: "open", cycleId: cycle.id },
        }),
      { error: "Not opened" },
    );
    setBusy(null);
    setOpening(null);
    if (result === null) return;

    const skipped = result.skipped.length;
    const codes = result.skipped.slice(0, 8).join(", ") + (skipped > 8 ? ", …" : "");
    if (result.opened === 0) {
      toast.error(`${cycle.name} is open, but nobody got a review`, {
        description:
          skipped === 0
            ? "There is nobody active in the employee directory yet. Add people, then start a new cycle."
            : `${headcount(skipped)} skipped because they have no primary manager (${codes}). Set who reports to whom under Settings › Organisation, then start a new cycle.`,
      });
    } else if (skipped > 0) {
      toast.success(`${cycle.name} opened for ${headcount(result.opened)}`, {
        // Long enough to read the codes off, like an error.
        description: `${headcount(skipped)} skipped because they have no primary manager: ${codes}.`,
        duration: 12_000,
      });
    } else {
      toast.success(`${cycle.name} opened for ${headcount(result.opened)}. They have each been told.`);
    }
    router.refresh();
  }

  /**
   * One goal. `whose` is the only difference between your list and your team's.
   *
   * Three things here did not exist. A goal could not be edited — `upsertGoal`
   * has accepted an `id` since it was written and no client ever sent one; it
   * could not be deleted at all; and `ACHIEVED` was rendered by the badge below
   * and reachable from nothing, which made the "mark it achieved afterwards"
   * line in the assign dialog untrue.
   */
  const goalRow = (g: Goal, whose = false) => (
    <li key={g.id} className="px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{g.title}</p>
          <p className="text-xs text-muted-foreground">
            {whose ? `${g.employee.name} · ` : ""}
            {g.dueOn ? `due ${formatDate(g.dueOn)}` : "no date"}
            {g.targetNumber !== null && g.unit
              ? ` · ${formatMeasure(g.currentNumber ?? 0, g.unit)} of ${formatMeasure(g.targetNumber, g.unit)}`
              : g.targetValue
                ? ` · target ${g.targetValue}`
                : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Badge tone={g.overdue ? "danger" : g.status === "ACHIEVED" ? "success" : "neutral"}>
            {g.overdue ? "overdue" : g.status.toLowerCase()}
          </Badge>
          {g.canRecordProgress && g.targetNumber !== null ? (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Update progress on ${g.title}`}
              onClick={() => {
                setProgressFor(g);
                setProgressValue(String(g.currentNumber ?? ""));
                setProgressNote("");
              }}
            >
              <TrendingUp className="size-4" aria-hidden />
            </Button>
          ) : null}
          {g.canEdit ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Edit ${g.title}`}
                onClick={() => setEditing(g)}
              >
                <Pencil className="size-4" aria-hidden />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove ${g.title}`}
                onClick={() => setRemoving(g)}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {/* The bar only where there is a number behind it. A text goal showing
          0% reads as somebody who has done nothing, when in fact nobody ever
          said what finished would look like. */}
      {g.percent !== null ? (
        <div className="mt-2 flex items-center gap-2">
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className={g.percent >= 100 ? "h-full bg-success" : "h-full bg-primary"}
              style={{ width: `${Math.min(100, g.percent)}%` }}
            />
          </div>
          <span className="tabular shrink-0 text-xs text-muted-foreground">{g.percent}%</span>
        </div>
      ) : null}
    </li>
  );

  const reviewCard = (review: Review, as: "self" | "manager") => {
    const editing = open === review.id;
    const competencies = review.cycle.competencies;

    return (
      <li key={review.id} className="rounded-lg border border-border bg-card p-4">
        <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {as === "manager" ? review.employee.name : review.cycle.name}
            </p>
            <p className="text-xs text-muted-foreground">
              {as === "manager"
                ? `${review.employee.code} · ${review.cycle.name}`
                : `Reviewed by ${review.reviewer.name}`}
            </p>
          </div>
          <Badge tone={STATUS_TONE[review.status]}>
            {review.status.replaceAll("_", " ").toLowerCase()}
          </Badge>
        </div>

        {review.status === "COMPLETED" ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-4 rounded-md bg-muted px-3 py-2 text-sm">
              <span>
                Self <strong className="tabular">{review.selfRating ?? "—"}</strong>
              </span>
              <span>
                Manager <strong className="tabular">{review.managerRating ?? "—"}</strong>
              </span>
              <span className="ml-auto flex items-center gap-1">
                <Star className="size-4 text-warning" aria-hidden />
                Final <strong className="tabular">{review.finalRating ?? "—"}</strong>
              </span>
            </div>
            {review.selfComment ? (
              <p className="text-sm">
                <span className="text-xs uppercase text-muted-foreground">What you wrote</span>
                <br />
                {review.selfComment}
              </p>
            ) : null}
            {review.managerComment ? (
              <p className="text-sm">
                <span className="text-xs uppercase text-muted-foreground">
                  What your manager wrote
                </span>
                <br />
                {review.managerComment}
              </p>
            ) : null}
          </div>
        ) : editing ? (
          <div className="space-y-3">
            <Scores
              competencies={competencies}
              values={scores}
              onChange={(code, score) => setScores((s) => ({ ...s, [code]: score }))}
            />
            <Field
              label={as === "self" ? "Anything you want to add" : "Your feedback"}
              htmlFor={`c-${review.id}`}
            >
              <Textarea
                id={`c-${review.id}`}
                rows={3}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
            </Field>
            <div className="flex gap-2">
              <Button
                size="sm"
                loading={busy === review.id}
                disabled={competencies.some((c) => !scores[c.code])}
                onClick={() => submit(review, as)}
              >
                <Send className="size-4" aria-hidden />
                {as === "self" ? "Send to my manager" : "Complete the review"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {as === "self" && review.status === "SELF_REVIEW" ? (
              <Button size="sm" onClick={() => startEditing(review)}>
                Write my self-review
              </Button>
            ) : null}
            {as === "manager" ? (
              <>
                {review.selfComment ? (
                  <p className="mb-2 w-full text-sm text-muted-foreground">
                    <span className="text-xs uppercase">Their self-review</span>
                    <br />
                    {review.selfComment}
                    {review.selfRating != null ? ` (${review.selfRating}/5)` : ""}
                  </p>
                ) : null}
                <Button size="sm" onClick={() => startEditing(review)}>
                  Write my review
                </Button>
              </>
            ) : null}
            {as === "self" && review.status === "MANAGER_REVIEW" ? (
              <p className="text-sm text-muted-foreground">
                Sent. Waiting for {review.reviewer.name}.
              </p>
            ) : null}
          </div>
        )}
      </li>
    );
  };

  /**
   * The goals, above the review cycles.
   *
   * They were below, and a review cycle is a twice-a-year event while a goal is
   * a daily one -- so the screen opened on the event and buried the thing
   * people came for. Held as values rather than moved inline, because the
   * return below is long enough already.
   */
  const goalsSection = (
    <Section
      title="Your goals"
      description="What you are working towards"
      action={canAssign && people.length > 0 ? <AssignGoal people={people} /> : undefined}
    >
      <div className="space-y-3 p-4">
        {myGoals.length === 0 ? (
          <p className="text-sm text-muted-foreground">No goals set yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {myGoals.map((g) => goalRow(g))}
          </ul>
        )}

        {employeeId ? (
          <div className="flex gap-2">
            <Input
              value={newGoal}
              aria-label="Goal"
              placeholder="Add a goal, e.g. Ship the reporting module"
              onChange={(e) => setNewGoal(e.target.value)}
            />
            <Button
              variant="secondary"
              loading={busy === "goal"}
              disabled={newGoal.trim().length < 2}
              onClick={async () => {
                setBusy("goal");
                const ok = await mutate(
                  () =>
                    api("/api/performance/goals", {
                      method: "POST",
                      body: { employeeId, title: newGoal.trim(), status: "ACTIVE" },
                    }),
                  { success: "Goal added.", error: "Not added" },
                );
                setBusy(null);
                if (ok !== null) {
                  setNewGoal("");
                  router.refresh();
                }
              }}
            >
              <Target className="size-4" aria-hidden />
              Add
            </Button>
          </div>
        ) : null}
      </div>
    </Section>
  );

  const theirGoalsSection =
    theirGoals.length > 0 ? (
      <Section
        title="Other people's goals"
        description="Everybody you review, and whose each one is"
      >
        <div className="p-4">
          <ul className="divide-y divide-border rounded-md border border-border">
            {theirGoals.map((g) => goalRow(g, true))}
          </ul>
        </div>
      </Section>
    ) : null;

  return (
    <div className="space-y-4">
      {goalsSection}

      {theirGoalsSection}

      {/* Below the goals now. A review cycle is a twice-a-year event and a goal
          is a daily one, and the screen opened on the event. */}
      {canManage ? (
        <Section
          title="Review cycles"
          description="Open one and everybody with a primary manager gets a review"
        >
          <div className="space-y-3 p-4">
            {nobody ? (
              <Alert tone="warning" title="Nobody has a primary manager yet">
                A review is written by the person&apos;s primary manager, so opening a cycle now
                would create no reviews at all &mdash; and a cycle cannot be opened twice. Set who
                reports to whom first: under Settings &rsaquo; Organisation, or on each
                employee&apos;s record.
              </Alert>
            ) : null}

            {cycles.length > 0 ? (
              <ul className="divide-y divide-border rounded-md border border-border">
                {cycles.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{c.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDate(c.startDate)} – {formatDate(c.endDate)}
                        {c.reviews.total > 0
                          ? ` · ${c.reviews.completed}/${c.reviews.total} complete`
                          : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={c.status === "ACTIVE" ? "success" : "neutral"}>
                        {c.status.toLowerCase()}
                      </Badge>
                      {c.status === "DRAFT" ? (
                        <Button size="sm" loading={busy === c.id} onClick={() => setOpening(c)}>
                          <Play className="size-4" aria-hidden />
                          Open
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
              <Field label="New cycle" htmlFor="cycleName">
                <Input
                  id="cycleName"
                  value={newCycle.name}
                  placeholder="H1 2027"
                  onChange={(e) => setNewCycle((c) => ({ ...c, name: e.target.value }))}
                />
              </Field>
              <Field label="From" htmlFor="cycleFrom">
                <Input
                  id="cycleFrom"
                  type="date"
                  value={newCycle.startDate}
                  onChange={(e) => setNewCycle((c) => ({ ...c, startDate: e.target.value }))}
                />
              </Field>
              <Field label="To" htmlFor="cycleTo">
                <Input
                  id="cycleTo"
                  type="date"
                  min={newCycle.startDate}
                  value={newCycle.endDate}
                  onChange={(e) => setNewCycle((c) => ({ ...c, endDate: e.target.value }))}
                />
              </Field>
              <Button
                variant="secondary"
                loading={busy === "cycle"}
                disabled={!newCycle.name.trim() || !newCycle.startDate || !newCycle.endDate}
                onClick={async () => {
                  setBusy("cycle");
                  const ok = await mutate(
                    () =>
                      api("/api/performance/cycles", {
                        method: "POST",
                        body: { action: "create", ...newCycle, name: newCycle.name.trim() },
                      }),
                    { success: "Cycle created.", error: "Not created" },
                  );
                  setBusy(null);
                  if (ok !== null) {
                    setNewCycle({ name: "", startDate: "", endDate: "" });
                    router.refresh();
                  }
                }}
              >
                Create
              </Button>
            </div>
          </div>
        </Section>
      ) : null}

      {toReview.length > 0 ? (
        <Section title="Waiting for your review" description="Their self-review is in">
          <ul className="space-y-3 p-4">{toReview.map((r) => reviewCard(r, "manager"))}</ul>
        </Section>
      ) : null}

      <Section title="Your reviews" description="Across every cycle">
        {mine.length === 0 ? (
          <EmptyState
            icon={Star}
            title="No reviews yet"
            description="When a cycle opens, your self-review appears here."
          />
        ) : (
          <ul className="space-y-3 p-4">{mine.map((r) => reviewCard(r, "self"))}</ul>
        )}
      </Section>


      {/* ---------- open a cycle, knowing whom it reaches ---------- */}
      <Dialog open={opening !== null} onOpenChange={(o) => !o && busy === null && setOpening(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Open {opening?.name}?</DialogTitle>
            <DialogDescription>
              {reviewable === undefined
                ? "Everybody with a primary manager gets a review and is told. A cycle cannot be opened twice."
                : nobody
                  ? `None of the ${headcount(reviewable.total)} in the directory has a primary manager, so this would create no reviews -- and the cycle cannot be opened again afterwards.`
                  : `${headcount(reviewable.withManager)} get a review and are told.${
                      reviewable.total > reviewable.withManager
                        ? ` ${headcount(reviewable.total - reviewable.withManager)} skipped because they have no primary manager.`
                        : ""
                    } A cycle cannot be opened twice.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={busy !== null} onClick={() => setOpening(null)}>
              Cancel
            </Button>
            <Button
              variant={nobody ? "danger" : "primary"}
              loading={busy !== null && busy === opening?.id}
              onClick={() => opening && void openCycle(opening)}
            >
              <Play className="size-4" aria-hidden />
              {nobody ? "Open anyway" : "Open"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- update how far along a goal is ---------- */}
      <Dialog open={progressFor !== null} onOpenChange={(o) => !o && setProgressFor(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{progressFor?.title}</DialogTitle>
          </DialogHeader>
          {progressFor ? (
            <DialogBody className="space-y-4">
              <Field
                label={`Where it has got to${progressFor.unit ? ` (${UNIT_LABELS[progressFor.unit].toLowerCase()})` : ""}`}
                htmlFor="progressValue"
                required
                hint={
                  progressFor.targetNumber !== null && progressFor.unit
                    ? `The running total, not what it went up by. Target: ${formatMeasure(progressFor.targetNumber, progressFor.unit)}.`
                    : "The running total, not what it went up by."
                }
              >
                <NumberField
                  id="progressValue"
                  min={0}
                  decimals={2}
                  className="tabular text-lg"
                  value={progressValue === "" ? null : Number(progressValue)}
                  onValueChange={(v) => setProgressValue(v === null ? "" : String(v))}
                />
              </Field>

              <Field label="A note, if it helps" htmlFor="progressNote">
                <Input
                  id="progressNote"
                  value={progressNote}
                  onChange={(e) => setProgressNote(e.target.value)}
                  placeholder="Closed the Nagpur account"
                />
              </Field>

              {progressFor.recentProgress.length > 0 ? (
                <div>
                  <p className="mb-1 text-sm font-medium">Recent updates</p>
                  <ul className="divide-y divide-border rounded-lg border border-border text-xs">
                    {progressFor.recentProgress.map((entry) => (
                      <li key={entry.id} className="flex items-baseline gap-2 px-3 py-1.5">
                        <span className="tabular font-medium">
                          {progressFor.unit
                            ? formatMeasure(entry.value, progressFor.unit)
                            : entry.value}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
                          {entry.note ?? ""}
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {formatDate(entry.at.slice(0, 10))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </DialogBody>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setProgressFor(null)}>
              Cancel
            </Button>
            <Button
              loading={busy === "progress"}
              disabled={progressValue === ""}
              onClick={async () => {
                if (!progressFor) return;
                setBusy("progress");
                const ok = await mutate(
                  () =>
                    api("/api/performance/goals", {
                      method: "POST",
                      body: {
                        goalId: progressFor.id,
                        progressValue: Number(progressValue),
                        note: progressNote.trim() || undefined,
                      },
                    }),
                  { success: "Progress recorded.", error: "That could not be recorded" },
                );
                setBusy(null);
                if (ok !== null) {
                  setProgressFor(null);
                  router.refresh();
                }
              }}
            >
              <TrendingUp className="size-4" aria-hidden />
              Record
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- edit the goal itself ---------- */}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit this goal</DialogTitle>
          </DialogHeader>
          {editing ? (
            <DialogBody className="space-y-4">
              <Field label="Goal" htmlFor="editTitle" required>
                <Input
                  id="editTitle"
                  value={editing.title}
                  onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                />
              </Field>

              <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
                <Field
                  label="Measured in"
                  htmlFor="editUnit"
                  hint="Leave it as words to keep a goal with no number."
                >
                  <Select
                    id="editUnit"
                    value={editing.unit ?? ""}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        unit: (e.target.value || null) as RecognitionUnitKey | null,
                      })
                    }
                  >
                    <option value="">Words, not a number</option>
                    {(Object.keys(UNIT_LABELS) as RecognitionUnitKey[]).map((key) => (
                      <option key={key} value={key}>
                        {UNIT_LABELS[key]}
                      </option>
                    ))}
                  </Select>
                </Field>

                {editing.unit ? (
                  <Field label="Target" htmlFor="editTarget" required>
                    <NumberField
                      id="editTarget"
                      min={0}
                      decimals={2}
                      className="tabular"
                      value={editing.targetNumber}
                      onValueChange={(v) => setEditing({ ...editing, targetNumber: v })}
                    />
                  </Field>
                ) : null}

                <Field label="Due" htmlFor="editDue">
                  <Input
                    id="editDue"
                    type="date"
                    value={editing.dueOn ?? ""}
                    onChange={(e) => setEditing({ ...editing, dueOn: e.target.value || null })}
                  />
                </Field>

                <Field label="Status" htmlFor="editStatus">
                  <Select
                    id="editStatus"
                    value={editing.status}
                    onChange={(e) => setEditing({ ...editing, status: e.target.value })}
                  >
                    <option value="DRAFT">Draft</option>
                    <option value="ACTIVE">Active</option>
                    <option value="ACHIEVED">Achieved</option>
                    <option value="MISSED">Missed</option>
                    <option value="CANCELLED">Cancelled</option>
                  </Select>
                </Field>
              </div>
            </DialogBody>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              loading={busy === "editGoal"}
              disabled={!editing || editing.title.trim().length < 2}
              onClick={async () => {
                if (!editing) return;
                setBusy("editGoal");
                const ok = await mutate(
                  () =>
                    api("/api/performance/goals", {
                      method: "POST",
                      body: {
                        id: editing.id,
                        employeeId: editing.employee.id,
                        title: editing.title.trim(),
                        description: editing.description ?? undefined,
                        unit: editing.unit,
                        targetNumber: editing.unit ? editing.targetNumber : null,
                        status: editing.status,
                        dueOn: editing.dueOn ?? undefined,
                      },
                    }),
                  { success: "Goal updated.", error: "That could not be saved" },
                );
                setBusy(null);
                if (ok !== null) {
                  setEditing(null);
                  router.refresh();
                }
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- remove it ---------- */}
      <Dialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove this goal?</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="text-sm text-muted-foreground">
              &ldquo;{removing?.title}&rdquo; and everything recorded against it. Marking it
              cancelled keeps the history; this does not.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={busy === "removeGoal"}
              onClick={async () => {
                if (!removing) return;
                setBusy("removeGoal");
                const ok = await mutate(
                  () =>
                    api(`/api/performance/goals?id=${encodeURIComponent(removing.id)}`, {
                      method: "DELETE",
                    }),
                  { success: "Goal removed.", error: "That could not be removed" },
                );
                setBusy(null);
                if (ok !== null) {
                  setRemoving(null);
                  router.refresh();
                }
              }}
            >
              <Trash2 className="size-4" aria-hidden />
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {mine.some((r) => r.status === "SELF_REVIEW") ? (
        <Alert tone="info" title="Your manager writes after you do">
          Their rating stays hidden until the review is complete, so what you write is your own
          assessment rather than a response to theirs.
        </Alert>
      ) : null}
    </div>
  );
}

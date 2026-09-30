import Link from "next/link";
import { ArrowDown, ArrowUp, History, Scale, Trophy } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { hasPermission } from "@/lib/auth/guard";
import { getCurrentAward, getRecognitionSetup, listAwardHistory } from "@/services/recognition";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader, Section } from "@/components/ui/stat";
import { Alert, EmptyState } from "@/components/ui/states";
import { ResponsiveList, TD, TH, TR } from "@/components/ui/table";
import { SOURCE_HINTS, formatRecognitionValue, type RecognitionSourceKey } from "@/domain/recognition/units";
import { formatDate, initials, pluralise } from "@/lib/utils";

export const metadata = { title: "Employee of the Month" };
export const dynamic = "force-dynamic";

/**
 * What everybody sees.
 *
 * No permission beyond the module being on, because the case for this feature
 * falls apart the moment the rules are private: the ranking is arithmetic
 * precisely so that the person who came second can check it. So the parameters,
 * their weights and the winner's own figures are all on this page, for
 * everybody, whether or not they can change any of it.
 */
export default async function RecognitionPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, { module: "recognition", what: "Employee of the Month" });
  if (denied) return denied;

  const [award, setup, history] = await Promise.all([
    getCurrentAward(ctx),
    getRecognitionSetup(ctx),
    listAwardHistory(ctx),
  ]);

  const currency = ctx.organization?.currency ?? "INR";
  const active = setup.parameters.filter((p) => p.active);
  const canManage = hasPermission(ctx, "recognition.manage");
  // The current award is the head of the history; showing it twice reads as two awards.
  const earlier = history.filter((h) => h.cycleId !== award?.cycleId);

  return (
    <>
      <PageHeader
        title="Employee of the Month"
        description={
          active.length > 0
            ? `Decided on ${pluralise(active.length, "measure")}, each normalised across everybody eligible and weighted.`
            : "Nothing has been set up to measure yet."
        }
        action={
          canManage ? (
            <Button asChild variant="secondary" size="sm">
              <Link href="/recognition/settings">Manage</Link>
            </Button>
          ) : undefined
        }
      />

      {/* ---------- the winner ---------- */}
      {award ? (
        <Section
          title={award.period.label}
          description={`Published ${formatDate(award.publishedAt)}`}
        >
          <div className="p-4">
            <div className="flex flex-wrap items-center gap-4">
              <span className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-full bg-primary-muted text-lg font-semibold text-primary">
                {award.places[0]?.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={award.places[0].photoUrl} alt="" className="size-full object-cover" />
                ) : (
                  initials(award.places[0]?.name ?? "?")
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold tracking-tight">{award.places[0]?.name}</h2>
                  <Badge tone="warning">
                    <Trophy className="size-3" aria-hidden />
                    {award.places[0]?.awardsWon === 1
                      ? "First win"
                      : `${award.places[0]?.awardsWon}× winner`}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {[award.places[0]?.designation, award.places[0]?.department].filter(Boolean).join(" · ") ||
                    award.places[0]?.employeeCode}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Score</p>
                <p className="tabular text-2xl font-semibold leading-tight">
                  {award.places[0]?.totalScore.toFixed(2)}
                </p>
                <p className="text-xs text-muted-foreground">out of 100</p>
              </div>
            </div>

            {award.citation ? (
              <p className="mt-4 whitespace-pre-line border-l-2 border-primary/40 pl-3 text-sm">
                {award.citation}
              </p>
            ) : null}

            {award.places[0]?.overrideReason ? (
              <div className="mt-4">
                <Alert tone="info" title="Chosen over the top score">
                  {award.places[0].overrideReason}
                </Alert>
              </div>
            ) : null}
          </div>

          {/* The winner's own figures. This is the part somebody disputes. */}
          {award.workings.length > 0 ? (
            <div className="border-t border-border">
              <div className="space-y-3 px-4 pt-3">
                <div>
                  <h3 className="text-sm font-semibold">How that score was reached</h3>
                  <p className="text-xs text-muted-foreground">
                    Each figure placed on a 0–1 scale against everybody eligible that month, then
                    multiplied by its weight.
                  </p>
                </div>
                {award.weightsChangedSince ? (
                  <Alert tone="warning" title="The weights have changed since this was published">
                    The figures below are the ones {award.period.label} was scored on, but the
                    weights shown are today&rsquo;s, so the column no longer adds up to the score.
                  </Alert>
                ) : null}
              </div>
              <ResponsiveList
                items={award.workings}
                empty={<EmptyState title="No figures recorded" />}
                head={
                  <>
                    <TH>Measure</TH>
                    <TH numeric>Their figure</TH>
                    <TH numeric>Normalised</TH>
                    <TH numeric>Weight</TH>
                    <TH numeric>Score</TH>
                  </>
                }
                row={(w) => (
                  <TR key={w.parameterId}>
                    <TD>
                      <span className="flex items-center gap-1.5">
                        {w.parameterName}
                        <Direction direction={w.direction} />
                      </span>
                    </TD>
                    <TD numeric className={w.missing ? "text-warning-text" : undefined}>
                      {w.missing ? "not entered" : formatRecognitionValue(w.raw, w.unit, currency)}
                    </TD>
                    <TD numeric>{w.normalised.toFixed(3)}</TD>
                    <TD numeric>{w.weight}</TD>
                    <TD numeric className="font-medium">{w.contribution.toFixed(2)}</TD>
                  </TR>
                )}
                card={(w) => (
                  <div key={w.parameterId} className="flex items-center justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{w.parameterName}</span>
                      <span className="block text-xs text-muted-foreground">
                        {w.missing ? "not entered" : formatRecognitionValue(w.raw, w.unit, currency)}{" "}
                        · normalised {w.normalised.toFixed(3)} × {w.weight}
                      </span>
                    </span>
                    <span className="tabular text-sm font-medium">{w.contribution.toFixed(2)}</span>
                  </div>
                )}
              />
            </div>
          ) : null}

          {award.places.length > 1 ? (
            <div className="border-t border-border p-4">
              <h3 className="mb-2 text-sm font-semibold">Also in contention</h3>
              <ul className="space-y-2">
                {award.places.slice(1).map((place) => (
                  <li key={place.employeeId} className="flex items-center gap-3">
                    <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-xs font-semibold">
                      {place.photoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={place.photoUrl} alt="" className="size-full object-cover" />
                      ) : (
                        initials(place.name)
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{place.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {place.designation ?? place.employeeCode}
                      </span>
                    </span>
                    <Badge tone="outline">#{place.rank}</Badge>
                    <span className="tabular w-14 text-right text-sm">{place.totalScore.toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Section>
      ) : (
        <Section title="This month" description="Nothing has been published yet.">
          <EmptyState
            icon={Trophy}
            title="Not published yet"
            description={
              canManage
                ? "A month is scored once it is over and the figures are in. Draft it, check the workings, then publish."
                : "The result is published once the month is over and every figure is in."
            }
            action={
              canManage ? (
                <Button asChild variant="secondary" size="sm">
                  <Link href="/recognition/settings">Open the draft</Link>
                </Button>
              ) : undefined
            }
          />
        </Section>
      )}

      {/* ---------- the rules ---------- */}
      <div className="mt-4">
        <Section
          title="What it is decided on"
          description={
            setup.weightsValid
              ? "Every figure is placed on the same 0–1 scale before the weights are applied."
              : `The weights currently add up to ${setup.weightsTotal}, not 100.`
          }
        >
          {active.length === 0 ? (
            <EmptyState
              icon={Scale}
              title="No measures set up"
              description={
                canManage
                  ? "Choose up to five things to measure, and how much each one counts."
                  : "An administrator has not chosen what this award is decided on yet."
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {active.map((parameter) => (
                <li key={parameter.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      {parameter.name}
                      <Direction direction={parameter.direction} />
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {SOURCE_HINTS[parameter.source as RecognitionSourceKey]}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span
                      className="h-1.5 w-24 overflow-hidden rounded-full bg-muted"
                      aria-hidden
                    >
                      <span
                        className="block h-full rounded-full bg-primary"
                        style={{ width: `${parameter.weight}%` }}
                      />
                    </span>
                    <Badge tone="primary">{parameter.weight}%</Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {setup.settings.cooldownMonths > 0 ? (
            <div className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
              Somebody who has won in the last {setup.settings.cooldownMonths} months is not eligible,
              so the award moves around.
            </div>
          ) : null}
        </Section>
      </div>

      {/* ---------- previous winners ---------- */}
      <div className="mt-4">
        <Section title="Previous winners">
          {earlier.length === 0 ? (
            <EmptyState icon={History} title="No earlier months yet" />
          ) : (
            <ul className="divide-y divide-border">
              {earlier.map((row) => (
                <li key={row.cycleId} className="flex items-center gap-3 px-4 py-3">
                  <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-xs font-semibold">
                    {row.winner.photoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={row.winner.photoUrl} alt="" className="size-full object-cover" />
                    ) : (
                      initials(row.winner.name)
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{row.winner.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {row.winner.designation ?? row.winner.employeeCode}
                    </span>
                  </span>
                  <Badge tone="neutral">{row.period.label}</Badge>
                  <span className="tabular w-14 text-right text-sm">
                    {row.winner.totalScore.toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}

/** Which way round the measure runs, since half of them are the other way. */
function Direction({ direction }: { direction: string }) {
  // The label goes on the icon with `role="img"`, not on the wrapping span:
  // `aria-label` on a span with no role names nothing, so the arrow — which is
  // the only thing saying which way the measure runs — would be silent.
  return direction === "LOWER_IS_BETTER" ? (
    <span className="inline-flex items-center text-info-text" title="Lower is better">
      <ArrowDown className="size-3.5" role="img" aria-label="Lower is better" />
    </span>
  ) : (
    <span className="inline-flex items-center text-muted-foreground" title="Higher is better">
      <ArrowUp className="size-3.5" role="img" aria-label="Higher is better" />
    </span>
  );
}

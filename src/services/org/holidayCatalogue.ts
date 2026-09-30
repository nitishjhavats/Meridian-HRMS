import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requireWrite } from "@/lib/auth/guard";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { formatDate } from "@/lib/utils";
import { CATALOGUE_YEARS, hasFestivalDates, holidayCatalogue } from "@/domain/org/holidayCatalogue";
import { announceHoliday } from "@/services/org/calendar";

/**
 * Switching a suggested holiday on or off for a year.
 *
 * No organisation gets any holidays when it is created, so every new company
 * started by typing Republic Day into a form — and a holiday is not a cosmetic
 * setting: it decides whether a day is payable.
 *
 * On creates a `Holiday` row; off deletes it. That is not lossy, because the
 * catalogue in `domain/org/holidayCatalogue` is the memory — a holiday removed
 * this year is still there to add next year.
 *
 * **Switching one on also announces it**, which was the point of asking. A
 * holiday nobody is told about is a day half the office comes in. The words are
 * `announceHoliday`'s, shared with the holidays typed in by hand on the
 * calendar screen, and it does not announce a day that was already there.
 */

export interface CatalogueRow {
  key: string;
  name: string;
  date: string;
  /** Lunar calendar: the screen asks somebody to confirm the date. */
  verify: boolean;
  /** Whether this organisation already has it. */
  added: boolean;
  /** Set when it is added, so it can be removed again. */
  holidayId: string | null;
  /** Something else is already on that date, under a different name. */
  clashesWith: string | null;
}

export interface CatalogueView {
  year: number;
  years: number[];
  /** False once past the years the festival dates were researched for. */
  festivalDatesKnown: boolean;
  rows: CatalogueRow[];
}

export async function getHolidayCatalogue(
  ctx: AuthContext,
  year: number,
): Promise<CatalogueView> {
  requireOrg(ctx);

  const catalogue = holidayCatalogue(year);
  const existing = await prisma.holiday.findMany({
    where: {
      organizationId: ctx.organizationId!,
      date: {
        gte: new Date(`${year}-01-01T00:00:00.000Z`),
        lte: new Date(`${year}-12-31T00:00:00.000Z`),
      },
    },
    select: { id: true, name: true, date: true },
  });

  const byDate = new Map(existing.map((h) => [h.date.toISOString().slice(0, 10), h]));

  return {
    year,
    years: [...CATALOGUE_YEARS],
    festivalDatesKnown: hasFestivalDates(year),
    rows: catalogue.map((entry) => {
      const match = byDate.get(entry.date);
      const sameName = match?.name === entry.name;
      return {
        ...entry,
        added: sameName,
        holidayId: sameName ? (match?.id ?? null) : null,
        // A different holiday already on that date. Worth saying, because
        // adding this one would be refused by the unique index anyway and the
        // reason would otherwise be a database error.
        clashesWith: match && !sameName ? match.name : null,
      };
    }),
  };
}

export async function toggleCatalogueHoliday(
  ctx: AuthContext,
  input: { year: number; key: string; on: boolean },
): Promise<CatalogueView> {
  requireOrg(ctx);
  requireWrite(ctx, "org.settings.write", "attendance");

  const entry = holidayCatalogue(input.year).find((h) => h.key === input.key);
  if (!entry) throw new NotFoundError("That holiday");

  const date = new Date(`${entry.date}T00:00:00.000Z`);

  /**
   * A national day can be switched off, and stays off.
   *
   * Round 7 refused this. It was wrong: a plant running a shift on Republic Day
   * is a real thing, and a calendar that cannot describe it is wrong about the
   * world rather than careful. The default does the work instead -- the three
   * arrive on, and arrive again every year, and turning one off is a decision
   * the yearly job does not undo because it never revisits a year it has
   * already seeded.
   */
  if (!input.on) {
    // Scoped by name as well as date: another holiday somebody added by hand on
    // the same day is not this one, and must not be deleted with it.
    const removed = await prisma.holiday.deleteMany({
      where: { organizationId: ctx.organizationId!, name: entry.name, date },
    });
    if (removed.count > 0) {
      await writeAudit(ctx, {
        action: "holiday.deleted",
        entityType: "Holiday",
        after: { removed: entry.name, date: entry.date },
      });
    }
    return getHolidayCatalogue(ctx, input.year);
  }

  const clash = await prisma.holiday.findFirst({
    where: { organizationId: ctx.organizationId!, date },
    select: { name: true },
  });
  if (clash && clash.name !== entry.name) {
    throw new ValidationError(`${clash.name} is already on ${formatDate(entry.date)}.`);
  }

  // Already on the calendar under this name: somebody typed it in by hand, or
  // switched it on before. The upsert below then changes nothing, and the
  // announcement that used to follow it regardless was the second time
  // everybody heard about the same day.
  const alreadyOnCalendar = clash?.name === entry.name;

  const holiday = await prisma.holiday.upsert({
    where: {
      organizationId_name_date: { organizationId: ctx.organizationId!, name: entry.name, date },
    },
    create: {
      organizationId: ctx.organizationId!,
      name: entry.name,
      date,
      type: "PUBLIC",
      paid: true,
      note: entry.verify ? "Added from the suggested list — please confirm the date." : null,
    },
    update: {},
    select: { id: true },
  });

  await writeAudit(ctx, {
    action: "holiday.created",
    entityType: "Holiday",
    entityId: holiday.id,
    after: { added: entry.name, date: entry.date },
  });

  // And tell everybody. The words and the decision are `announceHoliday`'s,
  // shared with the hand-typed holidays on the calendar screen -- two copies of
  // this sentence would drift, and nobody would ever notice that they had.
  await announceHoliday(ctx, {
    created: !alreadyOnCalendar,
    name: entry.name,
    date: entry.date,
    verify: entry.verify,
  });

  return getHolidayCatalogue(ctx, input.year);
}

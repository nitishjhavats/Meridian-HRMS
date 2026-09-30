import { prisma } from "@/lib/db/prisma";
import { faceEngineState } from "@/lib/face/engine";

/**
 * Liveness, for the container orchestrator.
 *
 * Deliberately does not touch the database. Coolify probes this every thirty
 * seconds; a query per probe is a wasted round trip, and it turns a momentary
 * database blip into a restart loop that takes the app down for everybody
 * rather than for the one request that would have failed anyway.
 *
 * `?deep=1` does check the database, for when a person is asking rather than a
 * scheduler. Neither form reports a version, a hostname or anything else that
 * tells an unauthenticated caller what is running here.
 *
 * The deep form also answers "did last night happen?". A container can be up
 * and healthy for weeks while the maintenance cron quietly stops firing, and
 * from outside the two are indistinguishable -- so selfies stop ageing out,
 * chat stops being purged after thirty days, and nobody finds out until
 * somebody asks why a deleted message is still there. Point an uptime check at
 * `?deep=1` and a missed night becomes a 503.
 *
 * And "is the face check running?", for the same reason. If ONNX fails to load,
 * `evaluateFaceMatch` treats it as the system's fault and lets attendance
 * through -- correctly, because refusing everybody at the door over a missing
 * model file is worse -- so the control that stops one person marking another's
 * attendance can be absent with nothing to show for it but a line in a boot log
 * that the next deploy throws away. A missing model is a 503 here. `FACE_MATCHING=off`
 * is not: that is somebody's decision, and it is reported rather than alerted on.
 */

// @unreachable-ok an uptime monitor and Coolify's healthcheck call this, not the app
export const dynamic = "force-dynamic";

/**
 * How stale the last maintenance run may be before it counts as missed.
 *
 * The job runs nightly, so 26 hours catches a single skipped night rather than
 * waiting for a second one. A never-run instance is stale too: that is the
 * truth on a fresh deployment, and it is worth saying out loud.
 */
const MAINTENANCE_MAX_AGE_HOURS = 26;

export async function GET(request: Request) {
  const deep = new URL(request.url).searchParams.get("deep") === "1";

  if (!deep) {
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    await prisma.$queryRaw`SELECT 1`;

    const setting = await prisma.platformSetting.findUnique({
      where: { id: "singleton" },
      select: { lastMaintenanceAt: true },
    });
    const lastRun = setting?.lastMaintenanceAt ?? null;
    const ageHours = lastRun ? (Date.now() - lastRun.getTime()) / 3_600_000 : null;
    const stale = ageHours === null || ageHours > MAINTENANCE_MAX_AGE_HOURS;

    const face = await faceEngineState();
    // Switched off is a decision; failing to load is a fault. Only the second
    // one should wake anybody.
    const faceBroken = !face.switchedOff && !face.modelsLoaded;

    const degraded = stale || faceBroken;

    return Response.json(
      {
        ok: !degraded,
        database: "up",
        maintenance: {
          lastRunAt: lastRun?.toISOString() ?? null,
          ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
          maxAgeHours: MAINTENANCE_MAX_AGE_HOURS,
          stale,
        },
        faceMatching: {
          // What an operator wants to know in one word, before the detail.
          state: face.switchedOff ? "off" : face.modelsLoaded ? "running" : "broken",
          switchedOff: face.switchedOff,
          modelsLoaded: face.modelsLoaded,
          reason: face.reason,
        },
      },
      // 503 so an uptime check alerts. The orchestrator probes the shallow form
      // above, so neither a missed night nor a missing model restarts a
      // container that is otherwise serving people correctly.
      { status: degraded ? 503 : 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // The reason stays in the server log; an unauthenticated caller gets the
    // fact and nothing else.
    return Response.json(
      { ok: false, database: "down" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

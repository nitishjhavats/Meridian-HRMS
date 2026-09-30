/**
 * Geofence checks for GPS check-in.
 *
 * The server is the only authority: the browser sends coordinates and accuracy,
 * the server computes the distance and decides. A client-side "withinRadius"
 * flag is never trusted.
 */

const EARTH_RADIUS_M = 6_371_000;

export interface Coordinates {
  latitude: number;
  longitude: number;
  /** Reported horizontal accuracy in metres, if the device provided it. */
  accuracyMeters?: number | null;
}

export interface Geofence {
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

export type GeoRejectReason =
  | "OUTSIDE_RADIUS"
  | "ACCURACY_TOO_LOW"
  | "IMPLAUSIBLE_COORDINATES"
  | "COORDINATES_MISSING";

export interface GeoCheckResult {
  ok: boolean;
  distanceMeters: number | null;
  reason?: GeoRejectReason;
  message?: string;
}

/** Great-circle distance in metres (haversine). */
export function distanceMeters(a: Coordinates, b: Geofence): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))));
}

export function isPlausible(coords: Coordinates): boolean {
  const { latitude, longitude } = coords;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return false;
  // Null Island: almost always a spoofed or uninitialised reading.
  if (Math.abs(latitude) < 1e-7 && Math.abs(longitude) < 1e-7) return false;
  return true;
}

/**
 * The widest accuracy circle a reading may carry and still be treated as proof
 * of where somebody is.
 *
 * This used to be `radius × 3` and nothing else, which had two problems. A
 * ±250 m reading that computes 80 m from the office was trusted exactly as
 * much as a surveyed one -- accuracy gates entry and then plays no part in the
 * comparison. And because it scaled with the radius, widening a fence *loosened*
 * the evidence: moving every organisation to 150 m would have quietly raised
 * the tolerance to ±450 m.
 *
 * 75 m was then chosen as the ceiling, and 75 m turned out to be far too wide
 * for the decision being made: it is half the shipped 150 m radius, so a
 * reading at the ceiling is consistent with being inside the fence and with
 * being outside it. Somebody standing well outside was shown an honest 65 m and
 * a green button, because Android's fused provider answers instantly at exactly
 * that quality from Wi-Fi and cell, anchored wherever it last was.
 *
 * So this is now the *cap* on `accuracyBudget`, which scales the real limit to
 * a third of the fence. 35 m is what a phone reports outdoors with a clear view
 * once it has a genuine satellite fix; anything worse is a network estimate,
 * and a network estimate cannot tell the office from the road outside it.
 *
 * Where this still applies: an administrator placing a fence's centre from
 * their own phone (`Structure.tsx`), and an organisation that has switched the
 * check-in gate on (`gpsAccuracy.enforce`) -- it is that switch's shipped
 * limit. It is no longer applied to a check-in by default: measured on a live
 * organisation, the people it turned away were standing at the counter with a
 * phone too old to do better than ±50 m.
 */
export const MAX_ACCURACY_METERS = 35;

/**
 * The floor, so a small fence stays usable.
 *
 * A third of a 20 m fence is 7 m, which almost no phone reports and no indoor
 * reading ever will -- the budget would refuse everybody. 15 m is achievable
 * outdoors and still a quarter of the smallest fence this product accepts.
 */
export const MIN_ACCURACY_BUDGET_METERS = 15;

export interface GeoCheckOptions {
  /**
   * Reject readings whose reported accuracy is worse than this.
   *
   * Absent or `null`: the accuracy is not consulted and the distance alone
   * decides. There used to be a default here (`accuracyBudget` of the fence)
   * and it was the whole gate: an old phone that can only say "somewhere within
   * ±60 m" was refused however close it stood, and nothing recorded the
   * refusal. The gate is now the organisation's choice (`gpsAccuracy` in the
   * attendance policy), off unless it asks; the reading is still stored with
   * every mark so a reviewer can see when it was rough.
   */
  maxAccuracyMeters?: number | null;
  /**
   * Whether the reported accuracy is allowed to widen the fence. Off by default:
   * a generous accuracy circle should not become a licence to be far away.
   */
  allowAccuracySlack?: boolean;
}

/**
 * A distance somebody can read at a glance.
 *
 * "830281 m" is technically the answer and practically useless — nobody
 * converts six digits of metres in their head to realise they are in the wrong
 * city.
 */
export function describeDistance(metres: number): string {
  if (metres < 1_000) return `${Math.round(metres)} m`;
  if (metres < 10_000) return `${(metres / 1_000).toFixed(1)} km`;
  return `${Math.round(metres / 1_000)} km`;
}

/**
 * The widest accuracy circle that can still decide a fence of this size.
 *
 * The old rule was `min(75, radius)`, which for the shipped 150 m fence allowed
 * a reported accuracy of **75 m** — half the radius. That is not a rounding
 * concern, it is the whole answer: a device reporting ±75 m is saying the true
 * position is somewhere in a 150 m circle, so "inside a 150 m fence" and
 * "outside it" are both consistent with the reading. Android's fused provider
 * answers instantly from Wi-Fi and cell at exactly that quality, anchored to
 * whatever it last saw — which is how somebody standing well outside was shown
 * a confident, honest, and entirely wrong distance.
 *
 * A **third** of the radius, floored so small fences stay usable and capped so
 * large ones do not become permissive:
 *
 *   20 m fence  -> 15 m   (the floor; below this nothing would ever pass)
 *   100 m fence -> 33 m
 *   150 m fence -> 35 m   (the cap, and the shipped default)
 *   500 m fence -> 35 m
 *
 * It was a fifth. Loosened deliberately, with the cap left where it is -- and
 * the cap is what keeps this honest. A third of a large fence would climb past
 * the point where a reading can decide anything, so 35 m remains the worst
 * evidence this product will act on whatever the radius says.
 *
 * This refuses readings that were accepted before. That is the point, and it is
 * why the check-in screen now says which of the two problems it has — a bad
 * reading or a real distance — instead of printing a number either way.
 */
export function accuracyBudget(radiusMeters: number): number {
  const third = Math.round(radiusMeters / 3);
  return Math.max(MIN_ACCURACY_BUDGET_METERS, Math.min(MAX_ACCURACY_METERS, third));
}

export function checkGeofence(
  coords: Coordinates | null | undefined,
  fence: Geofence,
  options: GeoCheckOptions = {},
): GeoCheckResult {
  if (!coords) {
    return {
      ok: false,
      distanceMeters: null,
      reason: "COORDINATES_MISSING",
      message: "Location is required to mark attendance. Please enable GPS and try again.",
    };
  }
  if (!isPlausible(coords)) {
    return {
      ok: false,
      distanceMeters: null,
      reason: "IMPLAUSIBLE_COORDINATES",
      message: "The location reading looks invalid. Move to an open area and try again.",
    };
  }

  const maxAccuracy = options.maxAccuracyMeters ?? null;
  const accuracy = coords.accuracyMeters ?? null;
  if (maxAccuracy != null && accuracy != null && accuracy > maxAccuracy) {
    return {
      ok: false,
      distanceMeters: null,
      reason: "ACCURACY_TOO_LOW",
      message: `GPS accuracy is ±${Math.round(accuracy)} m, which is too imprecise. Move outdoors and retry.`,
    };
  }

  const distance = distanceMeters(coords, fence);
  const slack = options.allowAccuracySlack && accuracy != null ? accuracy : 0;
  if (distance > fence.radiusMeters + slack) {
    return {
      ok: false,
      distanceMeters: distance,
      reason: "OUTSIDE_RADIUS",
      message: `You are ${describeDistance(distance)} from the office; check-in is allowed within ${fence.radiusMeters} m.`,
    };
  }

  return { ok: true, distanceMeters: distance };
}

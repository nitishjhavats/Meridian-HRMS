/**
 * Where each role lands after signing in.
 *
 * The platform owner has a separate route tree; every organisation role shares
 * one shell whose navigation and dashboard adapt to their permissions.
 */
export function landingFor(role: string): string {
  if (role === "KIOSK") return "/kiosk";
  return role === "SUPERADMIN" ? "/platform" : "/dashboard";
}

/**
 * Where "Sign in" goes from the forgot-password screen.
 *
 * The form is mounted twice: at `/forgot-password` and behind each
 * organisation's own door at `/o/<slug>/forgot-password`. Somebody who came
 * through the branded door should go back through it -- `/login` is the
 * unbranded page the tenant route deliberately redirects people away from --
 * so the target is read off the path the form is on rather than assumed.
 */
export function signInHrefFor(pathname: string | null | undefined): string {
  const tenant = /^\/o\/([^/]+)\/forgot-password\/?$/.exec(pathname ?? "");
  return tenant ? `/o/${tenant[1]}` : "/login";
}

/**
 * Who gets a reset code.
 *
 * Only the organisation's Owner and Admins: the platform owner releases their
 * code by hand (see `SUPERADMIN_RELEASED_ROLES`). Everybody else is reset by
 * HR or an Admin from their employee profile and handed a temporary password.
 * The server answers every request identically, on purpose, so the form cannot
 * learn which path applies -- the person has to say.
 */
export type ResetPath = "code" | "hr";

/**
 * The caller's IP address, as far as it can be trusted.
 *
 * `X-Forwarded-For` is a list, and a reverse proxy **appends** to whatever the
 * client sent rather than replacing it. Traefik does exactly this. So the
 * conventional `split(",")[0]` reads the *client's* first entry — a value the
 * client wrote, and can therefore rotate at will.
 *
 * That is not a cosmetic problem. This value keys the login and OTP rate
 * limiters; a caller who controls it has no rate limit at all, and every audit
 * row records an address of their choosing.
 *
 * With exactly one reverse proxy in front — the deployment here is Traefik and
 * nothing else — the **last** entry is the one the proxy appended, which is the
 * address it actually accepted the connection from. That is the only entry a
 * client cannot forge.
 *
 * Locally there is no proxy, no header, and this returns the fallback. If a
 * second proxy is ever put in front (a CDN, a load balancer), this needs to
 * skip that many trailing entries instead — hence the constant rather than a
 * bare `.at(-1)`.
 */

/** Reverse proxies between this app and the internet. Traefik, and only Traefik. */
const TRUSTED_PROXY_HOPS = 1;

export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");

  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    // The entry the outermost trusted proxy appended.
    const trusted = hops[hops.length - TRUSTED_PROXY_HOPS];
    if (trusted) return trusted;
  }

  // Traefik overwrites this one rather than appending, so it is safe when
  // present — and it is the only signal when there is no XFF at all.
  return headers.get("x-real-ip");
}

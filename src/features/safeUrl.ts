/**
 * An href you can hand to an <a> without wondering where it came from.
 *
 * `sourceUrl` is scraped third-party data that round-trips through the DB and
 * is rendered as a link on every catalog recipe's detail screen. Nothing
 * checked the scheme, so a row carrying `javascript:...` — or a `data:` URL
 * — became a one-tap script execution in the app's own origin. It is not a
 * hypothetical field either: `sanitizeRecipe` accepts any 500-character
 * string, and the catalog is built from a scrape.
 *
 * Allowlist, not denylist: `http:` and `https:` are the only schemes a recipe
 * source can legitimately be, and an allowlist can't be walked around with
 * `JaVaScRiPt:` or an embedded newline the way a blocklist can. Anything else
 * returns null, and the caller renders plain text instead of a link.
 */
const SAFE_SCHEMES = new Set(["http:", "https:"]);

export function safeHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    // `new URL` resolves the scheme the way the browser will, which is the
    // only parser whose opinion actually matters here.
    const u = new URL(trimmed);
    return SAFE_SCHEMES.has(u.protocol) ? u.href : null;
  } catch {
    return null; // not an absolute URL at all
  }
}

/** The host, for showing a user where a link actually goes. */
export function hrefHost(raw: string | null | undefined): string | null {
  const safe = safeHref(raw);
  if (!safe) return null;
  try {
    return new URL(safe).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

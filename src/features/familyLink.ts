/**
 * Family invite links. A link is `<conjureos-web>/join?c=<inviteCode>`.
 * Opening it lands in ConjureOS, which stashes the code and hands it to this
 * app; pasting the same link into Recipes → Family → Join also works, because
 * `parseInvite` pulls the code back out. The web base is derived from which
 * Supabase project the kernel injected (dev vs prod), falling back to the app's
 * own origin.
 *
 * `/join` is a dedicated path, not a query param on `/`, so the native app can
 * claim invite links via Universal Links / App Links without claiming every
 * conjureos.com URL. `parseInvite` still reads the older `?joinFamily=` form —
 * a shared link lives forever, and that's one regex, not a UI branch.
 */

interface Env {
  env?: { recipesApiUrl?: string };
}
const api = (): string => ((globalThis as { __conjureos?: Env }).__conjureos?.env?.recipesApiUrl ?? "");

/**
 * The ConjureOS web origin for the current environment.
 *
 * This must be the KERNEL shell (`conjureos.com`), not the app host
 * (`<slug>.conjureos.app`). An invite link has to open ConjureOS itself so the
 * shell can route the recipient into Recipes; `conjureos.app` only ever serves
 * sandboxed app iframes, so a link there is a dead end. Our own hostname ending
 * in `.conjureos.app` is what tells us we're running under the PROD shell.
 */
const PROD_WEB = "https://conjureos.com";

export function webBase(): string {
  const a = api();
  if (a.includes("ntgelbtepecqsqloxmct")) return PROD_WEB; // prod project
  if (a.includes("mqpvjlsywrptefgwuztn")) return "https://dev.conjureos.pages.dev"; // dev project
  try {
    const h = (globalThis as { location?: { hostname?: string } }).location?.hostname ?? "";
    if (h.endsWith(".conjureos.app")) return PROD_WEB;
  } catch {
    /* ignore */
  }
  return PROD_WEB;
}

export function familyInviteLink(code: string): string {
  return `${webBase()}/join?c=${encodeURIComponent(code)}`;
}

/** Extract an invite code from a pasted link OR a bare code. Null if neither. */
export function parseInvite(input: string): string | null {
  const s = input.trim();
  const m = s.match(/[?&](?:joinFamily|c)=([A-Za-z0-9]+)/i);
  if (m) return m[1]!.toUpperCase();
  const bare = s.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return bare.length >= 4 && bare.length <= 16 ? bare : null;
}

/**
 * The Recipes terms for content people add, and the gate that asks for them.
 *
 * Owner decision (2026-09-23): users KEEP ownership of what they upload and
 * grant ConjureOS LLC a broad licence — not a transfer of ownership, which is
 * harder to enforce and impossible for recipes a user copied from somewhere
 * else. The text below is a DRAFT written by an engineer, not a lawyer; have
 * it reviewed before relying on it. Bump TERMS_VERSION whenever it changes:
 * the app asks again whenever the version a user accepted is older.
 *
 * Enforcement is server-side too: recipes-db refuses `add` / `update` /
 * `chefUpsert` / `uploadImage` until the caller has accepted SOME version
 * (migration 153). This module is the friendly half — it asks before the
 * write instead of letting the write fail.
 */

export const TERMS_VERSION = "2026-09-23";

export const TERMS_TITLE = "Recipes terms for your content";

/** Paragraphs, rendered in order. Plain text only. */
export const TERMS_BODY: string[] = [
  "These terms cover anything you add to Recipes — recipes you write, photograph, describe or edit, their text, and any photo or image attached to them (\"your content\"). They sit alongside the ConjureOS terms of service.",
  "You keep ownership of your content. By adding it to Recipes you grant ConjureOS LLC a worldwide, perpetual, irrevocable, royalty-free, non-exclusive licence to host, store, copy, use, adapt, edit, translate, publish, display and distribute it, and to create derivative works from it, in any media, and to sublicense these rights to others — including to operate, promote and improve ConjureOS and its apps. This licence continues after you delete your content or your account, for copies already made or shared.",
  "You confirm that you have the right to grant this licence: the content is yours, or you have permission to share it, and it doesn't infringe anyone else's rights. Don't upload recipes or photos copied from cookbooks, websites or other people unless you're allowed to.",
  "AI-generated images are marked \"AI-generated\" on the image itself. Don't remove or hide that mark, and don't present an AI image as a real photograph of your cooking.",
  "Don't add anything unlawful, hateful, harassing, sexually explicit, dangerous (including unsafe food-handling advice), or that impersonates someone else.",
  "ConjureOS LLC may review, edit, hide or remove any content, and may suspend or remove your access to Recipes, at any time and for any reason, including a breach of these terms. Removing your access to Recipes does not affect the rest of your ConjureOS account.",
  "Recipes and nutrition information are provided for general information only. Check ingredients for allergies and cook food safely; ConjureOS LLC is not responsible for the outcome of any recipe.",
  "We may update these terms. If we do, Recipes will ask you to accept the new version before you add more content.",
];

// ── the gate ────────────────────────────────────────────────────────────

let acceptedVersion: string | null = null;
let known = false;
/** Set by App: shows the terms sheet, resolves true on accept, false on decline. */
let opener: (() => Promise<boolean>) | null = null;

/** What the server says the user accepted (from `myRole`). */
export function setAcceptedTermsVersion(version: string | null): void {
  acceptedVersion = version;
  known = true;
}

export function registerTermsOpener(fn: (() => Promise<boolean>) | null): void {
  opener = fn;
}

export function hasAcceptedCurrentTerms(): boolean {
  return acceptedVersion === TERMS_VERSION;
}

export class TermsDeclinedError extends Error {
  constructor() {
    super("You need to accept the Recipes terms before adding recipes or photos.");
    this.name = "TermsDeclinedError";
  }
}

/**
 * Before any write that adds content: make sure the current terms are
 * accepted, asking if they aren't. Resolves when they are; throws
 * TermsDeclinedError if the user says no. Outside ConjureOS (no role loaded,
 * no opener) it does nothing — the dev server has no backend to refuse.
 */
export async function ensureTermsAccepted(): Promise<void> {
  if (!known || !opener || hasAcceptedCurrentTerms()) return;
  const ok = await opener();
  if (!ok) throw new TermsDeclinedError();
}

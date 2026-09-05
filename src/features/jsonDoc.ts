/**
 * Safe read-modify-write for the dot-file JSON indexes under
 * /home/Documents/Recipes/ (.pantry.json, .favorites.json, .blocked.json,
 * stores.json).
 *
 * The bug this exists to prevent: each of those files was loaded with a
 * `catch { return empty }`, and every mutator is a read-modify-write. So a
 * single failed read — a transport hiccup, a permission blip, a half-synced
 * file that parses badly — made the loader answer "you have nothing", and the
 * very next add/toggle wrote that nothing back over the real file. A pantry of
 * four items became a pantry of one. Proved by execution, not theory.
 *
 * The distinction that fixes it is between two answers a loader can give:
 *
 *   - **"absent"** — `exists()` says no file. Genuinely empty, safe to write.
 *     A first-time user must still be able to add their first item.
 *   - **"unknown"** — the file is there but we could not read or trust it.
 *     NOT the same as empty, and never a safe base for a write.
 *
 * Anything short of a clean parse is "unknown", oversized and shape-mismatched
 * included: a truncated file is exactly the case that used to destroy data.
 *
 * `planStorage.ts` already solved this for the plans folder (`VfsPlanListing`);
 * this is the same idea, factored out so four call sites share one implementation
 * instead of four copies of the same mistake.
 */

import { vfs } from "../bridge/vfs";

/** `ok: false` means "we don't know what's in this file" — never "it's empty". */
export type DocLoad<T> = { ok: true; value: T } | { ok: false };

/** Thrown by mutators that refuse to write over state they couldn't read. */
export class UnreadableDocError extends Error {
  constructor(what: string) {
    super(
      `Couldn't read your saved ${what}, so nothing was changed. ` +
        `Check your connection and try again — your existing ${what} is untouched.`,
    );
    this.name = "UnreadableDocError";
  }
}

/**
 * Read and validate a JSON document. `parse` returns null to reject a payload
 * whose shape is wrong; that counts as unknown, not empty.
 */
export async function readJsonDoc<T>(
  path: string,
  parse: (raw: unknown) => T | null,
  opts: { maxBytes: number; empty: T },
): Promise<DocLoad<T>> {
  let present: boolean;
  try {
    present = await vfs.exists(path);
  } catch {
    return { ok: false }; // can't even tell whether it's there
  }
  if (!present) return { ok: true, value: opts.empty };

  let text: string;
  try {
    text = await vfs.read(path);
  } catch {
    return { ok: false };
  }
  // Oversized reads used to return empty. A file over the cap is far more
  // likely to be a real index we should leave alone than a genuinely empty one.
  if (text.length > opts.maxBytes) return { ok: false };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  const parsed = parse(raw);
  return parsed === null ? { ok: false } : { ok: true, value: parsed };
}

/**
 * Load for a mutator. Throws rather than handing back a wrong-but-plausible
 * empty value, so the caller cannot accidentally persist it.
 */
export async function requireJsonDoc<T>(
  path: string,
  parse: (raw: unknown) => T | null,
  opts: { maxBytes: number; empty: T; what: string },
): Promise<T> {
  const r = await readJsonDoc(path, parse, opts);
  if (!r.ok) throw new UnreadableDocError(opts.what);
  return r.value;
}

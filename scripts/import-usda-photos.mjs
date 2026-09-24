/**
 * import-usda-photos.mjs: give the USDA-credited MyPlate recipes their photos.
 *
 * WHICH photos, and why only these (owner decision, 2026-09-23): a photo is
 * imported only for a recipe whose MyPlate page credits a FEDERAL source
 * (USDA, HHS, …). Those are US government works, public domain. Most of the
 * catalog credits a partner instead — a state university, a nonprofit, a
 * company — and those partners may still own their photos; USDA's permission
 * to show them on myplate.gov does not pass to us. The list is
 * `scripts/usda-photos.json`, written by `scripts/usda-photo-census.py`; this
 * script imports exactly what that file lists and nothing else.
 *
 * What it does, per recipe:
 *   1. Fetch the photo from the Internet Archive's capture of myplate.gov,
 *      trying each archived size in turn
 *      (the live site and its image CDN were retired in January 2026).
 *      Cached under scripts/.cache/usda-photos/, so a re-run doesn't refetch.
 *   2. Upload it to the public `recipe-images` bucket (migration 109) at
 *      `usda-myplate/<slug>.jpg`, overwriting any earlier upload.
 *   3. Set `image_url` on the catalog row, matched by `source_url` AND
 *      `provenance = 'usda-myplate'` — never by id, so the same file works on
 *      dev and prod, and never touching a user's own recipe.
 * Idempotent: running it twice leaves the same end state.
 *
 * Needs the project's SERVICE ROLE key (Supabase dashboard → Project Settings
 * → API). Pass it in the environment; never commit it or paste it anywhere.
 *
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/import-usda-photos.mjs --dry-run     # show what it would do
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/import-usda-photos.mjs               # do it
 *
 * Undo (SQL editor, per project) — clears only what this script set:
 *   update public.recipes set image_url = null
 *    where provenance = 'usda-myplate'
 *      and image_url like '%/recipe-images/usda-myplate/%';
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, "usda-photos.json");
const CACHE = join(HERE, ".cache", "usda-photos");
const BUCKET = "recipe-images";
const PREFIX = "usda-myplate";

const DRY = process.argv.includes("--dry-run");
const URL_BASE = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!URL_BASE || !KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see the header of this file).");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = { Authorization: `Bearer ${KEY}`, apikey: KEY };

/** The Archive resets connections under load; back off and retry. */
async function fetchPhoto(entry) {
  const file = join(CACHE, `${entry.slug}.jpg`);
  if (existsSync(file) && statSync(file).size > 2000) return readFileSync(file);
  // Every size the page linked, biggest first: the Archive often holds some
  // renditions of a photo and not others. A 5xx/404 means "not archived" —
  // move on; a network error means "throttled" — back off and retry.
  for (const url of entry.archivedImages) {
    for (let attempt = 0; attempt < 4; attempt++) {
      let res;
      try {
        res = await fetch(url, { redirect: "follow" });
      } catch {
        await sleep(3000 + attempt * 4000);
        continue;
      }
      const type = res.headers.get("content-type") || "";
      if (res.ok && type.startsWith("image/")) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 2000) {
          writeFileSync(file, buf);
          return buf;
        }
      }
      break; // answered, but not with an image: try the next size
    }
  }
  return null;
}

async function upload(entry, buf) {
  const res = await fetch(`${URL_BASE}/storage/v1/object/${BUCKET}/${PREFIX}/${entry.slug}.jpg`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "image/jpeg", "x-upsert": "true", "Cache-Control": "max-age=31536000" },
    body: buf,
  });
  if (!res.ok) throw new Error(`upload ${res.status}: ${await res.text()}`);
  return `${URL_BASE}/storage/v1/object/public/${BUCKET}/${PREFIX}/${entry.slug}.jpg`;
}

async function setImageUrl(entry, publicUrl) {
  const q = new URLSearchParams({
    source_url: `eq.${entry.sourceUrl}`,
    provenance: "eq.usda-myplate",
  });
  const res = await fetch(`${URL_BASE}/rest/v1/recipes?${q}`, {
    method: "PATCH",
    headers: { ...auth, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ image_url: publicUrl }),
  });
  if (!res.ok) throw new Error(`update ${res.status}: ${await res.text()}`);
  return (await res.json()).length;
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const entries = manifest.photos;
mkdirSync(CACHE, { recursive: true });
console.log(`${entries.length} USDA-credited photos to import into ${URL_BASE}${DRY ? " (dry run)" : ""}`);

let done = 0;
const problems = [];
for (const entry of entries) {
  const buf = await fetchPhoto(entry);
  if (!buf) {
    problems.push(`${entry.slug}: photo not retrievable from the Archive`);
    continue;
  }
  if (DRY) {
    console.log(`  would import ${entry.slug} (${Math.round(buf.length / 1024)} KB) — ${entry.credit}`);
    done++;
    continue;
  }
  try {
    const publicUrl = await upload(entry, buf);
    const rows = await setImageUrl(entry, publicUrl);
    if (rows !== 1) problems.push(`${entry.slug}: matched ${rows} catalog rows, expected 1`);
    else done++;
    console.log(`  ${rows === 1 ? "ok " : "?? "} ${entry.slug}`);
  } catch (e) {
    problems.push(`${entry.slug}: ${e.message}`);
  }
  await sleep(1200); // be polite to the Archive
}

console.log(`\n${done}/${entries.length} ${DRY ? "ready" : "imported"}.`);
if (problems.length) {
  console.log(`${problems.length} problem(s):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exitCode = 1;
}

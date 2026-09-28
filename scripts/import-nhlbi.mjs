/**
 * import-nhlbi.mjs: add the NHLBI "Keep the Beat" recipes to the catalog.
 *
 * Imports exactly what scripts/nhlbi-recipes.json lists (written by
 * scripts/nhlbi-census.py, which already deduped against the catalog): 120
 * recipes from the National Heart, Lung, and Blood Institute (NIH), 48 of
 * them with the cookbooks' food photos, each credited "Ben Fink Photography /
 * NHLBI" as the books do (owner decision, 2026-09-28; ConjureOS DECISIONS).
 *
 * Per recipe:
 *   1. If it has a photo, upload it to `recipe-images/nhlbi/<slug>.jpg`
 *      (overwriting any earlier upload).
 *   2. Insert the catalog row (`source = 'catalog'`, `provenance = 'nhlbi'`,
 *      public, no creator), or, when a row with the same `source_url` and
 *      provenance exists, update it in place. Never touches any other row.
 * Idempotent: running it twice leaves the same end state.
 *
 * Needs migration 190 (`recipes.image_credit`) applied, and the project's
 * SERVICE ROLE key in the environment; never commit it or paste it anywhere.
 *
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/import-nhlbi.mjs --dry-run
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-nhlbi.mjs
 *
 * Undo (SQL editor, per project):
 *   delete from public.recipes where provenance = 'nhlbi';
 *   -- and the storage objects under recipe-images/nhlbi/
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, "nhlbi-recipes.json");
const BUCKET = "recipe-images";
const PREFIX = "nhlbi";
const PROVENANCE = "nhlbi";

const DRY = process.argv.includes("--dry-run");
const URL_BASE = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!URL_BASE || !KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see the header of this file).");
  process.exit(1);
}
const auth = { Authorization: `Bearer ${KEY}`, apikey: KEY };

async function rest(path, init = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: { ...auth, "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path.split("?")[0]} ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function uploadPhoto(slug, file) {
  const res = await fetch(`${URL_BASE}/storage/v1/object/${BUCKET}/${PREFIX}/${slug}.jpg`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "image/jpeg", "x-upsert": "true", "Cache-Control": "max-age=31536000" },
    body: readFileSync(file),
  });
  if (!res.ok) throw new Error(`upload ${res.status}: ${await res.text()}`);
  return `${URL_BASE}/storage/v1/object/public/${BUCKET}/${PREFIX}/${slug}.jpg`;
}

// Refuse to run against a project without migration 190, rather than failing
// on every row.
try {
  await rest("recipes?select=image_credit&limit=1");
} catch (e) {
  console.error("recipes.image_credit is missing: apply ConjureOS migration 190 first.\n" + e.message);
  process.exit(1);
}

const { recipes } = JSON.parse(readFileSync(MANIFEST, "utf8"));
console.log(`${recipes.length} NHLBI recipes to import into ${URL_BASE}${DRY ? " (dry run)" : ""}`);

let inserted = 0;
let updated = 0;
let photos = 0;
const problems = [];
for (const r of recipes) {
  const photoFile = r.photo ? join(HERE, r.photo) : null;
  if (photoFile && !existsSync(photoFile)) {
    problems.push(`${r.slug}: photo file missing (run scripts/nhlbi-census.py)`);
    continue;
  }
  try {
    const q = new URLSearchParams({
      source_url: `eq.${r.sourceUrl}`,
      provenance: `eq.${PROVENANCE}`,
      select: "id",
    });
    const existing = await rest(`recipes?${q}`);
    if (DRY) {
      console.log(`  would ${existing.length ? "update" : "insert"} ${r.slug}${photoFile ? " + photo" : ""} [${r.category}]`);
      existing.length ? updated++ : inserted++;
      if (photoFile) photos++;
      continue;
    }
    const imageUrl = photoFile ? await uploadPhoto(r.slug, photoFile) : null;
    if (imageUrl) photos++;
    const row = {
      title: r.title,
      summary: r.summary,
      category: r.category,
      difficulty: r.difficulty,
      cook_time: r.cookTime,
      servings: r.servings,
      ingredients: r.ingredients,
      instructions: r.instructions,
      tokens: r.tokens,
      nutrition: r.nutrition,
      tags: [],
      source_url: r.sourceUrl,
      source: "catalog",
      visibility: "public",
      provenance: PROVENANCE,
      image_url: imageUrl,
      image_ai: false,
      image_credit: imageUrl ? r.imageCredit : null,
    };
    if (existing.length) {
      await rest(`recipes?id=eq.${existing[0].id}`, { method: "PATCH", body: JSON.stringify(row) });
      updated++;
    } else {
      await rest("recipes", { method: "POST", body: JSON.stringify({ ...row, creator_id: null }) });
      inserted++;
    }
    console.log(`  ok  ${r.slug}${imageUrl ? " + photo" : ""}`);
  } catch (e) {
    problems.push(`${r.slug}: ${e.message}`);
  }
}

console.log(`\n${inserted} ${DRY ? "to insert" : "inserted"}, ${updated} ${DRY ? "to update" : "updated"}, ${photos} photos.`);
if (problems.length) {
  console.log(`${problems.length} problem(s):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exitCode = 1;
}

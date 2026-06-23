/**
 * Generate batched SQL to seed the bundled catalog into the recipes-db
 * `recipes` table as public catalog rows. Creds-free: it only reads the
 * bundled catalog and writes .sql files under scripts/.cache/seed/. A separate
 * step runs them against the Supabase Management API SQL endpoint.
 *
 * Output:
 *   seed-000.sql           one DELETE of existing catalog rows (idempotent)
 *   seed-001..NNN.sql      INSERT batches (200 rows each)
 *
 * Run: npx tsx scripts/gen-seed-sql.ts
 */
import { CATALOG } from "../src/data/catalog";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

interface RawRecord {
  i: string; t: string; c: number; d: string; m: number; s: number;
  g: string[]; n: string[]; u: string; k: string[]; z?: number[]; a?: string[];
}
interface RawCatalog {
  v: number; generatedAt: string; count: number; categories: string[]; r: RawRecord[];
}

const raw = CATALOG as unknown as RawCatalog;
const outDir = join("scripts", ".cache", "seed");
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Postgres standard_conforming_strings is on by default, so the only escape a
// single-quoted literal needs is doubling embedded single quotes.
const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const j = (v: unknown): string => `${q(JSON.stringify(v))}::jsonb`;
const diff = (d: string): string => (["easy", "medium", "hard"].includes(d) ? d : "medium");

function rowValues(x: RawRecord): string {
  const nutrition = x.z
    ? { calories: x.z[0] ?? 0, protein: x.z[1] ?? 0, fat: x.z[2] ?? 0, carbs: x.z[3] ?? 0 }
    : null;
  const cells = [
    q(x.t),                                   // title
    q(raw.categories[x.c] ?? "Dinner"),       // category
    q(diff(x.d)),                             // difficulty
    String(x.m | 0),                          // cook_time
    String(x.s | 0),                          // servings
    j(x.g),                                   // ingredients
    j(x.n),                                   // instructions
    j(x.k),                                   // tokens
    nutrition ? j(nutrition) : "null",        // nutrition
    j(x.a ?? []),                             // tags
    x.u ? q(x.u) : "null",                    // source_url
    "'catalog'",                              // source
    "'public'",                               // visibility
  ];
  return `(${cells.join(",")})`;
}

const COLS =
  "title,category,difficulty,cook_time,servings,ingredients,instructions,tokens,nutrition,tags,source_url,source,visibility";

writeFileSync(
  join(outDir, "seed-000.sql"),
  "delete from public.recipes where creator_id is null and source = 'catalog';\n",
);

const BATCH = 200;
let file = 1;
for (let i = 0; i < raw.r.length; i += BATCH) {
  const batch = raw.r.slice(i, i + BATCH);
  const sql = `insert into public.recipes (${COLS}) values\n${batch.map(rowValues).join(",\n")};\n`;
  writeFileSync(join(outDir, `seed-${String(file).padStart(3, "0")}.sql`), sql);
  file += 1;
}

console.log(`wrote ${file} SQL files (1 delete + ${file - 1} insert batches) for ${raw.r.length} rows to ${outDir}`);

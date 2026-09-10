/**
 * build-usda-catalog.ts: turn ingested USDA MyPlate recipes into catalog rows.
 *
 * Input is `usda.json` from the Python ingest (scripts/ingest-usda.py), which
 * pulls the recipes from the Internet Archive's capture of myplate.gov. Those
 * are US federal works — public domain under 17 USC 105 — so they carry no
 * licence conditions, no attribution requirement, and no terms of service.
 * The mirror at myplate.food has cleaner JSON but forbids replicating its
 * catalog into another database on the free tier, which is why the ingest goes
 * to the archived federal site instead. The content is free; their service is
 * not, and swapping one terms problem for another would be the whole point
 * missed.
 *
 * Emits the same shape as gen-seed-sql.ts, plus `provenance` so the two
 * corpora in the catalog stay tellable apart — see migration 126. It does NOT
 * delete anything: retiring the AllRecipes rows is a separate, deliberate act,
 * not a side effect of an import.
 *
 * Run:
 *   python3 scripts/ingest-usda.py           # writes usda.json (slow, cached)
 *   npx -y tsx scripts/build-usda-catalog.ts # writes scripts/.cache/usda-seed/
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseIngredient } from "../src/features/nutrition";
import { confidentCategory } from "./lib/classifyCategory";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

interface Ingested {
  slug: string;
  title: string;
  summary: string | null;
  servings: number;
  cookTime: number;
  ingredients: string[];
  instructions: string[];
  sourceUrl: string;
  nutrition: { calories: number; protein: number; fat: number; carbs: number };
}

const inPath = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : resolve(REPO, "scripts/.cache/usda/usda.json");
if (!existsSync(inPath)) {
  console.error(`[usda] missing ${inPath} — run the Python ingest first.`);
  process.exit(1);
}
const rows: Ingested[] = JSON.parse(readFileSync(inPath, "utf-8"));

/**
 * Difficulty, derived rather than invented.
 *
 * USDA pages carry no difficulty field, and the schema requires one. Rather
 * than default everything to "medium" (which says nothing and makes the filter
 * useless), it comes from the two things that actually correlate with effort:
 * how many ingredients you have to handle and how many steps you have to
 * follow. The thresholds are deliberately generous toward "easy", because this
 * corpus IS mostly weeknight cooking and over-claiming difficulty would be its
 * own small dishonesty.
 */
function difficulty(r: Ingested): "easy" | "medium" | "hard" {
  const work = r.ingredients.length + r.instructions.length;
  if (work <= 12) return "easy";
  if (work <= 22) return "medium";
  return "hard";
}

/**
 * The USDA writes every recipe's first step as a food-safety instruction.
 * It is genuinely good practice and it is kept — stripping it would be editing
 * a public-health body's recipe to look more like a lifestyle blog. Recorded
 * here only so the repetition across 1,100 recipes reads as deliberate.
 */

/** Canonical ingredient names, via the SAME parser the runtime matcher uses. */
function tokensFor(ingredients: string[]): string[] {
  const out = new Set<string>();
  for (const line of ingredients) {
    const p = parseIngredient(line);
    const n = p?.name?.trim().toLowerCase();
    if (n) out.add(n);
  }
  return [...out];
}

const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const j = (v: unknown): string => `${q(JSON.stringify(v))}::jsonb`;

const COLS =
  "title,category,difficulty,cook_time,servings,ingredients,instructions," +
  "tokens,nutrition,summary,tags,source_url,source,visibility,provenance";

function rowValues(r: Ingested): string {
  const cat = confidentCategory({ t: r.title, g: r.ingredients }) ?? "Dinner";
  const n = r.nutrition;
  const hasMacros = n.calories > 0 || n.protein > 0 || n.fat > 0 || n.carbs > 0;
  return `(${[
    q(r.title),
    q(cat),
    q(difficulty(r)),
    String(r.cookTime | 0), // 0 = unknown; the UI omits it rather than printing "0 min"
    String(Math.max(1, r.servings | 0)),
    j(r.ingredients),
    j(r.instructions),
    j(tokensFor(r.ingredients)),
    hasMacros ? j(n) : "null",
    r.summary ? q(r.summary) : "null",
    j([]),
    q(r.sourceUrl),
    "'catalog'",
    "'public'",
    "'usda-myplate'",
  ].join(",")})`;
}

const outDir = join(REPO, "scripts", ".cache", "usda-seed");
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Re-runnable: clear only THIS provenance, never the other corpus and never a
// user's own rows. `creator_id is null` is the catalog guard the existing seed
// uses; keeping it means a stray user row can't be caught by a reseed.
writeFileSync(
  join(outDir, "seed-000.sql"),
  "delete from public.recipes\n where creator_id is null\n   and source = 'catalog'\n   and provenance = 'usda-myplate';\n",
);

const BATCH = 200;
let files = 1;
for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH);
  const sql =
    `insert into public.recipes (${COLS}) values\n` +
    chunk.map(rowValues).join(",\n") +
    ";\n";
  writeFileSync(join(outDir, `seed-${String(files).padStart(3, "0")}.sql`), sql);
  files++;
}

// A quick read on what the classifier did, so a bad taxonomy is visible before
// anything is applied rather than after.
const spread = new Map<string, number>();
for (const r of rows) {
  const c = confidentCategory({ t: r.title, g: r.ingredients }) ?? "Dinner";
  spread.set(c, (spread.get(c) ?? 0) + 1);
}
console.log(`[usda] ${rows.length} recipes -> ${files - 1} insert batches in ${outDir}`);
console.log(`[usda] median tokens/recipe: ${
  [...rows.map((r) => tokensFor(r.ingredients).length)].sort((a, b) => a - b)[Math.floor(rows.length / 2)]
}`);
console.log("[usda] category spread:");
for (const [c, n] of [...spread].sort((a, b) => b[1] - a[1])) {
  console.log(`         ${c.padEnd(12)} ${n}`);
}
const noMacros = rows.filter((r) => !(r.nutrition.calories > 0)).length;
const noSummary = rows.filter((r) => !r.summary).length;
console.log(`[usda] missing calories: ${noMacros} | missing summary: ${noSummary}`);

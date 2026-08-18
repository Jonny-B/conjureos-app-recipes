/**
 * Week-plan persistence. Plans are a relational graph (recipes plus shopping
 * lines), so they're stored as JSON (not markdown like saved recipes), under
 * /home/Documents/Recipes/Plans/. A companion `-shopping.md` checkbox list is
 * written alongside so the user can open it in Files or any markdown app while
 * actually shopping.
 */

import { vfs } from "../bridge/vfs";
import * as api from "../bridge/recipesApi";
import type { WeekPlan } from "../types";

const PLANS_DIR = "/home/Documents/Recipes/Plans";
/** Marker so the one-time VFS→DB plan import runs at most once per device. */
const MIGRATED_PLANS_FLAG = `${PLANS_DIR}/.migrated-to-db`;

/** A short human title for a plan, from its chosen meals. */
export function planTitle(plan: WeekPlan): string {
  const t = plan.picks.map((p) => p.title).slice(0, 3).join(", ");
  return t || "Week plan";
}

/**
 * One-time lift of plans saved by older versions (VFS JSON under Plans/) into
 * the DB as personal plans, then a flag so it never repeats. Best-effort: any
 * failure leaves the flag unset to retry, and never blocks the DB list.
 */
export async function importVfsPlansOnce(): Promise<void> {
  try {
    if (await vfs.exists(MIGRATED_PLANS_FLAG)) return;
  } catch {
    return;
  }
  try {
    const plans = await listWeekPlans();
    let failed = 0;
    for (const plan of plans) {
      try {
        await api.savePlanRecord({ plan, title: planTitle(plan), familyId: null });
      } catch {
        failed++; // keep going; the flag below decides whether we retry
      }
    }
    // Only stamp the flag when everything landed. Swallowing per-plan failures
    // AND stamping regardless meant a backend outage marked the migration
    // "done" with nothing imported — permanently, since the flag never
    // reopens. That is exactly what happened while the manifest pointed at the
    // wrong project: every savePlanRecord threw, and legacy plans on disk were
    // orphaned. Leaving it unset costs one cheap re-list next launch.
    if (failed === 0) await vfs.write(MIGRATED_PLANS_FLAG, new Date().toISOString());
  } catch {
    /* leave flag unset → retry next launch */
  }
}

export async function saveWeekPlan(plan: WeekPlan): Promise<{ path: string }> {
  await ensureDir();
  const date = plan.createdAt.slice(0, 10);
  const slug = slugify(plan.picks.map((p) => p.title).join(" ") || "week plan");
  const base = `${date}-${slug}`.slice(0, 80);
  const jsonPath = `${PLANS_DIR}/${base}.json`;
  await vfs.write(jsonPath, JSON.stringify(plan, null, 2));
  await vfs.write(`${PLANS_DIR}/${base}-shopping.md`, toShoppingMarkdown(plan));
  return { path: jsonPath };
}

export async function listWeekPlans(): Promise<WeekPlan[]> {
  const exists = await vfs.exists(PLANS_DIR).catch(() => false);
  if (!exists) return [];
  const entries = await vfs.ls(PLANS_DIR).catch(() => []);
  const out: WeekPlan[] = [];
  for (const f of entries.filter((e) => e.endsWith(".json"))) {
    try {
      const text = await vfs.read(`${PLANS_DIR}/${f}`);
      const parsed = JSON.parse(text);
      if (isWeekPlan(parsed)) out.push(parsed);
    } catch {
      /* skip malformed */
    }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

function toShoppingMarkdown(plan: WeekPlan): string {
  const checked = new Set(plan.checked ?? []);
  const byAisle = new Map<string, typeof plan.shoppingList>();
  for (const item of plan.shoppingList) {
    const arr = byAisle.get(item.aisle) ?? [];
    arr.push(item);
    byAisle.set(item.aisle, arr);
  }
  const sections: string[] = [];
  for (const [aisle, items] of byAisle) {
    const lines = items.map((i) => {
      const amount = i.quantity ? ` (${i.quantity})` : "";
      const serves = i.recipes.length > 1 ? `, enough for ${i.recipes.length} recipes` : "";
      const box = checked.has(i.canonical) ? "x" : " ";
      return `- [${box}] ${i.name}${amount}${serves}`;
    });
    sections.push(`## ${aisle}\n\n${lines.join("\n")}`);
  }
  const meals = plan.picks.map((p) => `- ${p.title}`).join("\n");
  return [
    `---`,
    `createdAt: ${plan.createdAt}`,
    `meals: ${plan.picks.length}`,
    `source: conjureos-app-recipes`,
    `---`,
    ``,
    `# Shopping list`,
    ``,
    `## This week's meals`,
    ``,
    meals,
    ``,
    sections.join("\n\n"),
    ``,
  ].join("\n");
}

// ── helpers ────────────────────────────────────────────────────────────

function isWeekPlan(x: unknown): x is WeekPlan {
  return (
    !!x &&
    typeof x === "object" &&
    Array.isArray((x as WeekPlan).picks) &&
    Array.isArray((x as WeekPlan).shoppingList) &&
    typeof (x as WeekPlan).createdAt === "string"
  );
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) || "week-plan"
  );
}

async function ensureDir(): Promise<void> {
  try {
    await vfs.mkdir("/home/Documents/Recipes");
  } catch {
    /* exists */
  }
  try {
    await vfs.mkdir(PLANS_DIR);
  } catch {
    /* exists */
  }
}

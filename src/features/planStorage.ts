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
/**
 * Second-generation marker. The v1 flag could be stamped by a migration that
 * never actually enumerated anything: `listWeekPlans` used to swallow a
 * `vfs.ls` failure and return `[]`, which read as "nothing to import" and
 * stamped v1 permanently. Accounts in that state still have their plan JSONs
 * on disk, so a v1-without-v2 stamp earns exactly one dedupe-guarded re-check.
 */
const RECHECKED_PLANS_FLAG = `${PLANS_DIR}/.migrated-to-db-v2`;

/** A short human title for a plan, from its chosen meals. */
export function planTitle(plan: WeekPlan): string {
  const t = plan.picks.map((p) => p.title).slice(0, 3).join(", ");
  return t || "Week plan";
}

/**
 * One-time lift of plans saved by older versions (VFS JSON under Plans/) into
 * the DB as personal plans, then a flag so it never repeats. Best-effort: any
 * failure leaves the flag unset to retry, and never blocks the DB list.
 *
 * The flag is only ever stamped after an enumeration that GENUINELY succeeded.
 * "Couldn't read the folder" and "the folder is empty" used to be the same
 * value (`[]`), and the empty reading wins by default — so one unlucky `vfs.ls`
 * marked the migration done forever with nothing imported. See the
 * VfsPlanListing discriminated result below.
 */
export async function importVfsPlansOnce(): Promise<void> {
  let stampedV1: boolean;
  try {
    stampedV1 = await vfs.exists(MIGRATED_PLANS_FLAG);
    if (stampedV1 && (await vfs.exists(RECHECKED_PLANS_FLAG))) return;
  } catch {
    return; // can't read the markers → do nothing rather than risk a re-import
  }

  const listing = await listWeekPlans();
  if (!listing.ok) return; // couldn't enumerate → retry next launch, flag untouched
  // Nothing on disk and already stamped: no work, just close out the re-check.
  if (stampedV1 && listing.plans.length === 0) {
    await stamp(RECHECKED_PLANS_FLAG);
    return;
  }

  // The re-check pass runs against accounts that may already hold imported
  // copies, so dedupe on the plan's own `createdAt` — it's carried verbatim
  // into the stored row and is what identifies "this same week plan". If we
  // can't read the DB list we can't tell what's already there, so we bail
  // rather than risk duplicating someone's plans.
  let alreadyImported = new Set<string>();
  if (stampedV1) {
    try {
      alreadyImported = new Set(
        (await api.listPlans()).map((p) => p.data?.createdAt).filter((c): c is string => !!c),
      );
    } catch {
      return;
    }
  }

  let failed = 0;
  for (const plan of listing.plans) {
    if (alreadyImported.has(plan.createdAt)) continue;
    try {
      await api.savePlanRecord({ plan, title: planTitle(plan), familyId: null });
    } catch {
      failed++; // keep going; the stamp below decides whether we retry
    }
  }
  // Only stamp when everything landed AND every file on disk was readable.
  // Leaving it unset costs one cheap re-list next launch; stamping early costs
  // the user their plans, permanently.
  if (failed > 0 || listing.unreadable > 0) return;
  if (!stampedV1) await stamp(MIGRATED_PLANS_FLAG);
  await stamp(RECHECKED_PLANS_FLAG);
}

async function stamp(path: string): Promise<void> {
  try {
    await vfs.write(path, new Date().toISOString());
  } catch {
    /* couldn't write the marker → the import simply repeats next launch */
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

/**
 * The outcome of reading the legacy plans folder. `ok: false` means the folder
 * could not be enumerated at all — deliberately NOT the same value as "the
 * folder is empty", because the caller stamps a permanent flag on the strength
 * of that answer. `unreadable` counts files that exist but wouldn't open
 * (transport failures), which are un-imported plans, unlike malformed JSON.
 */
export type VfsPlanListing = { ok: false } | { ok: true; plans: WeekPlan[]; unreadable: number };

export async function listWeekPlans(): Promise<VfsPlanListing> {
  let exists: boolean;
  try {
    exists = await vfs.exists(PLANS_DIR);
  } catch {
    return { ok: false };
  }
  if (!exists) return { ok: true, plans: [], unreadable: 0 };
  let entries: string[];
  try {
    entries = await vfs.ls(PLANS_DIR);
  } catch {
    return { ok: false };
  }
  const out: WeekPlan[] = [];
  let unreadable = 0;
  for (const f of entries.filter((e) => e.endsWith(".json"))) {
    let text: string;
    try {
      text = await vfs.read(`${PLANS_DIR}/${f}`);
    } catch {
      unreadable++; // a real plan we failed to open — don't let the flag close
      continue;
    }
    try {
      const parsed = JSON.parse(text);
      if (isWeekPlan(parsed)) out.push(parsed);
    } catch {
      /* skip malformed — this one is genuinely unimportable, not a failure */
    }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { ok: true, plans: out, unreadable };
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

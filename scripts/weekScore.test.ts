/**
 * Tests for src/features/weekScore.ts — the strip that makes the planner's
 * two objectives visible on the Plan tab.
 *
 * Plain tsx, no framework, same shape as the other two script tests.
 *
 * The cases worth pinning are the ones where a wrong answer is WORSE than no
 * answer: counting the same pantry item once per recipe (which would inflate
 * the waste number into nonsense), and a plan saved before `category` existed
 * reading as "one cuisine" rather than "not recorded" — that one would tell a
 * perfectly varied week that it is monotonous.
 */
import { scoreWeek, scoreSummary } from "../src/features/weekScore";
import type { PlannedRecipe, Recipe, ShoppingListItem, WeekPlan } from "../src/types";

let failures = 0;
const ok = (cond: boolean, what: string): void => {
  if (cond) return;
  failures++;
  console.error(`  FAIL  ${what}`);
};

const recipe = (title: string): Recipe => ({
  title,
  difficulty: "easy",
  cookTime: 30,
  servings: 4,
  ingredients: [],
  instructions: [],
});

const pick = (
  title: string,
  category: string | undefined,
  pantryCovered: string[],
): PlannedRecipe => ({
  id: title.toLowerCase().replace(/\W+/g, "-"),
  title,
  recipe: recipe(title),
  ...(category ? { category } : {}),
  pantryCovered,
  marginalNew: [],
  haveCount: pantryCovered.length,
  totalCount: pantryCovered.length + 2,
});

const buy = (canonical: string): ShoppingListItem => ({
  name: canonical,
  canonical,
  recipes: [],
  aisle: "Other",
});

const plan = (picks: PlannedRecipe[], shoppingList: ShoppingListItem[] = []): WeekPlan => ({
  picks,
  shoppingList,
  constraints: { includeIngredients: [], cuisines: [], dietary: [], avoid: [], mealCount: picks.length },
  shortfall: 0,
  warnings: [],
  createdAt: "2026-09-15T09:00:00.000Z",
});

console.log("weekScore.ts");

// ── the waste number counts DISTINCT pantry items, not uses ───────────────
const sharing = plan([
  pick("Dal", "Indian", ["rice", "lentil", "onion"]),
  pick("Fried rice", "Chinese", ["rice", "onion", "egg"]),
  pick("Pilaf", "Turkish", ["rice", "onion"]),
]);
const s1 = scoreWeek(sharing);
ok(s1.pantryUsed === 4, `three recipes sharing rice+onion clear 4 things, not 8 (got ${s1.pantryUsed})`);
ok(s1.meals === 3, "meals is the number of picks");
ok(s1.cuisines === 3, "three distinct categories count as three");
ok(s1.repeats === 0, "no category repeats here");
ok(
  JSON.stringify(s1.cuisineNames) === JSON.stringify(["Indian", "Chinese", "Turkish"]),
  `cuisine names are title-cased in pick order (got ${s1.cuisineNames.join(", ")})`,
);

// ── repeats: the "same dinner again" tell ────────────────────────────────
const samey = plan([
  pick("Dal", "Indian", ["lentil"]),
  pick("Korma", "indian", ["rice"]),
  pick("Biryani", "INDIAN", ["rice"]),
]);
const s2 = scoreWeek(samey);
ok(s2.cuisines === 1, "category matching ignores case");
ok(s2.repeats === 2, `two of three picks repeat the cuisine (got ${s2.repeats})`);
ok(s2.pantryUsed === 2, "rice used twice is still one thing cleared");

// ── an older plan must say "not recorded", never "one cuisine" ───────────
const legacy = plan([
  pick("Dal", undefined, ["lentil"]),
  pick("Fried rice", undefined, ["rice"]),
]);
const s3 = scoreWeek(legacy);
ok(s3.varietyUnknown, "a plan with no categories at all reports varietyUnknown");
ok(s3.cuisines === 0, "...and does not invent a cuisine count");
ok(
  scoreSummary(s3).includes("predates variety tracking"),
  "...and the sentence says so rather than calling it monotonous",
);

// A plan where only SOME picks are categorised is not a legacy plan.
const mixed = plan([pick("Dal", "Indian", ["lentil"]), pick("Toast", undefined, ["bread"])]);
ok(!scoreWeek(mixed).varietyUnknown, "one categorised pick is enough to count variety");
ok(scoreWeek(mixed).cuisines === 1, "...and only the categorised picks are counted");

// ── empty and edge cases ─────────────────────────────────────────────────
const empty = scoreWeek(plan([]));
ok(empty.meals === 0 && empty.pantryUsed === 0 && empty.cuisines === 0, "an empty plan scores zeroes");
ok(!empty.varietyUnknown, "an empty plan is not 'variety unknown' — there is nothing to know");
ok(scoreSummary(empty) === "Nothing planned yet.", "...and says so plainly");

// Missing arrays must not throw: plans come off the wire and out of storage.
const ragged = { ...plan([]), picks: undefined, shoppingList: undefined } as unknown as WeekPlan;
const s4 = scoreWeek(ragged);
ok(s4.meals === 0 && s4.toBuy === 0, "a plan with missing arrays scores zeroes rather than throwing");

// ── the shopping count is just the list length ───────────────────────────
ok(scoreWeek(plan([pick("Dal", "Indian", [])], [buy("feta"), buy("filo")])).toBuy === 2, "toBuy is the list length");

// ── the sentence ─────────────────────────────────────────────────────────
ok(
  scoreSummary(scoreWeek(plan([pick("Dal", "Indian", ["lentil"])]))).startsWith("1 thing you already own gets"),
  "one item is singular, with the verb to match",
);
ok(
  scoreSummary(s1).includes("every night is a different kind of meal"),
  "zero repeats gets the stronger phrasing",
);
ok(scoreSummary(s2).includes("all one kind of meal"), "one cuisine is called out as the problem it is");
ok(
  scoreSummary(scoreWeek(plan([pick("Dal", "Indian", [])]))).startsWith("None of it comes out of your pantry"),
  "a week that uses nothing from the pantry says so",
);

if (failures) {
  console.error(`\n${failures} week-score test${failures === 1 ? "" : "s"} failed.`);
  process.exit(1);
}
console.log("All week-score tests passed.");

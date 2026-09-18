/**
 * Tests for src/features/shelfLife.ts — the waste-risk model behind the
 * Pantry screen's "use these up" block.
 *
 * Plain tsx, no framework, same shape as scripts/theme.test.ts (the repo has
 * no runner and one file did not justify adding vitest; two still don't).
 * Run with `npm test`, which runs both files.
 *
 * What is actually worth pinning here: the LONGEST-KEYWORD-WINS rule, because
 * that is the only thing keeping "ground beef" from being read as "beef" and
 * "coconut milk" from being put in the fridge with a week to live. Adding a
 * short keyword that shadows a long one is the way this table rots, and it
 * rots silently.
 */
import {
  atRisk,
  byWasteRisk,
  locationOf,
  remainingFor,
  remainingLabel,
  riskOf,
  shelfGuess,
  todayISO,
} from "../src/features/shelfLife";
import type { PantryItem } from "../src/types";

let failures = 0;
const ok = (cond: boolean, what: string): void => {
  if (cond) return;
  failures++;
  console.error(`  FAIL  ${what}`);
};

const DAY = 86_400_000;
/** A fixed "now" so nothing here depends on when it runs. */
const NOW = Date.parse("2026-09-18T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

const item = (over: Partial<PantryItem> & { name: string }): PantryItem => ({
  addedAt: ago(0),
  ...over,
});

console.log("shelfLife.ts");

// ── the collisions the longest-match rule exists for ───────────────────────
const collisions: Array<[string, number, string]> = [
  ["ground beef", 2, "fridge"],
  ["beef", 4, "fridge"],
  ["sweet potato", 21, "pantry"],
  ["potato", 30, "pantry"],
  ["coconut milk", 365, "pantry"],
  ["milk", 7, "fridge"],
  ["sour cream", 10, "fridge"],
  ["cream", 7, "fridge"],
  ["chicken stock", 7, "fridge"],
  ["chicken", 2, "fridge"],
  ["cheddar", 28, "fridge"],
  ["cheese", 21, "fridge"],
];
for (const [name, days, where] of collisions) {
  const g = shelfGuess(name);
  ok(g.days === days, `"${name}" keeps ${days} days (got ${g.days})`);
  ok(g.where === where, `"${name}" lives in the ${where} (got ${g.where})`);
  ok(g.matched, `"${name}" matches the table rather than the default`);
}

// A name nobody thought of still gets an answer, flagged as weak.
const unknown = shelfGuess("dragonfruit compote");
ok(!unknown.matched, "an unlisted item reports matched: false");
ok(unknown.days === 14, "an unlisted item gets the 14-day default");

// Real produce names carry adjectives and plurals; the match has to survive
// both, because it anchors to a word START and not to a whole word.
ok(shelfGuess("organic baby spinach").days === 5, "adjectives don't defeat the match");
ok(shelfGuess("FREE RANGE EGGS").days === 28, "matching is case-insensitive");
ok(shelfGuess("strawberries").days === 4, "a plural still matches its stem");
ok(shelfGuess("sun-dried tomatoes").days === 8, "a hyphen is a word boundary");

// The reason keywords anchor to a word boundary at all: "boiled" CONTAINS
// "oil" (b-OIL-ed), and an unanchored 3-letter keyword would hand boiled eggs
// a year in the cupboard.
ok(shelfGuess("boiled eggs").days === 28, "'boiled' does not match the keyword 'oil'");
ok(shelfGuess("boiled eggs").where === "fridge", "...and it lands in the fridge, not the pantry");
ok(shelfGuess("olive oil").days === 365, "a real oil still matches");

// Two "pepper"s that are nothing alike, separated by the longest-match rule.
ok(shelfGuess("red bell pepper").days === 10, "a bell pepper is a vegetable");
ok(shelfGuess("black pepper").days === 730, "black pepper is a spice");
ok(shelfGuess("black pepper").where === "pantry", "...and lives in the cupboard");

// ── a printed date beats the estimate, and is never blended with it ────────
const printed = item({ name: "chicken", addedAt: ago(0), expiresAt: "2026-09-30" });
const r1 = remainingFor(printed, NOW)!;
ok(r1.basis === "expiry", "a printed date is used as the basis");
ok(r1.days === 12, `a printed date 12 days out reads as 12 (got ${r1.days})`);
ok(riskOf(printed, NOW) === "fine", "chicken with a real date a fortnight out is fine");
// ...and the same item WITHOUT the date is urgent on the estimate alone.
ok(riskOf(item({ name: "chicken" }), NOW) === "urgent", "chicken with no date is urgent on day 0");

// An unparseable date falls back to the estimate rather than throwing.
const bad = item({ name: "spinach", expiresAt: "not-a-date" });
ok(remainingFor(bad, NOW)?.basis === "estimate", "a corrupt expiry falls back to the estimate");

// ── the freezer stops the clock, whatever the food is ─────────────────────
const frozenPeas = item({ name: "chicken", location: "freezer", addedAt: ago(30) });
ok(remainingFor(frozenPeas, NOW)!.days === 150, "an explicit freezer location overrides the fresh row");
ok(riskOf(frozenPeas, NOW) === "fine", "frozen chicken a month old is not urgent");
ok(locationOf(item({ name: "rice" })) === "pantry", "location falls back to the table's guess");
ok(locationOf(item({ name: "rice", location: "freezer" })) === "freezer", "an explicit location wins");

// ── risk bands ────────────────────────────────────────────────────────────
ok(riskOf(item({ name: "spinach", addedAt: ago(9) }), NOW) === "expired", "9-day-old spinach is expired");
ok(riskOf(item({ name: "spinach", addedAt: ago(4) }), NOW) === "urgent", "4-day-old spinach is urgent");
ok(riskOf(item({ name: "spinach", addedAt: ago(0) }), NOW) === "soon", "fresh spinach is already 'soon'");
ok(riskOf(item({ name: "rice", addedAt: ago(0) }), NOW) === "fine", "fresh rice is fine");
ok(atRisk(item({ name: "spinach", addedAt: ago(4) }), NOW), "atRisk is true for the three risky bands");
ok(!atRisk(item({ name: "rice" }), NOW), "atRisk is false for fine");

// An item with no usable clock is "no opinion", which must not read as urgent.
const clockless = item({ name: "spinach", addedAt: "whenever" });
ok(remainingFor(clockless, NOW) === null, "an unparseable addedAt yields no opinion");
ok(riskOf(clockless, NOW) === "fine", "no opinion is not a warning");

// ── ordering ──────────────────────────────────────────────────────────────
const shelf = [
  item({ name: "rice", addedAt: ago(200) }),
  item({ name: "spinach", addedAt: ago(3) }),
  item({ name: "cheddar", addedAt: ago(1) }),
  item({ name: "chicken", addedAt: ago(1) }),
];
// chicken 2-1=1, spinach 5-3=2, cheddar 28-1=27, rice 365-200=165.
const ordered = byWasteRisk(shelf, NOW).map((i) => i.name);
ok(
  JSON.stringify(ordered) === JSON.stringify(["chicken", "spinach", "cheddar", "rice"]),
  `soonest-gone first (got ${ordered.join(", ")})`,
);

// An item with no opinion sorts LAST — not knowing is not evidence of urgency.
const withUnknown = byWasteRisk([clockless, item({ name: "rice" })], NOW).map((i) => i.name);
ok(withUnknown[1] === "spinach", "an item we know nothing about sorts last");

// A real date outranks an estimate landing on the same day.
const tie = byWasteRisk(
  [item({ name: "spinach", addedAt: ago(4) }), item({ name: "rice", expiresAt: "2026-09-19" })],
  NOW,
);
ok(tie[0]!.name === "rice", "on a tie, a printed date outranks an estimate");

// ── labels ────────────────────────────────────────────────────────────────
ok(remainingLabel({ days: 0, basis: "estimate", weak: false }) === "today", "0 days reads as 'today'");
ok(remainingLabel({ days: 1, basis: "estimate", weak: false }) === "1 day left", "1 day is singular");
ok(remainingLabel({ days: 3, basis: "estimate", weak: false }) === "3 days left", "3 days is plural");
ok(remainingLabel({ days: -1, basis: "expiry", weak: false }) === "1 day past", "past tense, singular");
ok(remainingLabel({ days: -4, basis: "expiry", weak: false }) === "4 days past", "past tense, plural");
ok(todayISO(NOW) === "2026-09-18", "todayISO is a bare YYYY-MM-DD");

if (failures) {
  console.error(`\n${failures} shelf-life test${failures === 1 ? "" : "s"} failed.`);
  process.exit(1);
}
console.log("All shelf-life tests passed.");

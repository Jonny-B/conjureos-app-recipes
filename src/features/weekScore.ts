/**
 * The week score: the planner's two objectives, made visible.
 *
 * The planner is trying to do two things at once — finish what is already in
 * the pantry, and not cook the same dinner five nights running. Those pull
 * against each other (the highest-coverage recipes are exactly the ones that
 * share ingredients), so the trade-off it struck has to be legible or a bad
 * week is just mysterious.
 *
 * Both numbers are computed from the STORED plan, not recomputed from a
 * catalog the device no longer holds, so they say what the planner actually
 * did rather than what it would do now.
 */
import type { WeekPlan } from "../types";

export interface WeekScore {
  meals: number;
  /** Distinct pantry ingredients this week consumes. The waste-reduction number. */
  pantryUsed: number;
  /** Distinct cuisines across the picks. The variety number. */
  cuisines: number;
  /** Those cuisines, prettied, for the line under the tiles. */
  cuisineNames: string[];
  /**
   * Picks whose cuisine had already appeared earlier in the week — the "this
   * is the same dinner again" tell. 0 means every night is a different kind of
   * meal.
   */
  repeats: number;
  /** Lines on the shopping list. */
  toBuy: number;
  /**
   * True when NO pick carries a category. Plans saved before `category` was
   * kept on a pick look exactly like a week with no variety at all, and the
   * strip must say "not recorded" rather than "1 cuisine".
   */
  varietyUnknown: boolean;
}

export function scoreWeek(plan: WeekPlan): WeekScore {
  const picks = plan.picks ?? [];

  // Distinct, because the point is how much of the pantry gets USED, not how
  // many times the rice shows up. Three recipes that each use the same four
  // things have cleared four things, not twelve.
  const used = new Set<string>();
  for (const p of picks) for (const c of p.pantryCovered ?? []) used.add(c);

  const seen = new Set<string>();
  let repeats = 0;
  let categorised = 0;
  for (const p of picks) {
    const c = (p.category ?? "").trim().toLowerCase();
    if (!c) continue;
    categorised++;
    if (seen.has(c)) repeats++;
    else seen.add(c);
  }

  return {
    meals: picks.length,
    pantryUsed: used.size,
    cuisines: seen.size,
    cuisineNames: [...seen].map(titleCase),
    repeats,
    toBuy: (plan.shoppingList ?? []).length,
    varietyUnknown: picks.length > 0 && categorised === 0,
  };
}

/**
 * One plain sentence about how the week came out. Deliberately not a grade:
 * the user is the judge of their own week, and a letter score on dinner would
 * be insufferable. It reports, it doesn't mark.
 */
export function scoreSummary(s: WeekScore): string {
  if (s.meals === 0) return "Nothing planned yet.";
  const used =
    s.pantryUsed === 0
      ? "None of it comes out of your pantry"
      : `${s.pantryUsed} thing${s.pantryUsed === 1 ? "" : "s"} you already own get${s.pantryUsed === 1 ? "s" : ""} used up`;
  if (s.varietyUnknown) return `${used}. This plan predates variety tracking.`;
  if (s.cuisines <= 1) {
    return `${used}, but it's all one kind of meal — nudge it below for more variety.`;
  }
  const variety =
    s.repeats === 0
      ? `every night is a different kind of meal`
      : `${s.cuisines} different kinds of meal`;
  return `${used}, and ${variety}.`;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

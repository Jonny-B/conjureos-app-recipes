import type { Recipe } from "../types";
import { macroShares, type Hue } from "../features/recipeLook";
import { DifficultyMark } from "./RecipePlate";

/** Protein / carbs / fat each get a hue of their own, used for the bar and its key. */
const MACRO_HUE: Record<"protein" | "carbs" | "fat", Hue> = {
  protein: "info",
  carbs: "third",
  fat: "support",
};

/**
 * The numbers row under a recipe's title: a hairline grid of cells, each a
 * big figure over a small label, and under it one bar splitting the serving's
 * calories into protein / carbs / fat.
 *
 * The figures used to be one grey sentence — "~154 cal · 17g P · 7g F · 6g C
 * · per serving · est." — which is all the data and none of the shape. The
 * bar is what shows a salad and a cake apart at a glance.
 *
 * `compact` (Tonight's pick) keeps the nutrition (and time, when a recipe
 * has one) and drops servings/level, which the recipe page shows and a
 * teaser doesn't need.
 */
export function RecipeStats({
  recipe,
  servings,
  compact = false,
}: {
  recipe: Recipe;
  /** Shown servings, when the caller scales; defaults to the recipe's own. */
  servings?: number;
  compact?: boolean;
}) {
  const n = recipe.nutrition;
  const macros = macroShares(n);
  const serves = servings ?? recipe.servings;
  const hasCalories = !!n && n.calories > 0;
  if (compact && !hasCalories && !macros) return null;

  return (
    <div className={`stats${compact ? " stats--compact" : ""}`}>
      <dl className="stats-cells">
        {hasCalories && (
          <div className="stat">
            <dt>Calories</dt>
            <dd>~{n!.calories}</dd>
          </div>
        )}
        {macros?.map((m) => (
          <div className="stat" key={m.key}>
            <dt>
              <span className={`swatch hue-${MACRO_HUE[m.key]}`} />
              {m.label}
            </dt>
            <dd>
              {m.grams}
              <small>g</small>
            </dd>
          </div>
        ))}
        {!compact && serves > 0 && (
          <div className="stat">
            <dt>Serves</dt>
            <dd>{serves}</dd>
          </div>
        )}
        {recipe.cookTime > 0 && (
          <div className="stat">
            <dt>Time</dt>
            <dd>
              {recipe.cookTime}
              <small>min</small>
            </dd>
          </div>
        )}
        {!compact && (
          <div className="stat">
            <dt>Level</dt>
            <dd className="stat-level">
              <DifficultyMark recipe={recipe} decorative />
              <span>{recipe.difficulty}</span>
            </dd>
          </div>
        )}
      </dl>
      {macros && (
        <div
          className="macro-bar"
          role="img"
          aria-label={
            "Calories from " + macros.map((m) => `${m.label.toLowerCase()} ${Math.round(m.share * 100)}%`).join(", ")
          }
        >
          {macros.map((m) =>
            m.share > 0 ? (
              <span key={m.key} className={`hue-${MACRO_HUE[m.key]}`} style={{ flexGrow: m.share }} />
            ) : null,
          )}
        </div>
      )}
      {(hasCalories || macros) && <div className="stats-note">Per serving · estimated</div>}
    </div>
  );
}

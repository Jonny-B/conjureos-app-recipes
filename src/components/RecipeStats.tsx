import type { Recipe } from "../types";
import { macroShares, type Hue } from "../features/recipeLook";

/** Protein / carbs / fat each get a hue of their own, used for the bar and its key. */
const MACRO_HUE: Record<"protein" | "carbs" | "fat", Hue> = {
  protein: "info",
  carbs: "third",
  fat: "support",
};

/**
 * Tonight's pick's numbers: a hairline grid of cells, each a big figure over
 * a small label, and under it one bar splitting the serving's calories into
 * protein / carbs / fat — the bar is what shows a salad and a cake apart at a
 * glance. (The open recipe prints the same facts as one line, per the owner's
 * mockup; see RecipeDetail.)
 */
export function RecipeStats({ recipe }: { recipe: Recipe }) {
  const n = recipe.nutrition;
  const macros = macroShares(n);
  const hasCalories = !!n && n.calories > 0;
  if (!hasCalories && !macros && !(recipe.cookTime > 0)) return null;

  return (
    <div className="stats">
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
        {recipe.cookTime > 0 && (
          <div className="stat">
            <dt>Time</dt>
            <dd>
              {recipe.cookTime}
              <small>min</small>
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

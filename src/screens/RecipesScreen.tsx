import { useState } from "react";
import type { Ingredient, Recipe } from "../types";
import { saveRecipe } from "../features/storage";

interface Props {
  recipes: Recipe[];
  ingredients: Ingredient[];
  onRestart: () => void;
}

export function RecipesScreen({ recipes, ingredients, onRestart }: Props) {
  const [savedIdx, setSavedIdx] = useState<Set<number>>(new Set());
  const [savingIdx, setSavingIdx] = useState<number | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const onSave = async (recipe: Recipe, idx: number) => {
    setSavingIdx(idx);
    setSaveErr(null);
    try {
      await saveRecipe(recipe);
      setSavedIdx((prev) => new Set(prev).add(idx));
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingIdx(null);
    }
  };

  return (
    <div className="recipes-screen">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0 }}>Three options</h2>
          <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
            From {ingredients.length} confirmed ingredient{ingredients.length === 1 ? "" : "s"}. Save the ones that look good.
          </div>
        </div>
        <button className="btn ghost" onClick={onRestart}>
          ↺ Try different ingredients
        </button>
      </div>

      {saveErr && (
        <div className="status-banner error">
          <span>⚠</span>
          <span>{saveErr}</span>
        </div>
      )}

      <div className="recipes-grid">
        {recipes.map((r, i) => (
          <article key={i} className="recipe-card">
            <div className="row">
              <h3>{r.title}</h3>
            </div>
            <div>
              <span className={`pill ${r.difficulty}`}>{r.difficulty}</span>
              <span className="pill">{r.cookTime} min</span>
            </div>
            {r.summary && <p className="summary">{r.summary}</p>}

            <section>
              <h4>Ingredients</h4>
              <ul>
                {r.ingredients.map((ing, j) => (
                  <li key={j}>{ing}</li>
                ))}
              </ul>
            </section>

            <section>
              <h4>Instructions</h4>
              <ol>
                {r.instructions.map((step, j) => (
                  <li key={j}>{step}</li>
                ))}
              </ol>
            </section>

            <div className="row" style={{ marginTop: "auto" }}>
              {savedIdx.has(i) ? (
                <span className="muted" style={{ fontSize: 13 }}>✓ Saved to Recipes</span>
              ) : (
                <span />
              )}
              <button
                className="btn"
                disabled={savedIdx.has(i) || savingIdx !== null}
                onClick={() => onSave(r, i)}
              >
                {savingIdx === i ? "Saving…" : savedIdx.has(i) ? "Saved" : "Save"}
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

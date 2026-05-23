import { useEffect, useState } from "react";
import type { Ingredient, NutritionStrip, Recipe } from "../types";
import { saveRecipe } from "../features/storage";
import { computeNutrition, formatStrip } from "../features/nutrition";

interface Props {
  recipes: Recipe[];
  ingredients: Ingredient[];
  onRestart: () => void;
}

export function RecipesScreen({ recipes, ingredients, onRestart }: Props) {
  const [savedIdx, setSavedIdx] = useState<Set<number>>(new Set());
  const [savingIdx, setSavingIdx] = useState<number | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  // Per-card nutrition lookup state. Strip nullable so failed lookups stop
  // re-firing on re-render and the UI can show a "—" placeholder.
  const [nutrition, setNutrition] = useState<Array<NutritionStrip | null | "pending">>(
    () => recipes.map(() => "pending"),
  );

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    (async () => {
      // Sequential per recipe so we don't fan out 3 × N USDA calls all at once.
      // Within a recipe, nutrition.ts uses bounded concurrency on ingredients.
      for (let i = 0; i < recipes.length; i++) {
        if (cancelled) return;
        try {
          const strip = await computeNutrition(recipes[i]!, ctrl.signal);
          if (cancelled) return;
          setNutrition((prev) => prev.map((s, j) => (j === i ? strip : s)));
        } catch {
          if (cancelled) return;
          setNutrition((prev) => prev.map((s, j) => (j === i ? null : s)));
        }
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [recipes]);

  const onSave = async (recipe: Recipe, idx: number) => {
    setSavingIdx(idx);
    setSaveErr(null);
    try {
      // Inject the freshest nutrition data into the saved object so the strip
      // travels with the markdown frontmatter and shows up immediately in Browse.
      const strip = nutrition[idx];
      const recipeWithNutrition: Recipe = {
        ...recipe,
        nutrition: strip && strip !== "pending" ? strip : null,
      };
      await saveRecipe(recipeWithNutrition);
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
              <span className="pill">{r.servings} servings</span>
            </div>
            {r.summary && <p className="summary">{r.summary}</p>}
            <NutritionLine state={nutrition[i] ?? null} />

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

function NutritionLine({ state }: { state: NutritionStrip | null | "pending" }) {
  if (state === "pending") {
    return (
      <div className="muted" style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
        <div className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
        Calculating nutrition…
      </div>
    );
  }
  if (!state) {
    return (
      <div className="faint" style={{ fontSize: 12 }}>
        Nutrition unavailable
      </div>
    );
  }
  return (
    <div className="muted" style={{ fontSize: 12, lineHeight: 1.4 }}>
      {formatStrip(state)}
    </div>
  );
}

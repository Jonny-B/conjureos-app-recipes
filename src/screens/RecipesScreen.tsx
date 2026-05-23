import { useEffect, useState } from "react";
import type { Ingredient, NutritionStrip, Recipe } from "../types";
import { saveRecipe } from "../features/storage";
import { computeNutrition, formatStrip, USING_DEMO_KEY } from "../features/nutrition";

interface Props {
  recipes: Recipe[];
  ingredients: Ingredient[];
  onRestart: () => void;
}

/** Per-card nutrition lookup state. Three terminal shapes plus the in-flight
 *  marker — separated from the persisted NutritionStrip type so the UI can
 *  distinguish "USDA cap hit" from "ingredient genuinely not in the DB". */
type CardNutrition =
  | { kind: "pending" }
  | { kind: "ok"; strip: NutritionStrip }
  | { kind: "partial"; strip: NutritionStrip; missedDueToRateLimit: number }
  | { kind: "rate-limited"; missedDueToRateLimit: number }
  | { kind: "empty" };

export function RecipesScreen({ recipes, ingredients, onRestart }: Props) {
  const [savedIdx, setSavedIdx] = useState<Set<number>>(new Set());
  const [savingIdx, setSavingIdx] = useState<number | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [nutrition, setNutrition] = useState<CardNutrition[]>(
    () => recipes.map(() => ({ kind: "pending" as const })),
  );
  // Once any per-recipe lookup hits a 429, surface the explanation banner
  // at the screen level. Dismissible per session — clears on the next
  // generation when nutrition state resets.
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const anyRateLimited = nutrition.some(
    (n) => n.kind === "rate-limited" || n.kind === "partial",
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
          const result = await computeNutrition(recipes[i]!, ctrl.signal);
          if (cancelled) return;
          const card: CardNutrition =
            result.strip && result.rateLimited
              ? { kind: "partial", strip: result.strip, missedDueToRateLimit: result.missedDueToRateLimit }
              : result.strip
              ? { kind: "ok", strip: result.strip }
              : result.rateLimited
              ? { kind: "rate-limited", missedDueToRateLimit: result.missedDueToRateLimit }
              : { kind: "empty" };
          setNutrition((prev) => prev.map((s, j) => (j === i ? card : s)));
        } catch {
          if (cancelled) return;
          setNutrition((prev) => prev.map((s, j) => (j === i ? { kind: "empty" as const } : s)));
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
      const cardState = nutrition[idx];
      const strip =
        cardState && (cardState.kind === "ok" || cardState.kind === "partial")
          ? cardState.strip
          : null;
      const recipeWithNutrition: Recipe = { ...recipe, nutrition: strip };
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

      {anyRateLimited && !bannerDismissed && (
        <RateLimitBanner onDismiss={() => setBannerDismissed(true)} />
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
            <NutritionLine state={nutrition[i] ?? { kind: "empty" }} />

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

function NutritionLine({ state }: { state: CardNutrition }) {
  switch (state.kind) {
    case "pending":
      return (
        <div className="muted" style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
          <div className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
          Calculating nutrition…
        </div>
      );
    case "ok":
      return (
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.4 }}>
          {formatStrip(state.strip)}
        </div>
      );
    case "partial":
      return (
        <div style={{ fontSize: 12, lineHeight: 1.4 }}>
          <div className="muted">{formatStrip(state.strip)}</div>
          <div className="faint" style={{ marginTop: 2 }}>
            {state.missedDueToRateLimit} ingredient{state.missedDueToRateLimit === 1 ? "" : "s"} skipped (USDA rate limit) — see banner above
          </div>
        </div>
      );
    case "rate-limited":
      return (
        <div className="faint" style={{ fontSize: 12, lineHeight: 1.4 }}>
          Nutrition unavailable — USDA rate limit hit. See banner above.
        </div>
      );
    case "empty":
      return (
        <div className="faint" style={{ fontSize: 12 }}>
          Nutrition unavailable — ingredients didn't match USDA's database.
        </div>
      );
  }
}

function RateLimitBanner({ onDismiss }: { onDismiss: () => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="status-banner" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span>ℹ</span>
        <strong style={{ flex: 1 }}>
          USDA's nutrition API rate-limited this lookup
        </strong>
        <button className="btn ghost" onClick={() => setExpanded((v) => !v)} style={{ padding: "4px 10px", fontSize: 12 }}>
          {expanded ? "Less" : "Why?"}
        </button>
        <button className="btn ghost" onClick={onDismiss} style={{ padding: "4px 10px", fontSize: 12 }}>
          Dismiss
        </button>
      </div>
      {expanded && (
        <div className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
          <p style={{ margin: "0 0 8px 0" }}>
            <strong>Who:</strong> the U.S. Department of Agriculture, which runs the free FoodData Central database we use for per-serving macros.{" "}
            <em>Not ConjureOS, not the recipe app, not Claude.</em>
          </p>
          {USING_DEMO_KEY ? (
            <>
              <p style={{ margin: "0 0 8px 0" }}>
                <strong>Why:</strong> this app ships with USDA's public <code>DEMO_KEY</code> so it works out of the box without setup. USDA limits <code>DEMO_KEY</code> to 30 lookups per hour per public IP address — shared across everyone on your network (and anyone else worldwide hitting it from the same IP, e.g. mobile carriers).
              </p>
              <p style={{ margin: "0 0 8px 0" }}>
                <strong>What to do:</strong>
              </p>
              <ul style={{ margin: "0 0 8px 18px", padding: 0 }}>
                <li>Wait an hour — the cap resets and recipes already on screen will keep working from cache.</li>
                <li>
                  Grab a free personal key (~30 seconds at{" "}
                  <a href="https://api.data.gov/signup/" target="_blank" rel="noreferrer">api.data.gov/signup</a>), set{" "}
                  <code>VITE_USDA_API_KEY</code> in the source repo, rebuild — gets you 1000 lookups per hour to yourself.
                </li>
              </ul>
            </>
          ) : (
            <>
              <p style={{ margin: "0 0 8px 0" }}>
                <strong>Why:</strong> you're already using a personal USDA key, which is normally 1000 lookups/hr. Hitting that means an unusually heavy session — most ingredients are cached after first lookup, so this is rare.
              </p>
              <p style={{ margin: "0 0 8px 0" }}>
                <strong>What to do:</strong> wait an hour; the limit resets automatically. Cached ingredients keep working in the meantime.
              </p>
            </>
          )}
          <p style={{ margin: 0 }}>
            <strong>What about my recipes?</strong> Recipes still generate fine — the nutrition strip is supplementary. You can still save and cook every recipe; the macros just won't be filled in for the skipped ones.
          </p>
        </div>
      )}
    </div>
  );
}

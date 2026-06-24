import { useEffect, useMemo, useState } from "react";
import type { Ingredient, NutritionStrip, Recipe } from "../types";
import { saveRecipe } from "../features/storage";
import { computeNutrition, formatStrip, isUsingDemoKey } from "../features/nutrition";
import { computeAvailability, scaleRecipe, type AvailabilityResult } from "../features/scaling";
import { Icon } from "../icons";

interface Props {
  recipes: Recipe[];
  ingredients: Ingredient[];
  onEditIngredients: () => void;
  onRestart: () => void;
  /** When set, each card offers "Cook this" → guided cook (with the scaled recipe). */
  onCook?: (recipe: Recipe) => void;
}

/** Per-card nutrition state. See nutrition.ts for the kind union semantics. */
type CardNutrition =
  | { kind: "pending" }
  | { kind: "ok"; strip: NutritionStrip }
  | { kind: "partial"; strip: NutritionStrip; missedDueToRateLimit: number }
  | { kind: "rate-limited"; missedDueToRateLimit: number }
  | { kind: "empty" };

export function RecipesScreen({ recipes, ingredients, onEditIngredients, onRestart, onCook }: Props) {
  const [savedIdx, setSavedIdx] = useState<Set<number>>(new Set());
  const [savingIdx, setSavingIdx] = useState<number | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [nutrition, setNutrition] = useState<CardNutrition[]>(
    () => recipes.map(() => ({ kind: "pending" as const })),
  );
  // Per-card scaling factor. Default 1; the stepper and the "scale to my
  // ingredients" button drive it.
  const [scaleFactors, setScaleFactors] = useState<number[]>(() => recipes.map(() => 1));
  const [bannerDismissed, setBannerDismissed] = useState(false);

  // Pre-compute availability per recipe based on what the user has — the
  // "Scale to my ingredients" button uses it, the warning rendered next to
  // a recipe's constraining ingredient uses it too. Memoized so the
  // expensive parse doesn't re-fire on every keystroke.
  const availability = useMemo<AvailabilityResult[]>(
    () => recipes.map((r) => computeAvailability(r, ingredients)),
    [recipes, ingredients],
  );

  const anyRateLimited = nutrition.some(
    (n) => n.kind === "rate-limited" || n.kind === "partial",
  );

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    (async () => {
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

  const onSave = async (idx: number) => {
    setSavingIdx(idx);
    setSaveErr(null);
    try {
      const cardState = nutrition[idx];
      const strip =
        cardState && (cardState.kind === "ok" || cardState.kind === "partial")
          ? cardState.strip
          : null;
      // Save the SCALED version — what the user actually intends to cook.
      // Scale from the ORIGINAL recipe exactly once; the card already
      // renders a scaled copy but persistence must derive from the source
      // so the factor isn't applied twice.
      const scaled = scaleRecipe(recipes[idx]!, scaleFactors[idx] ?? 1);
      const recipeWithNutrition: Recipe = { ...scaled, nutrition: strip };
      await saveRecipe(recipeWithNutrition);
      setSavedIdx((prev) => new Set(prev).add(idx));
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingIdx(null);
    }
  };

  const adjustServings = (idx: number, delta: number) => {
    const recipe = recipes[idx]!;
    const current = Math.max(1, Math.round(recipe.servings * (scaleFactors[idx] ?? 1)));
    const next = Math.max(1, Math.min(24, current + delta));
    const factor = next / recipe.servings;
    setScaleFactors((prev) => prev.map((f, i) => (i === idx ? factor : f)));
  };

  const scaleToAvailable = (idx: number) => {
    const a = availability[idx];
    if (!a) return;
    setScaleFactors((prev) => prev.map((f, i) => (i === idx ? a.factor : f)));
  };

  const resetScale = (idx: number) => {
    setScaleFactors((prev) => prev.map((f, i) => (i === idx ? 1 : f)));
  };

  return (
    <div className="recipes-screen">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0 }}>Three options</h2>
          <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
            From {ingredients.length} confirmed ingredient{ingredients.length === 1 ? "" : "s"}. Adjust servings or scale to what you have.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn secondary" onClick={onEditIngredients}>
            Edit ingredients
          </button>
          <button className="btn ghost" onClick={onRestart}>
            Start over
          </button>
        </div>
      </div>

      {saveErr && (
        <div className="status-banner error">
          <Icon name="wand" />
          <span>{saveErr}</span>
        </div>
      )}

      {anyRateLimited && !bannerDismissed && (
        <RateLimitBanner onDismiss={() => setBannerDismissed(true)} />
      )}

      <div className="recipes-grid">
        {recipes.map((r, i) => {
          const factor = scaleFactors[i] ?? 1;
          const scaled = scaleRecipe(r, factor);
          const avail = availability[i]!;
          return (
            <RecipeCard
              key={i}
              original={r}
              scaled={scaled}
              factor={factor}
              availability={avail}
              nutritionState={nutrition[i] ?? { kind: "empty" }}
              saved={savedIdx.has(i)}
              saving={savingIdx === i}
              anySaving={savingIdx !== null}
              onServingsChange={(delta) => adjustServings(i, delta)}
              onScaleToAvailable={() => scaleToAvailable(i)}
              onResetScale={() => resetScale(i)}
              onSave={() => onSave(i)}
              onCook={onCook ? () => onCook(scaled) : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── Recipe card ───────────────────────────────────────────────────────

interface RecipeCardProps {
  original: Recipe;
  scaled: Recipe;
  factor: number;
  availability: AvailabilityResult;
  nutritionState: CardNutrition;
  saved: boolean;
  saving: boolean;
  anySaving: boolean;
  onServingsChange: (delta: number) => void;
  onScaleToAvailable: () => void;
  onResetScale: () => void;
  onSave: () => void;
  onCook?: () => void;
}

function RecipeCard({
  original,
  scaled,
  factor,
  availability,
  nutritionState,
  saved,
  saving,
  anySaving,
  onServingsChange,
  onScaleToAvailable,
  onResetScale,
  onSave,
  onCook,
}: RecipeCardProps) {
  // Constraining ingredient and a precomputed shortage map so we can show
  // a "not enough X" annotation next to the offending recipe line.
  const lineShortages = useMemo(() => {
    const m = new Map<string, { ratio: number; constraining: boolean; available: number; needed: number; userIngredient: string }>();
    for (const match of availability.matches) {
      if (match.ratio < 0.999) {
        m.set(match.recipeLine, {
          ratio: match.ratio,
          constraining: match.constraining,
          available: match.available,
          needed: match.needed,
          userIngredient: match.userIngredient,
        });
      }
    }
    return m;
  }, [availability]);

  const scaleNeeded = availability.factor < 0.999;
  const isScaled = factor !== 1;

  return (
    <article className="recipe-card">
      <div className="row">
        <h3>{original.title}</h3>
      </div>
      <div>
        <span className={`pill ${original.difficulty}`}>{original.difficulty}</span>
        <span className="pill">{original.cookTime} min</span>
      </div>
      {original.summary && <p className="summary">{original.summary}</p>}

      {/* Servings stepper + scale-to-mine controls */}
      <div className="scale-row">
        <div className="serving-stepper">
          <button
            className="icon-btn"
            onClick={() => onServingsChange(-1)}
            disabled={scaled.servings <= 1}
            title="Fewer servings"
            aria-label="Decrease servings"
          >
            −
          </button>
          <span className="serving-count">{scaled.servings} serving{scaled.servings === 1 ? "" : "s"}</span>
          <button
            className="icon-btn"
            onClick={() => onServingsChange(1)}
            disabled={scaled.servings >= 24}
            title="More servings"
            aria-label="Increase servings"
          >
            +
          </button>
        </div>
        {isScaled && (
          <button className="btn ghost" onClick={onResetScale} style={{ padding: "4px 10px", fontSize: 12 }}>
            Reset
          </button>
        )}
      </div>

      {/* "Scale to my ingredients" — only when shortage detected */}
      {scaleNeeded && !isScaled && (
        <div className="shortage-banner">
          <div className="shortage-banner-text">
            <strong>You don't have enough of everything.</strong>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              Recipe scales to {(availability.factor * 100).toFixed(0)}% of original to fit what's on hand.
            </div>
          </div>
          <button className="btn secondary" onClick={onScaleToAvailable} style={{ padding: "6px 12px", fontSize: 12 }}>
            Scale to my ingredients
          </button>
        </div>
      )}
      {scaleNeeded && isScaled && (
        <div className="muted" style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
          <Icon name="check" /> Scaled to fit your ingredients ({(factor * 100).toFixed(0)}%).
        </div>
      )}

      <NutritionLine state={nutritionState} />

      <section>
        <h4>Ingredients{factor !== 1 && <span className="faint" style={{ fontWeight: 400, marginLeft: 6 }}>(scaled)</span>}</h4>
        <ul>
          {scaled.ingredients.map((ing, j) => {
            const original_line = original.ingredients[j];
            const shortage = original_line ? lineShortages.get(original_line) : undefined;
            return (
              <li key={j}>
                {ing}
                {shortage && (
                  <div className="ing-shortage">
                    {shortage.constraining ? <Icon name="triangle-exclamation" /> : "· "}{" "}
                    Need {Math.round(shortage.needed)}g, you have ~{Math.round(shortage.available)}g{" "}
                    <span className="faint">({shortage.userIngredient})</span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <h4>Instructions</h4>
        <ol>
          {scaled.instructions.map((step, j) => (
            <li key={j}>{step}</li>
          ))}
        </ol>
      </section>

      <div className="row" style={{ marginTop: "auto" }}>
        <button className={`btn${onCook ? " secondary" : ""}`} disabled={saved || anySaving} onClick={onSave}>
          {saving ? "Saving…" : saved ? "Saved ✓" : "Save"}
        </button>
        {onCook && (
          <button className="btn" onClick={onCook}>
            <Icon name="bowl-food" /> Cook this
          </button>
        )}
      </div>
    </article>
  );
}

// ── Nutrition + rate-limit components (unchanged) ─────────────────────

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
        <Icon name="circle-info" />
        <strong style={{ flex: 1 }}>USDA's nutrition API rate-limited this lookup</strong>
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
          {isUsingDemoKey() ? (
            <>
              <p style={{ margin: "0 0 8px 0" }}>
                <strong>Why:</strong> nutrition lookups run through a ConjureOS proxy that's currently on USDA's public <code>DEMO_KEY</code> so it works without setup. USDA limits <code>DEMO_KEY</code> to 30 lookups per hour per IP — shared across everyone hitting the proxy.
              </p>
              <p style={{ margin: "0 0 8px 0" }}><strong>What to do:</strong></p>
              <ul style={{ margin: "0 0 8px 18px", padding: 0 }}>
                <li>Wait an hour — the cap resets and recipes already on screen keep working from cache.</li>
                <li>
                  If you run this ConjureOS instance, grab a free key (~30 seconds at{" "}
                  <a href="https://api.data.gov/signup/" target="_blank" rel="noreferrer">api.data.gov/signup</a>) and set it as the proxy's <code>USDA_API_KEY</code> secret — bumps everyone to 1000 lookups/hr.
                </li>
              </ul>
            </>
          ) : (
            <>
              <p style={{ margin: "0 0 8px 0" }}>
                <strong>Why:</strong> the nutrition proxy is on a personal USDA key, normally 1000 lookups/hr. Hitting that means an unusually heavy session.
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

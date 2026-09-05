import { useEffect, useMemo, useRef, useState } from "react";
import type { Ingredient, NutritionStrip, Recipe, SavedRecipe } from "../types";
import { saveRecipe, updateSavedRecipe } from "../features/storage";
import {
  computeNutrition,
  formatStrip,
  isUsingDemoKey,
  type NutritionResult,
} from "../features/nutrition";
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

/** The strip a card can contribute to a saved recipe, or null while it can't. */
function stripOf(state: CardNutrition | null | undefined): NutritionStrip | null {
  return state && (state.kind === "ok" || state.kind === "partial") ? state.strip : null;
}

function toCard(result: NutritionResult): CardNutrition {
  if (result.strip && result.rateLimited) {
    return { kind: "partial", strip: result.strip, missedDueToRateLimit: result.missedDueToRateLimit };
  }
  if (result.strip) return { kind: "ok", strip: result.strip };
  if (result.rateLimited) {
    return { kind: "rate-limited", missedDueToRateLimit: result.missedDueToRateLimit };
  }
  return { kind: "empty" };
}

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

  // Cards whose macros landed after they were saved and are being written to
  // the already-saved row. Purely for the "adding macros…" line.
  const [backfilling, setBackfilling] = useState<Set<number>>(new Set());
  /**
   * Each card's in-flight nutrition computation. The resolution loop below is
   * sequential (USDA's cap is tight) and each recipe costs several round-trips,
   * so card 3 can be 10+ seconds behind card 1 — while Save is enabled the
   * whole time. Save reads THIS, not just the settled state, so a card the user
   * saved early can still get its strip when the estimate lands.
   */
  const pendingNutrition = useRef<Array<Promise<CardNutrition> | null>>([]);
  /**
   * The current resolution run. Per-run rather than one shared flag: a save
   * from the PREVIOUS run has to be able to tell that ITS lookups were aborted,
   * even though a newer run has since started and is perfectly healthy.
   */
  const runRef = useRef<{ aborted: boolean }>({ aborted: false });

  const anyRateLimited = nutrition.some(
    (n) => n.kind === "rate-limited" || n.kind === "partial",
  );

  useEffect(() => {
    const run = { aborted: false };
    runRef.current = run;
    const ctrl = new AbortController();
    // Still strictly sequential — three recipes' worth of USDA lookups fired at
    // once is how the shared DEMO_KEY cap gets hit — but each card's eventual
    // result is now a promise, not just a value that may not exist yet.
    let chain: Promise<unknown> = Promise.resolve();
    pendingNutrition.current = recipes.map((r, i) => {
      const p = chain.then(async (): Promise<CardNutrition> => {
        if (run.aborted) return { kind: "empty" };
        let card: CardNutrition;
        try {
          card = toCard(await computeNutrition(r, ctrl.signal));
        } catch {
          card = { kind: "empty" };
        }
        if (!run.aborted) setNutrition((prev) => prev.map((s, j) => (j === i ? card : s)));
        return card;
      });
      chain = p;
      return p;
    });
    return () => {
      run.aborted = true;
      ctrl.abort();
    };
  }, [recipes]);

  /**
   * The recipe exactly as it will be persisted: scaled from the ORIGINAL
   * (the card renders a scaled copy, but persistence must derive from the
   * source so the factor isn't applied twice), with the strip carried THROUGH
   * scaleRecipe so its rounded-yield correction applies to the macros too.
   */
  const toPersisted = (idx: number, strip: NutritionStrip | null): Recipe =>
    scaleRecipe({ ...recipes[idx]!, nutrition: strip }, scaleFactors[idx] ?? 1);

  /**
   * The card's estimate wasn't ready when the user saved. Wait for it and patch
   * the saved row — writing `nutrition: null` and walking away is permanent,
   * because nothing recomputes nutrition for an already-saved recipe.
   */
  const backfillNutrition = async (idx: number, saved: SavedRecipe) => {
    setBackfilling((prev) => new Set(prev).add(idx));
    // Both captured synchronously: a later re-render must not repoint us at a
    // different run's promises.
    const run = runRef.current;
    const pending = pendingNutrition.current[idx];
    try {
      let strip = stripOf(await pending);
      if (!strip && run.aborted) {
        // The screen was left before this card's turn came up, so its lookup
        // was aborted along with the rest. The save already happened, so run
        // this one recipe's lookup on its own rather than lose the macros.
        strip = stripOf(toCard(await computeNutrition(recipes[idx]!)));
      }
      if (strip) await updateSavedRecipe(saved, toPersisted(idx, strip));
    } catch {
      // Best-effort: the recipe is saved either way, and the card already says
      // the macros couldn't be worked out.
    } finally {
      setBackfilling((prev) => {
        const next = new Set(prev);
        next.delete(idx);
        return next;
      });
    }
  };

  const onSave = async (idx: number) => {
    setSavingIdx(idx);
    setSaveErr(null);
    try {
      const cardState = nutrition[idx];
      const strip = stripOf(cardState);
      const saved = await saveRecipe(toPersisted(idx, strip));
      setSavedIdx((prev) => new Set(prev).add(idx));
      // A card that is still PENDING has an answer coming; one that is
      // rate-limited or empty does not, and must not delay or block the save.
      if (!strip && cardState?.kind === "pending") void backfillNutrition(idx, saved);
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
              backfilling={backfilling.has(i)}
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
  /** Saved before its macros landed; they're being written to the saved row. */
  backfilling: boolean;
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
  backfilling,
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
      {/* Saving is never blocked on the estimate — including when USDA has
          rate-limited us, where waiting would achieve nothing — so say where
          the macros are instead of letting a save quietly store none. */}
      {!saved && nutritionState.kind === "pending" && (
        <div className="faint" style={{ fontSize: 12 }}>
          Macros are still calculating — save now and they'll be added when the estimate lands.
        </div>
      )}
      {saved && backfilling && (
        <div className="faint" style={{ fontSize: 12 }}>
          Saved. Adding macros as soon as they land…
        </div>
      )}
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

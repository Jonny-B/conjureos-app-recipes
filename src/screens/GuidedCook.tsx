import { useMemo, useState } from "react";
import type { PantryItem, Recipe } from "../types";
import { ingredientsFromPantry } from "../features/pantry";
import { computeAvailability, computeCoverage, scaleRecipe } from "../features/scaling";
import { parseIngredient } from "../features/nutrition";
import { Icon } from "../icons";
import { ChefChat } from "./ChefChat";

interface Props {
  recipe: Recipe;
  pantry: PantryItem[] | null;
  /** True when this recipe is already in the user's library (offer "mark as made"). */
  saved?: boolean;
  onBack: () => void;
  /** Saved recipes: increment made-count. Rejects if persistence fails. */
  onMade?: () => Promise<void>;
  /** Unsaved (AI-described / catalog) recipes: save the (scaled) recipe. Rejects on failure. */
  onSave?: (recipe: Recipe) => Promise<void>;
}

/**
 * Full-screen guided cook: tick off ingredients as you gather them and steps as
 * you go, with a sticky progress bar. Servings/scale live in a single "Adjust"
 * popover (never a visible row). An unobtrusive "Ask the chef" button floats in
 * the corner. Resting chrome = back + Adjust; everything else is the checklist.
 */
export function GuidedCook({ recipe, pantry, saved, onBack, onMade, onSave }: Props) {
  const [checkedIng, setCheckedIng] = useState<Set<number>>(new Set());
  const [checkedStep, setCheckedStep] = useState<Set<number>>(new Set());
  const [factor, setFactor] = useState(1);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [chefOpen, setChefOpen] = useState(false);
  const [ingredientsCollapsed, setIngredientsCollapsed] = useState(false);
  const [madeDone, setMadeDone] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Catalog/DB recipes can carry a bad servings value; fall back to 1 so the
  // stepper + scaling never divide by zero into NaN.
  const baseServings = recipe.servings > 0 ? recipe.servings : 1;
  const scaled = useMemo(() => (factor === 1 ? recipe : scaleRecipe(recipe, factor)), [recipe, factor]);

  const pantryIng = useMemo(() => (pantry ? ingredientsFromPantry(pantry) : []), [pantry]);
  const hasPantry = pantryIng.length > 0;
  const cov = useMemo(
    () => (hasPantry ? computeCoverage(scaled, pantryIng) : null),
    [scaled, pantryIng, hasPantry],
  );
  const missingSet = useMemo(() => new Set(cov?.missingNames ?? []), [cov]);
  const shortSet = useMemo(() => new Set(cov?.shortNames ?? []), [cov]);

  const totalSteps = scaled.instructions.length;
  const doneSteps = checkedStep.size;
  const allDone = totalSteps > 0 && doneSteps === totalSteps;
  const currentStep = scaled.instructions.findIndex((_, i) => !checkedStep.has(i));
  const servings = Math.max(1, Math.round(baseServings * factor));

  const toggle = (set: Set<number>, i: number, apply: (s: Set<number>) => void) => {
    const next = new Set(set);
    next.has(i) ? next.delete(i) : next.add(i);
    apply(next);
  };

  const setServings = (n: number) => {
    const clamped = Math.max(1, Math.min(24, n));
    setFactor(clamped / baseServings);
  };

  // Persist on completion; only flip to the "done" confirmation if it succeeds.
  const finish = async (fn: () => Promise<void>) => {
    setSaveError(null);
    setSaving(true);
    try {
      await fn();
      setMadeDone(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const scaleToPantry = () => {
    const a = computeAvailability(recipe, pantryIng);
    if (a.factor > 0) setFactor(a.factor);
    setAdjustOpen(false);
  };

  return (
    <div className="guided">
      <header className="guided-head">
        <button className="btn ghost" onClick={onBack}>
          <Icon name="chevron-down" className="back-caret" /> Back
        </button>
        <div className="guided-progress" aria-label={`${doneSteps} of ${totalSteps} steps done`}>
          <div className="guided-progress-bar" style={{ width: `${totalSteps ? (doneSteps / totalSteps) * 100 : 0}%` }} />
        </div>
        <button
          className={`icon-btn${chefOpen ? " active" : ""}`}
          onClick={() => setChefOpen(true)}
          aria-label="Ask the chef"
          title="Ask the chef"
        >
          <Icon name="comment-dots" />
        </button>
        <div className="adjust-wrap">
          <button
            className={`icon-btn${adjustOpen ? " active" : ""}`}
            onClick={() => setAdjustOpen((v) => !v)}
            aria-label="Adjust servings"
            title="Adjust"
          >
            <Icon name="sliders" />
          </button>
          {adjustOpen && (
            <div className="adjust-pop" role="dialog" aria-label="Adjust servings">
              <div className="adjust-row">
                <span>Servings</span>
                <div className="stepper">
                  <button className="icon-btn" onClick={() => setServings(servings - 1)} aria-label="Fewer"><Icon name="minus" /></button>
                  <span className="stepper-val">{servings}</span>
                  <button className="icon-btn" onClick={() => setServings(servings + 1)} aria-label="More"><Icon name="plus" /></button>
                </div>
              </div>
              {hasPantry && (
                <button className="btn ghost" onClick={scaleToPantry}>
                  <Icon name="carrot" /> Scale to what I have
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      <h2 className="guided-title">{recipe.title}</h2>
      <div className="guided-meta">
        <span className={`pill ${recipe.difficulty}`}>{recipe.difficulty}</span>
        <span className="pill">{recipe.cookTime} min</span>
        <span className="pill">{servings} serving{servings === 1 ? "" : "s"}</span>
        {doneSteps > 0 && <span className="pill">{doneSteps}/{totalSteps} steps</span>}
      </div>

      <section className="guided-section">
        <button className="guided-section-head" onClick={() => setIngredientsCollapsed((v) => !v)}>
          <span>Ingredients · {checkedIng.size}/{scaled.ingredients.length} gathered</span>
          <Icon name="chevron-down" className={ingredientsCollapsed ? "rot-flip" : ""} />
        </button>
        {!ingredientsCollapsed && (
          <ul className="check-list">
            {scaled.ingredients.map((ing, i) => {
              const name = parseIngredient(ing)?.name;
              const missing = hasPantry && !!name && missingSet.has(name);
              const short = hasPantry && !!name && shortSet.has(name);
              const checked = checkedIng.has(i);
              return (
                <li
                  key={i}
                  className={`check-row${checked ? " checked" : ""}`}
                  onClick={() => toggle(checkedIng, i, setCheckedIng)}
                >
                  <Icon name={checked ? "check" : "circle"} className="check-mark" />
                  <span className="check-text">{ing}</span>
                  {missing && <span className="ing-tag miss"><Icon name="basket-shopping" /> need</span>}
                  {short && !missing && <span className="ing-tag low">low</span>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="guided-section">
        <div className="guided-section-head static">Steps</div>
        <ol className="step-list">
          {scaled.instructions.map((step, i) => {
            const checked = checkedStep.has(i);
            const isCurrent = !checked && i === currentStep;
            return (
              <li
                key={i}
                className={`step-row${checked ? " checked" : ""}${isCurrent ? " current" : ""}`}
                onClick={() => toggle(checkedStep, i, setCheckedStep)}
              >
                <span className="step-num"><Icon name={checked ? "check" : "circle"} /></span>
                <span className="step-text">{step}</span>
              </li>
            );
          })}
        </ol>
      </section>

      {allDone && !madeDone && (
        <div className="guided-done">
          <Icon name="check" /> Nicely done.
          {saved ? (
            <button className="btn" disabled={saving} onClick={() => finish(() => onMade?.() ?? Promise.resolve())}>
              <Icon name="check" /> {saving ? "Saving…" : "Mark as made"}
            </button>
          ) : onSave ? (
            <button className="btn" disabled={saving} onClick={() => finish(() => onSave(scaled))}>
              <Icon name="plus" /> {saving ? "Saving…" : "Save to my recipes"}
            </button>
          ) : null}
        </div>
      )}
      {saveError && (
        <div className="status-banner error">
          <Icon name="triangle-exclamation" />
          <span>Couldn't save: {saveError}</span>
        </div>
      )}
      {madeDone && (
        <div className="guided-done">
          <Icon name="check" /> {saved ? "Marked as made." : "Saved to your recipes."}
        </div>
      )}

      <ChefChat recipe={scaled} open={chefOpen} onClose={() => setChefOpen(false)} />
    </div>
  );
}

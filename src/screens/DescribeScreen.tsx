/**
 * Describe a dish, get a recipe.
 *
 * This was a tile on the old Home screen and a mode of a `cook` tab that no
 * longer exists. It lives under the Recipes library's "+" now, beside the two
 * other ways of adding a recipe (write it, snap it) — because that is what it
 * is: a third way in, not a destination.
 *
 * "Use what's in my pantry" is the pantry-first version of the same call: the
 * pantry seeds the prompt so the model writes around what you already own.
 */
import { useState } from "react";
import type { PantryItem, Recipe, SavedRecipe } from "../types";
import { generateFromDescription } from "../features/recipes";
import { ingredientsFromPantry } from "../features/pantry";
import { RecipesScreen } from "./RecipesScreen";
import { Icon } from "../icons";

export function DescribeScreen({
  pantry,
  onBack,
  onCook,
}: {
  pantry: PantryItem[] | null;
  onBack: () => void;
  onCook: (recipe: Recipe, saved: SavedRecipe | null) => void;
}) {
  const [text, setText] = useState("");
  const [useHave, setUseHave] = useState(false);
  const [state, setState] = useState<
    { kind: "input" } | { kind: "generating" } | { kind: "recipes"; recipes: Recipe[] }
  >({ kind: "input" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hasPantry = !!(pantry && pantry.length);
  const seed = () => (useHave && hasPantry ? ingredientsFromPantry(pantry ?? []) : undefined);

  const go = async () => {
    // A state flip is not a guard: two taps inside one frame both get through
    // and both bill a request. Same defect the pantry scan had.
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    setState({ kind: "generating" });
    try {
      const recipes = await generateFromDescription(text, seed());
      setState({ kind: "recipes", recipes });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState({ kind: "input" });
    } finally {
      setBusy(false);
    }
  };

  if (state.kind === "generating")
    return (
      <div className="center-spinner">
        <div className="spinner" />
        <div style={{ fontWeight: 500 }}>Writing your recipe…</div>
        <div className="muted">Three takes on your idea. ~10 seconds.</div>
      </div>
    );

  if (state.kind === "recipes")
    return (
      <div className="browse-screen">
        <BackBar label="Describe again" onBack={() => setState({ kind: "input" })} />
        <RecipesScreen
          recipes={state.recipes}
          ingredients={seed() ?? []}
          onEditIngredients={() => setState({ kind: "input" })}
          onRestart={() => setState({ kind: "input" })}
          onCook={(r) => onCook(r, null)}
        />
      </div>
    );

  return (
    <div className="describe-pane">
      <BackBar label="Back to recipes" onBack={onBack} />
      <h2>Describe a dish</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        What are you in the mood for? An ingredient, a cuisine, a craving — I'll write a recipe for it.
      </p>
      <textarea
        className="describe-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. something cozy with chicken and rice, ready in 30 minutes"
        maxLength={400}
        rows={3}
      />
      <label className={`describe-toggle${hasPantry ? "" : " disabled"}`}>
        <input
          type="checkbox"
          checked={useHave && hasPantry}
          disabled={!hasPantry}
          onChange={(e) => setUseHave(e.target.checked)}
        />
        Build it around what's in my pantry
        {!hasPantry && <span className="faint"> — scan or add items first</span>}
      </label>
      {error && (
        <div className="status-banner error">
          <Icon name="triangle-exclamation" />
          <span>{error}</span>
        </div>
      )}
      <button className="btn" disabled={!text.trim() || busy} onClick={go}>
        <Icon name="wand" /> Create recipe
      </button>
    </div>
  );
}

function BackBar({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <div className="detail-actions">
      <button className="btn ghost" onClick={onBack}>
        <Icon name="chevron-down" className="back-caret" /> {label}
      </button>
    </div>
  );
}

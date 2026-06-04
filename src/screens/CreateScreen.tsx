import { useEffect, useState, type KeyboardEvent } from "react";
import type { Recipe } from "../types";
import { structureRecipe, reviewRecipe } from "../features/customRecipe";
import { saveRecipe } from "../features/storage";
import { Icon } from "../icons";

/**
 * Create-your-own flow. The user types or pastes a recipe in free text; the
 * AI structures it into the standard Recipe schema. From there everything is
 * editable BY HAND — title, each ingredient, each step — so the user is never
 * forced to round-trip through the AI to make a small fix. An optional
 * "Check & tidy" runs an AI proofread + safety pass over manual edits before
 * saving; the user can also just save their edits as-is.
 */
export function CreateScreen() {
  const [text, setText] = useState("");
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [busy, setBusy] = useState<null | "structuring" | "tidying" | "saving">(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // True once the user hand-edits the AI result — gates the "Check & tidy"
  // recommendation and lets them re-save after a save.
  const [dirty, setDirty] = useState(false);

  const generate = async () => {
    setError(null);
    setBusy("structuring");
    try {
      const r = await structureRecipe(text);
      setRecipe(r);
      setSaved(false);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const tidy = async () => {
    if (!recipe) return;
    setError(null);
    setBusy("tidying");
    try {
      const cleaned = await reviewRecipe(recipe);
      setRecipe(cleaned);
      setDirty(false);
      setSaved(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!recipe) return;
    setError(null);
    setBusy("saving");
    try {
      await saveRecipe(recipe);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const startOver = () => {
    setText("");
    setRecipe(null);
    setSaved(false);
    setDirty(false);
    setError(null);
  };

  // Apply a mutation to the working recipe and mark it hand-edited.
  const edit = (fn: (r: Recipe) => Recipe) => {
    setRecipe((prev) => (prev ? fn(prev) : prev));
    setDirty(true);
    setSaved(false);
  };

  return (
    <div className="create-screen">
      <div>
        <h2 style={{ margin: 0 }}>Create your own</h2>
        <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
          Paste a recipe or describe one in your own words. I'll structure it; then
          you can tweak any line by hand.
        </div>
      </div>

      {error && (
        <div className="status-banner error">
          <Icon name="triangle-exclamation" />
          <span>{error}</span>
        </div>
      )}

      <textarea
        className="create-input"
        placeholder={
          "e.g.\n\nGrandma's tomato soup — sweat an onion and 2 cloves garlic in butter, add a tin of tomatoes and a cup of stock, simmer 20 min, blend, finish with a splash of cream. Serves 4."
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={7}
        maxLength={6000}
        disabled={busy !== null}
      />

      <div className="capture-buttons" style={{ justifyContent: "flex-start" }}>
        <button className="btn" onClick={generate} disabled={busy !== null || !text.trim()}>
          <Icon name="wand" />
          {recipe ? "Regenerate" : busy === "structuring" ? "Structuring…" : "Structure with AI"}
        </button>
        {(recipe || text) && (
          <button className="btn ghost" onClick={startOver} disabled={busy !== null}>
            Clear
          </button>
        )}
      </div>

      {recipe && (
        <EditablePreview
          recipe={recipe}
          dirty={dirty}
          saved={saved}
          busy={busy}
          onEdit={edit}
          onTidy={tidy}
          onSave={save}
          onStartOver={startOver}
        />
      )}
    </div>
  );
}

interface PreviewProps {
  recipe: Recipe;
  dirty: boolean;
  saved: boolean;
  busy: null | "structuring" | "tidying" | "saving";
  onEdit: (fn: (r: Recipe) => Recipe) => void;
  onTidy: () => void;
  onSave: () => void;
  onStartOver: () => void;
}

function EditablePreview({ recipe, dirty, saved, busy, onEdit, onTidy, onSave, onStartOver }: PreviewProps) {
  // Edit mode is off by default: the recipe reads as a clean card until the
  // user clicks Edit, which reveals the inline editors, trash, and add
  // controls. After an AI verify the form goes clean again, so drop back to
  // the read view automatically.
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!dirty) setEditing(false);
  }, [dirty]);

  const setIngredient = (i: number, v: string) =>
    onEdit((r) => ({ ...r, ingredients: r.ingredients.map((x, j) => (j === i ? v : x)) }));
  const removeIngredient = (i: number) =>
    onEdit((r) => ({ ...r, ingredients: r.ingredients.filter((_, j) => j !== i) }));
  const addIngredient = () => onEdit((r) => ({ ...r, ingredients: [...r.ingredients, "new ingredient"] }));

  const setInstruction = (i: number, v: string) =>
    onEdit((r) => ({ ...r, instructions: r.instructions.map((x, j) => (j === i ? v : x)) }));
  const removeInstruction = (i: number) =>
    onEdit((r) => ({ ...r, instructions: r.instructions.filter((_, j) => j !== i) }));
  const addInstruction = () => onEdit((r) => ({ ...r, instructions: [...r.instructions, "new step"] }));

  return (
    <article className="recipe-card recipe-card--static">
      <div className="row">
        <h3>
          {editing ? (
            <EditableText value={recipe.title} onCommit={(v) => onEdit((r) => ({ ...r, title: v }))} />
          ) : (
            recipe.title
          )}
        </h3>
      </div>
      <div>
        <span className={`pill ${recipe.difficulty}`}>{recipe.difficulty}</span>
        <span className="pill">{recipe.cookTime} min</span>
        <span className="pill">{recipe.servings} serving{recipe.servings === 1 ? "" : "s"}</span>
      </div>
      {recipe.summary && <p className="summary">{recipe.summary}</p>}

      <section>
        <h4>Ingredients</h4>
        <ul className={editing ? "edit-list" : undefined}>
          {recipe.ingredients.map((ing, j) =>
            editing ? (
              <li key={j} className="edit-line">
                <EditableText value={ing} onCommit={(v) => setIngredient(j, v)} />
                <button className="icon-btn line-remove" onClick={() => removeIngredient(j)} title="Delete" aria-label="Delete ingredient">
                  <Icon name="trash-can" />
                </button>
              </li>
            ) : (
              <li key={j}>{ing}</li>
            ),
          )}
        </ul>
        {editing && (
          <button className="add-line-btn" onClick={addIngredient}>+ Add ingredient</button>
        )}
      </section>

      <section>
        <h4>Instructions</h4>
        <ol className={editing ? "edit-list" : undefined}>
          {recipe.instructions.map((step, j) =>
            editing ? (
              <li key={j} className="edit-line">
                <EditableText value={step} onCommit={(v) => setInstruction(j, v)} multiline />
                <button className="icon-btn line-remove" onClick={() => removeInstruction(j)} title="Delete" aria-label="Delete step">
                  <Icon name="trash-can" />
                </button>
              </li>
            ) : (
              <li key={j}>{step}</li>
            ),
          )}
        </ol>
        {editing && (
          <button className="add-line-btn" onClick={addInstruction}>+ Add step</button>
        )}
      </section>

      <div className="row" style={{ marginTop: "auto", flexWrap: "wrap", gap: 8 }}>
        {saved ? (
          <>
            <span className="muted" style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 5 }}>
              <Icon name="check" /> Saved to your Recipes
            </span>
            <button className="btn secondary" onClick={onStartOver}>Create another</button>
          </>
        ) : (
          <>
            <button className="btn secondary" onClick={() => setEditing((v) => !v)} disabled={busy !== null}>
              <Icon name={editing ? "check" : "pen"} />
              {editing ? "Done editing" : "Edit"}
            </button>
            <div style={{ flex: 1 }} />
            {dirty ? (
              <button className="btn" onClick={onTidy} disabled={busy !== null}>
                <Icon name="wand" />
                {busy === "tidying" ? "Verifying…" : "Verify & tidy with AI"}
              </button>
            ) : (
              <button className="btn" onClick={onSave} disabled={busy !== null}>
                {busy === "saving" ? "Saving…" : "Save recipe"}
              </button>
            )}
          </>
        )}
      </div>
    </article>
  );
}

interface EditableTextProps {
  value: string;
  onCommit: (v: string) => void;
  multiline?: boolean;
}

/**
 * Click-to-edit text. Renders as plain text with a faint pen affordance;
 * clicking swaps in an input/textarea. Enter (single-line) or blur commits;
 * Escape cancels. An empty or unchanged value is discarded so a stray click
 * can't blank a line.
 */
function EditableText({ value, onCommit, multiline }: EditableTextProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const start = () => {
    setDraft(value);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    const v = draft.trim();
    if (v && v !== value) onCommit(v);
  };
  const cancel = () => setEditing(false);

  if (editing) {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.key === "Enter" && !multiline) {
        e.preventDefault();
        commit();
      }
    };
    if (multiline) {
      return (
        <textarea
          className="inline-edit"
          autoFocus
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={onKey}
          maxLength={400}
        />
      );
    }
    return (
      <input
        className="inline-edit"
        type="text"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKey}
        maxLength={200}
      />
    );
  }

  return (
    <span
      className="editable"
      onClick={start}
      onKeyDown={(e) => {
        if (e.key === "Enter") start();
      }}
      role="button"
      tabIndex={0}
      title="Click to edit"
    >
      {value}
      <Icon name="pen" className="edit-hint" />
    </span>
  );
}

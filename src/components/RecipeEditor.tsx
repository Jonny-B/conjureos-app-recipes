import { useEffect, useState, type KeyboardEvent } from "react";
import type { Recipe } from "../types";
import { reviewRecipe } from "../features/customRecipe";
import { saveRecipe } from "../features/storage";
import { publishChefRecipe } from "../bridge/recipesApi";
import { ImagePicker } from "./ImagePicker";
import { RECIPE_PHOTOS_ENABLED } from "../features/flags";
import { Icon } from "../icons";

/**
 * Editable recipe card with save. Seeded from one Recipe (from the
 * "write your own" structurer or the "snap a recipe" transcriber) and owns the
 * whole confirm-edit-save loop: every line is hand-editable, an optional
 * "Verify & tidy with AI" runs a proofread + safety pass over manual edits,
 * and Save writes it to the user's recipe DB.
 *
 * It seeds its state from `initial` once, so the parent should remount it with
 * a changing `key` when it produces a fresh recipe (a regenerate / re-snap).
 */
export function RecipeEditor({
  initial,
  onStartOver,
  startOverLabel = "Create another",
  chefMode = false,
  editId,
  onPublished,
}: {
  initial: Recipe;
  onStartOver: () => void;
  startOverLabel?: string;
  /** Chef Payson Studio: show the blog editor + publish as a promoted post. */
  chefMode?: boolean;
  /** When editing an existing chef post, its DB id (chefUpsert updates it). */
  editId?: string;
  /** Called after a successful chef publish, so the Studio can refresh its list. */
  onPublished?: () => void;
}) {
  const [recipe, setRecipe] = useState<Recipe>(initial);
  // Blog lives in its OWN state (not on `recipe`) so writing it never marks the
  // recipe dirty and the AI "tidy" pass — which only reshapes the recipe — can't
  // strip it. Merged back in only at publish time.
  const [blog, setBlog] = useState(initial.blog ?? "");
  // Like `blog`, the image lives outside `recipe` so the AI "tidy" pass (which
  // reshapes only the recipe body) can't drop it; merged back in at save.
  const [image, setImage] = useState<string | undefined>(initial.imageUrl);
  const [busy, setBusy] = useState<null | "tidying" | "saving">(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // True once the user hand-edits the recipe; gates the "Verify & tidy"
  // recommendation and lets them re-save after a save.
  const [dirty, setDirty] = useState(false);

  // Apply a mutation to the working recipe and mark it hand-edited.
  const edit = (fn: (r: Recipe) => Recipe) => {
    setRecipe((prev) => fn(prev));
    setDirty(true);
    setSaved(false);
  };

  const tidy = async () => {
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
    setError(null);
    setBusy("saving");
    try {
      if (chefMode) {
        await publishChefRecipe({ ...recipe, blog: blog.trim() || undefined, imageUrl: image }, editId);
        onPublished?.();
      } else {
        await saveRecipe({ ...recipe, imageUrl: image });
      }
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {error && (
        <div className="status-banner error">
          <Icon name="triangle-exclamation" />
          <span>{error}</span>
        </div>
      )}
      <EditablePreview
        recipe={recipe}
        dirty={dirty}
        saved={saved}
        busy={busy}
        onEdit={edit}
        onTidy={tidy}
        onSave={save}
        onStartOver={onStartOver}
        startOverLabel={startOverLabel}
        chefMode={chefMode}
        editId={editId}
        blog={blog}
        onBlogChange={setBlog}
        image={image}
        onImageChange={setImage}
      />
    </>
  );
}

interface PreviewProps {
  recipe: Recipe;
  dirty: boolean;
  saved: boolean;
  busy: null | "tidying" | "saving";
  onEdit: (fn: (r: Recipe) => Recipe) => void;
  onTidy: () => void;
  onSave: () => void;
  onStartOver: () => void;
  startOverLabel: string;
  chefMode: boolean;
  editId?: string;
  blog: string;
  onBlogChange: (v: string) => void;
  image: string | undefined;
  onImageChange: (v: string | undefined) => void;
}

function EditablePreview({
  recipe,
  dirty,
  saved,
  busy,
  onEdit,
  onTidy,
  onSave,
  onStartOver,
  startOverLabel,
  chefMode,
  editId,
  blog,
  onBlogChange,
  image,
  onImageChange,
}: PreviewProps) {
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

      {/* Photos are stored and round-tripped, but not surfaced — the app
          commits to a typographic treatment. See features/flags.ts. */}
      {RECIPE_PHOTOS_ENABLED && (
        <ImagePicker
          value={image}
          onChange={onImageChange}
          label={chefMode ? "Blog header image" : "Recipe photo"}
          hint={
            chefMode
              ? "Shown big at the top of your post, above the story. Optional."
              : "A photo of the finished dish. Optional."
          }
        />
      )}

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

      {chefMode && (
        <section>
          <h4>
            Your story{" "}
            <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>(optional blog)</span>
          </h4>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
            The story behind the dish — a memory, where it's from, a bit of your life and career.
            Readers scroll through this before the recipe, or skip straight to it. Markdown supported.
          </p>
          <textarea
            className="chef-blog-input"
            value={blog}
            onChange={(e) => onBlogChange(e.target.value)}
            placeholder="Write as much or as little as you like…"
            rows={8}
            maxLength={20000}
          />
        </section>
      )}

      <div className="row" style={{ marginTop: "auto", flexWrap: "wrap", gap: 8 }}>
        {saved ? (
          <>
            <span className="muted" style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 5 }}>
              <Icon name="check" /> {chefMode ? "Published as Chef Payson" : "Saved to your Recipes"}
            </span>
            <button className="btn secondary" onClick={onStartOver}>{startOverLabel}</button>
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
                {busy === "saving"
                  ? chefMode
                    ? "Publishing…"
                    : "Saving…"
                  : chefMode
                    ? editId
                      ? "Update recipe"
                      : "Publish as Chef Payson"
                    : "Save recipe"}
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

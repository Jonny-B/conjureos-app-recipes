import { useState } from "react";
import type { Recipe } from "../types";
import { structureRecipe } from "../features/customRecipe";
import { RecipeEditor } from "../components/RecipeEditor";
import { Icon } from "../icons";

/**
 * Create-your-own flow. The user types or pastes a recipe in free text; the
 * AI structures it into the standard Recipe schema. From there the shared
 * RecipeEditor takes over: every line is editable by hand, an optional AI
 * "verify & tidy" pass runs over manual edits, and Save writes it to the DB.
 */
/**
 * Paste cap. Shared with the textarea's `maxLength` and shown as a counter —
 * see the note by the counter for why a silent cap was the bug.
 */
const MAX_CHARS = 6000;

export function CreateScreen({
  chefMode = false,
  onPublished,
}: {
  chefMode?: boolean;
  onPublished?: () => void;
} = {}) {
  const [text, setText] = useState("");
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  // Bumped on each (re)generate so the RecipeEditor remounts with fresh state.
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await structureRecipe(text);
      setRecipe(r);
      setNonce((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const startOver = () => {
    setText("");
    setRecipe(null);
    setError(null);
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
          "e.g.\n\nGrandma's tomato soup: sweat an onion and 2 cloves garlic in butter, add a tin of tomatoes and a cup of stock, simmer 20 min, blend, finish with a splash of cream. Serves 4."
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={7}
        maxLength={MAX_CHARS}
        disabled={busy}
        aria-describedby="create-count"
      />
      {/* A counter, because `maxLength` truncates a paste SILENTLY: paste a
          10,000-character recipe and the browser keeps 6,000 with no sign
          anything was dropped — the last third of the method simply isn't
          there, and the AI structures what's left as though it were whole. */}
      <div
        id="create-count"
        className={`faint create-count${text.length >= MAX_CHARS ? " at-cap" : ""}`}
      >
        {text.length >= MAX_CHARS
          ? `At the ${MAX_CHARS.toLocaleString()}-character limit — anything past this was not pasted. Split a long recipe in two.`
          : `${text.length.toLocaleString()} / ${MAX_CHARS.toLocaleString()}`}
      </div>

      <div className="capture-buttons" style={{ justifyContent: "flex-start" }}>
        <button className="btn" onClick={generate} disabled={busy || !text.trim()}>
          <Icon name="wand" />
          {recipe ? "Regenerate" : busy ? "Structuring…" : "Structure with AI"}
        </button>
        {(recipe || text) && (
          <button className="btn ghost" onClick={startOver} disabled={busy}>
            Clear
          </button>
        )}
      </div>

      {recipe && (
        <RecipeEditor
          key={nonce}
          initial={recipe}
          onStartOver={startOver}
          startOverLabel="Create another"
          chefMode={chefMode}
          onPublished={onPublished}
        />
      )}
    </div>
  );
}

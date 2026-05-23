import { useCallback, useEffect, useMemo, useState } from "react";
import type { SavedRecipe } from "../types";
import { deleteRecipe, listSavedRecipes, markMade } from "../features/storage";
import { formatStrip } from "../features/nutrition";

type Sort = "recent" | "made";

export function BrowseScreen() {
  const [items, setItems] = useState<SavedRecipe[] | null>(null);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [selected, setSelected] = useState<SavedRecipe | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listSavedRecipes();
      setItems(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setItems([]);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    if (!items) return [];
    const q = filter.trim().toLowerCase();
    const matches = q
      ? items.filter((r) => {
          if (r.title.toLowerCase().includes(q)) return true;
          if (r.summary?.toLowerCase().includes(q)) return true;
          for (const ing of r.ingredients) {
            if (ing.toLowerCase().includes(q)) return true;
          }
          return false;
        })
      : items;
    if (sort === "made") {
      return [...matches].sort((a, b) => {
        if (b.madeCount !== a.madeCount) return b.madeCount - a.madeCount;
        return b.savedAt.localeCompare(a.savedAt);
      });
    }
    return matches;
  }, [items, filter, sort]);

  const onMade = async (recipe: SavedRecipe) => {
    try {
      const updated = await markMade(recipe);
      setItems((prev) => prev?.map((r) => (r.path === updated.path ? updated : r)) ?? null);
      if (selected?.path === updated.path) setSelected(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onDelete = async (recipe: SavedRecipe) => {
    try {
      await deleteRecipe(recipe);
      setItems((prev) => prev?.filter((r) => r.path !== recipe.path) ?? null);
      if (selected?.path === recipe.path) setSelected(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (selected) {
    return (
      <RecipeDetail
        recipe={selected}
        onBack={() => setSelected(null)}
        onMade={() => onMade(selected)}
        onDelete={() => onDelete(selected)}
      />
    );
  }

  return (
    <div className="browse-screen">
      <div className="browse-header">
        <h2>Saved recipes</h2>
        <div className="browse-filter">
          <span>🔍</span>
          <input
            type="text"
            placeholder="Filter by title or ingredient…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          className="btn ghost"
          style={{ padding: "10px 14px" }}
        >
          <option value="recent">Most recent</option>
          <option value="made">Most made</option>
        </select>
      </div>

      {error && (
        <div className="status-banner error">
          <span>⚠</span>
          <span>{error}</span>
        </div>
      )}

      {items === null ? (
        <div className="center-spinner">
          <div className="spinner" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          {items.length === 0
            ? "No recipes saved yet. Snap a photo of your fridge to get started."
            : "No recipes match that filter."}
        </div>
      ) : (
        <div className="browse-list">
          {filtered.map((r) => (
            <div key={r.path} className="browse-item" onClick={() => setSelected(r)}>
              <div className="title-block">
                <div className="title">{r.title}</div>
                <div className="meta">
                  <span className={`pill ${r.difficulty}`}>{r.difficulty}</span>
                  {" · "}
                  {r.cookTime} min
                  {r.nutrition && ` · ~${r.nutrition.calories} cal/serv`}
                  {" · saved "}
                  {formatRelative(r.savedAt)}
                </div>
              </div>
              {r.madeCount > 0 && (
                <span className="made-pill">made {r.madeCount}×</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface DetailProps {
  recipe: SavedRecipe;
  onBack: () => void;
  onMade: () => void;
  onDelete: () => void;
}

function RecipeDetail({ recipe, onBack, onMade, onDelete }: DetailProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div className="browse-screen">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button className="btn ghost" onClick={onBack}>
          ← Back
        </button>
        <div style={{ flex: 1 }} />
        <button className="btn secondary" onClick={onMade}>
          ✓ I made this
        </button>
        {confirmDelete ? (
          <>
            <span className="muted" style={{ fontSize: 13 }}>Sure?</span>
            <button className="btn danger" onClick={onDelete}>
              Delete
            </button>
            <button className="btn ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button className="btn ghost" onClick={() => setConfirmDelete(true)}>
            Delete
          </button>
        )}
      </div>

      <article className="recipe-card" style={{ maxWidth: "100%" }}>
        <h3 style={{ fontSize: 22 }}>{recipe.title}</h3>
        <div>
          <span className={`pill ${recipe.difficulty}`}>{recipe.difficulty}</span>
          <span className="pill">{recipe.cookTime} min</span>
          <span className="pill">{recipe.servings} servings</span>
          {recipe.madeCount > 0 && (
            <span className="pill">made {recipe.madeCount}× · last {formatRelative(recipe.lastMadeAt!)}</span>
          )}
        </div>
        {recipe.summary && <p className="summary">{recipe.summary}</p>}
        {recipe.nutrition && (
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.4 }}>
            {formatStrip(recipe.nutrition)}
          </div>
        )}

        <section>
          <h4>Ingredients</h4>
          <ul>
            {recipe.ingredients.map((ing, i) => (
              <li key={i}>{ing}</li>
            ))}
          </ul>
        </section>

        <section>
          <h4>Instructions</h4>
          <ol>
            {recipe.instructions.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </section>

        <div className="faint" style={{ fontSize: 11, marginTop: 8 }}>
          {recipe.path}
        </div>
      </article>
    </div>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

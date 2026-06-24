import { useEffect, useMemo, useRef, useState } from "react";
import type { FeedRecipe, PantryItem, Recipe, SavedRecipe } from "../types";
import { ingredientsFromPantry } from "../features/pantry";
import { computeAvailability, computeCoverage } from "../features/scaling";
import { parseIngredient, formatStrip } from "../features/nutrition";
import { Icon } from "../icons";

interface Props {
  feed: FeedRecipe;
  pantry: PantryItem[] | null;
  /** True when this catalog recipe is already in the user's saved library. */
  inLibrary?: boolean;
  /** Enter the guided cook for this recipe (savedRecipe set when it's in the library). */
  onCook: (recipe: Recipe, saved: SavedRecipe | null) => void;
  onBack: () => void;
  onToggleFavorite: () => void;
  onSaveToLibrary?: () => void; // catalog only
  onMade?: () => void; // saved only
  onDelete?: () => void; // saved only
}

/**
 * One recipe, full detail. Serves catalog, saved, and favorite recipes; the
 * header actions adapt to feed.kind. Per-ingredient lines are annotated
 * against the pantry (short on quantity / not in pantry) reusing the same
 * matcher the feed ranks with.
 */
export function RecipeDetail({
  feed,
  pantry,
  inLibrary,
  onCook,
  onBack,
  onToggleFavorite,
  onSaveToLibrary,
  onMade,
  onDelete,
}: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const recipe: Recipe = feed.recipe;

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);
  const pantryIng = useMemo(() => (pantry ? ingredientsFromPantry(pantry) : []), [pantry]);
  const hasPantry = pantryIng.length > 0;

  const avail = useMemo(
    () => (hasPantry ? computeAvailability(recipe, pantryIng) : null),
    [recipe, pantryIng, hasPantry],
  );
  const cov = useMemo(
    () => (hasPantry ? computeCoverage(recipe, pantryIng) : null),
    [recipe, pantryIng, hasPantry],
  );

  const matchByLine = useMemo(() => {
    const m = new Map<string, { needed: number; available: number }>();
    if (avail) for (const x of avail.matches) m.set(x.recipeLine, { needed: x.needed, available: x.available });
    return m;
  }, [avail]);
  const missingSet = useMemo(() => new Set(cov?.missingNames ?? []), [cov]);
  const shortSet = useMemo(() => new Set(cov?.shortNames ?? []), [cov]);

  const isCatalog = feed.kind === "catalog";

  return (
    <div className="browse-screen">
      <div className="detail-actions">
        <button className="btn ghost" onClick={onBack}>
          <Icon name="chevron-down" className="back-caret" /> Back
        </button>
        <div style={{ flex: 1 }} />
        <button
          className={`icon-btn fav-btn${feed.favorite ? " on" : ""}`}
          onClick={onToggleFavorite}
          aria-label={feed.favorite ? "Remove from favorites" : "Add to favorites"}
          title={feed.favorite ? "Remove from favorites" : "Add to favorites"}
        >
          <Icon name="heart" />
        </button>
        <button className="btn" onClick={() => onCook(recipe, feed.kind === "saved" ? feed.recipe : null)}>
          <Icon name="bowl-food" /> Cook this
        </button>
        <div className="overflow-wrap" ref={menuRef}>
          <button
            className={`icon-btn${menuOpen ? " active" : ""}`}
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="More actions"
            title="More"
          >
            <Icon name="ellipsis" />
          </button>
          {menuOpen && (
            <div className="overflow-menu" role="menu">
              {isCatalog ? (
                <button
                  className="overflow-item"
                  disabled={inLibrary}
                  onClick={() => { onSaveToLibrary?.(); setMenuOpen(false); }}
                >
                  <Icon name="check" /> {inLibrary ? "In your recipes" : "Save to my recipes"}
                </button>
              ) : (
                <>
                  <button className="overflow-item" onClick={() => { onMade?.(); setMenuOpen(false); }}>
                    <Icon name="check" /> I made this
                  </button>
                  <button
                    className="overflow-item danger"
                    onClick={() => { setMenuOpen(false); setConfirmDelete(true); }}
                  >
                    <Icon name="trash-can" /> Delete
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {confirmDelete && (
        <div className="confirm-row">
          <span>Delete this recipe?</span>
          <button className="btn danger" onClick={onDelete}>Delete</button>
          <button className="btn ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
        </div>
      )}

      <article className="recipe-card recipe-card--static" style={{ maxWidth: "100%" }}>
        <h3 style={{ fontSize: 22 }}>{recipe.title}</h3>
        <div>
          {isCatalog && <span className="pill">{feed.recipe.category}</span>}
          <span className={`pill ${recipe.difficulty}`}>{recipe.difficulty}</span>
          <span className="pill">{recipe.cookTime} min</span>
          <span className="pill">{recipe.servings} serving{recipe.servings === 1 ? "" : "s"}</span>
          {feed.kind === "saved" && feed.recipe.madeCount > 0 && (
            <span className="pill">made {feed.recipe.madeCount}×</span>
          )}
        </div>

        {recipe.summary && <p className="summary">{recipe.summary}</p>}
        {recipe.nutrition && (
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.4 }}>{formatStrip(recipe.nutrition)}</div>
        )}

        {cov && (
          <div className={`cov-banner${cov.missing === 0 ? " complete" : ""}`}>
            <Icon name={cov.missing === 0 ? "check" : "basket-shopping"} />
            {cov.missing === 0
              ? "You have everything for this."
              : `You have ${cov.have} of ${cov.total} ingredients` +
                (cov.short ? ` (${cov.short} running low)` : "") +
                `. ${cov.missing} to buy.`}
          </div>
        )}

        <section>
          <h4>Ingredients</h4>
          <ul>
            {recipe.ingredients.map((ing, i) => {
              const name = parseIngredient(ing)?.name;
              const missing = hasPantry && !!name && missingSet.has(name);
              const short = hasPantry && !!name && shortSet.has(name);
              const m = matchByLine.get(ing);
              return (
                <li key={i}>
                  {ing}
                  {missing && (
                    <span className="ing-missing">
                      <Icon name="basket-shopping" /> not in pantry
                    </span>
                  )}
                  {short && m && (
                    <span className="ing-shortage">
                      <Icon name="triangle-exclamation" /> running low: need ~{Math.round(m.needed)}g, have ~
                      {Math.round(m.available)}g
                    </span>
                  )}
                </li>
              );
            })}
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

        {isCatalog && feed.recipe.sourceUrl && (
          <div className="faint" style={{ fontSize: 11, marginTop: 8 }}>
            Source:{" "}
            <a href={feed.recipe.sourceUrl} target="_blank" rel="noreferrer" className="source-link">
              AllRecipes
            </a>
          </div>
        )}
        {feed.kind === "saved" && (
          <div className="faint" style={{ fontSize: 11, marginTop: 8 }}>{feed.recipe.path}</div>
        )}
      </article>
    </div>
  );
}

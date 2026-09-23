import { useEffect, useRef, useState, type ReactNode } from "react";
import type { FeedRecipe, Recipe, SavedRecipe } from "../types";
import { safeHref, hrefHost } from "../features/safeUrl";
import { categoryOf, lookFor, splitIngredient } from "../features/recipeLook";
import { RecipePlate } from "../components/RecipePlate";
import { RecipeStats } from "../components/RecipeStats";
import { CHEF_NAME } from "./StudioScreen";
import { Icon } from "../icons";

/**
 * Minimal, safe blog renderer: blank-line-separated blocks become headings
 * (`#`, `##`) or paragraphs. Single newlines are preserved. No HTML/markdown
 * library, no dangerouslySetInnerHTML — just text, so nothing can be injected.
 */
function renderBlog(text: string): ReactNode[] {
  return text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block, i) => {
      if (block.startsWith("## ")) return <h5 key={i}>{block.slice(3)}</h5>;
      if (block.startsWith("# ")) return <h4 key={i}>{block.slice(2)}</h4>;
      return (
        <p key={i} style={{ whiteSpace: "pre-wrap" }}>
          {block}
        </p>
      );
    });
}

interface Props {
  feed: FeedRecipe;
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
  const recipeRef = useRef<HTMLDivElement | null>(null);
  const recipe: Recipe = feed.recipe;
  /**
   * The source link, scheme-checked. `sourceUrl` is scraped third-party data
   * that was rendered straight into an href — a row carrying `javascript:...`
   * was a one-tap script execution in the app's own origin. Null when it isn't
   * an http(s) URL, and the link simply isn't rendered.
   */
  const sourceHref = safeHref((recipe as Recipe & { sourceUrl?: string }).sourceUrl);

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

  const isCatalog = feed.kind === "catalog";
  const category = categoryOf(feed);

  return (
    <div className="browse-screen">
      <div className="detail-actions">
        <button className="btn ghost" onClick={onBack}>
          <Icon name="chevron-down" className="back-caret" /> Back
        </button>
        <div style={{ flex: 1 }} />
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

      <article className="recipe-sheet">
        <header className="recipe-head">
          <RecipePlate recipe={recipe} category={category} variant="poster" />
          <div className="recipe-head-body">
            <button
              className={`card-fav${feed.favorite ? " on" : ""}`}
              onClick={onToggleFavorite}
              aria-label={feed.favorite ? "Remove from favorites" : "Add to favorites"}
              title={feed.favorite ? "Remove from favorites" : "Add to favorites"}
            >
              <Icon name="heart" />
            </button>
            <div className={`recipe-eyebrow hue-${lookFor(category).hue}`}>
              {category ?? "My recipe"}
              {feed.kind === "saved" && feed.recipe.madeCount > 0 && (
                <span className="recipe-made"> · made {feed.recipe.madeCount}×</span>
              )}
            </div>
            <h2 className="recipe-title">{recipe.title}</h2>
            {recipe.chefFeatured && <div className="chef-byline">By {CHEF_NAME}</div>}
            {recipe.summary && <p className="recipe-summary">{recipe.summary}</p>}
          </div>
        </header>

        <RecipeStats recipe={recipe} />

        {/* Chef's blog: the story you scroll past on recipe sites — with a skip. */}
        {recipe.blog && (
          <section className="chef-blog">
            <button
              className="btn ghost jump-to-recipe"
              onClick={() => recipeRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
            >
              Jump to recipe <Icon name="chevron-down" />
            </button>
            <div className="chef-blog-body">{renderBlog(recipe.blog)}</div>
          </section>
        )}

        <div ref={recipeRef} />
        {/* Cookbook layout: the ingredient table beside the method on a wide
            screen, stacked on a phone. Amounts get their own column so you
            can read down it while shopping or measuring. */}
        <div className="recipe-body">
          <section className="recipe-ingredients">
            <h3 className="recipe-section-head">
              Ingredients <span>{recipe.ingredients.length}</span>
            </h3>
            <ul className="ing-table">
              {recipe.ingredients.map((ing, i) => {
                const { qty, name, note } = splitIngredient(ing);
                return (
                  <li key={i}>
                    <span className="ing-qty">{qty}</span>
                    <span className="ing-name">
                      {name}
                      {note && <span className="ing-note"> {note}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="recipe-method">
            <h3 className="recipe-section-head">
              Method <span>{recipe.instructions.length} steps</span>
            </h3>
            <ol className="method">
              {recipe.instructions.map((step, i) => (
                <li key={i}>
                  <span className="method-num">{String(i + 1).padStart(2, "0")}</span>
                  <p>{step}</p>
                </li>
              ))}
            </ol>
            <button
              className="btn detail-cook-bottom"
              onClick={() => onCook(recipe, feed.kind === "saved" ? feed.recipe : null)}
            >
              <Icon name="bowl-food" /> Cook this
            </button>
          </section>
        </div>

        {isCatalog && sourceHref && (
          <div className="recipe-source">
            Source:{" "}
            <a href={archivedHref(sourceHref)} target="_blank" rel="noreferrer noopener" className="source-link">
              {hrefHost(sourceHref) ?? "source"}
              {isRetiredSource(sourceHref) && " (archived)"}
            </a>
          </div>
        )}
        {feed.kind === "saved" && <div className="recipe-source">{feed.recipe.path}</div>}
      </article>
    </div>
  );
}

/**
 * myplate.gov was retired in January 2026: every catalog row's source URL now
 * redirects to the site's front page, so "Source: myplate.gov" was a link to
 * the wrong page. The Internet Archive's capture — the same pages the corpus
 * was ingested from — is the page the link means.
 */
function isRetiredSource(href: string): boolean {
  return hrefHost(href) === "myplate.gov";
}

function archivedHref(href: string): string {
  return isRetiredSource(href) ? `https://web.archive.org/web/2025/${href}` : href;
}

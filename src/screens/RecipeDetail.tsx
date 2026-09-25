import { useEffect, useRef, useState, type ReactNode } from "react";
import type { FeedRecipe, Recipe, SavedRecipe } from "../types";
import { formatStrip } from "../features/nutrition";
import { safeHref, hrefHost } from "../features/safeUrl";
import { photoBusyText, usePhotoActions } from "../hooks/usePhotoActions";
import { adminRemoveRecipeImage, adminSetRecipeImage, recipeIdFromPath, setOwnRecipeImage } from "../bridge/recipesApi";
import { RECIPE_PHOTOS_ENABLED } from "../features/flags";
import { categoryOf } from "../features/recipeLook";
import { RecipePlate } from "../components/RecipePlate";
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
  /** Admins can give ANY recipe (catalog included) an AI photo, or take a photo off. */
  isAdmin?: boolean;
  /** The recipe's photo changed on the server; patch it into the screen's state. */
  onImageChanged?: (patch: { imageUrl?: string; imageAi?: boolean }) => void;
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
  isAdmin = false,
  onImageChanged,
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

  // ── photo actions ─────────────────────────────────────────────────────
  // Your own recipe goes through the ordinary update (ownership is the
  // check); anyone else's — or a catalog row — only through the admin
  // actions, which recipes-db re-checks.
  const ownRecipe = feed.kind === "saved";
  const canEditPhoto = RECIPE_PHOTOS_ENABLED && (ownRecipe || isAdmin);
  const recipeDbId = feed.kind === "catalog" ? feed.id : recipeIdFromPath(feed.recipe.path);
  const photo = usePhotoActions({
    subject: () => ({ recipe, category }),
    apply: async (url, ai) => {
      if (url === null) {
        if (feed.kind === "saved") await setOwnRecipeImage(recipeDbId, recipe, null);
        else await adminRemoveRecipeImage(recipeDbId);
        onImageChanged?.({ imageUrl: undefined, imageAi: false });
        return;
      }
      if (feed.kind === "saved") await setOwnRecipeImage(recipeDbId, recipe, url);
      else await adminSetRecipeImage(recipeDbId, url);
      onImageChanged?.({ imageUrl: url, imageAi: ai });
    },
  });
  const photoBusy = photo.busy;
  const menuThen = (fn: () => void) => () => {
    setMenuOpen(false);
    fn();
  };

  const cook = () => onCook(recipe, feed.kind === "saved" ? feed.recipe : null);

  return (
    <div className="browse-screen detail-screen">
      <div className="detail-actions">
        <button className="btn ghost" onClick={onBack}>
          <Icon name="chevron-down" className="back-caret" /> Back
        </button>
        <div style={{ flex: 1 }} />
        {/* The heart lives up here, not on the picture: the picture's top-right
            corner is where an AI image carries its "AI-generated" stamp, and
            it is the one corner of the cover that is never faded. */}
        <button
          className={`icon-btn detail-fav${feed.favorite ? " on" : ""}`}
          onClick={onToggleFavorite}
          aria-label={feed.favorite ? "Remove from favorites" : "Add to favorites"}
          title={feed.favorite ? "Remove from favorites" : "Add to favorites"}
        >
          <Icon name="heart" />
        </button>
        <button className="btn" onClick={cook}>
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
              {canEditPhoto && (
                <button className="overflow-item" onClick={menuThen(photo.upload)} disabled={!!photoBusy}>
                  <Icon name="camera" /> {recipe.imageUrl ? "Replace photo" : "Upload photo"}
                </button>
              )}
              {canEditPhoto && photo.canEnhance && (
                <button className="overflow-item" onClick={menuThen(() => void photo.uploadAndEnhance())} disabled={!!photoBusy}>
                  <Icon name="wand" /> Upload &amp; enhance with AI
                </button>
              )}
              {canEditPhoto && photo.canEnhance && recipe.imageUrl && !recipe.imageAi && (
                <button
                  className="overflow-item"
                  onClick={menuThen(() => void photo.enhanceExisting(recipe.imageUrl!))}
                  disabled={!!photoBusy}
                >
                  <Icon name="wand" /> Enhance this photo with AI
                </button>
              )}
              {canEditPhoto && photo.canGenerate && (
                <button className="overflow-item" onClick={menuThen(() => void photo.generate())} disabled={!!photoBusy}>
                  <Icon name="wand" /> {recipe.imageUrl ? "New AI photo" : "Generate AI photo"}
                </button>
              )}
              {canEditPhoto && photo.original && (
                <button className="overflow-item" onClick={menuThen(() => void photo.restoreOriginal())} disabled={!!photoBusy}>
                  <Icon name="clock-rotate-left" /> Use my original photo
                </button>
              )}
              {canEditPhoto && recipe.imageUrl && (
                <button className="overflow-item danger" onClick={menuThen(() => void photo.remove())} disabled={!!photoBusy}>
                  <Icon name="xmark" /> Remove photo
                </button>
              )}
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

      {photo.fileInput}
      {photoBusy && (
        <div className="status-banner">
          <div className="spinner" style={{ width: 14, height: 14 }} />
          <span>{photoBusyText(photoBusy)}</span>
        </div>
      )}
      {photo.original && !photoBusy && (
        <div className="status-banner">
          <Icon name="circle-info" />
          <span>Enhanced with AI. Not quite your dish?</span>
          <button className="btn ghost" type="button" onClick={() => void photo.restoreOriginal()}>
            Use my original
          </button>
        </div>
      )}
      {photo.error && (
        <div className="status-banner error">
          <Icon name="triangle-exclamation" />
          <span>{photo.error}</span>
        </div>
      )}

      {confirmDelete && (
        <div className="confirm-row">
          <span>Delete this recipe?</span>
          <button className="btn danger" onClick={onDelete}>Delete</button>
          <button className="btn ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
        </div>
      )}

      {/* The open recipe, laid out to the owner's mockup (2026-09-23): the
          recipe's picture behind the card, the page laid over it on a fade of
          the card's own background, the ingredients down the left and the
          instructions in two columns. With no photo, the category plate fills
          the same box — see components/RecipePlate. */}
      <article className="recipe-cover">
        <div className="recipe-cover-media">
          <RecipePlate recipe={recipe} category={category} variant="cover" />
        </div>
        <div className="recipe-cover-body">
          <h2 className="recipe-cover-title">{recipe.title}</h2>
          <div className="recipe-cover-pills">
            {category && <span className="pill cat">{category}</span>}
            <span className={`pill ${recipe.difficulty}`}>{recipe.difficulty}</span>
            {recipe.cookTime > 0 && <span className="pill">{recipe.cookTime} min</span>}
            <span className="pill">
              {recipe.servings} serving{recipe.servings === 1 ? "" : "s"}
            </span>
            {feed.kind === "saved" && feed.recipe.madeCount > 0 && (
              <span className="pill">made {feed.recipe.madeCount}×</span>
            )}
            {/* The page says it as well as the picture: a stamp can still be
                cropped on an unusually shaped photo, and the pill can't. */}
            {RECIPE_PHOTOS_ENABLED && recipe.imageUrl && recipe.imageAi && (
              <span className="pill ai" title="This image was generated by AI">
                AI image
              </span>
            )}
          </div>
          {recipe.nutrition && <div className="recipe-cover-nutrition">{formatStrip(recipe.nutrition)}</div>}
          {recipe.chefFeatured && <div className="chef-byline">By {CHEF_NAME}</div>}
          {recipe.summary && <p className="recipe-cover-summary">{recipe.summary}</p>}

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
          <section className="recipe-cover-ingredients">
            <h3 className="recipe-cover-head">Ingredients</h3>
            <ul className="cover-ing">
              {recipe.ingredients.map((ing, i) => (
                <li key={i}>{ing}</li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="recipe-cover-head">Instructions</h3>
            <ol className="cover-steps">
              {recipe.instructions.map((step, i) => (
                <li key={i}>
                  {/* The <ol> already numbers these for a screen reader. */}
                  <span className="cover-step-num" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </section>

          <footer className="recipe-cover-foot">
            <button className="btn detail-cook-bottom" onClick={cook}>
              <Icon name="bowl-food" /> Cook this
            </button>
            {isCatalog && sourceHref && (
              <div className="recipe-cover-source">
                Source:{" "}
                <a
                  href={archivedHref(sourceHref)}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="source-link"
                  title={isRetiredSource(sourceHref) ? "Opens the Internet Archive's copy — myplate.gov was retired in 2026" : undefined}
                >
                  {hrefHost(sourceHref) ?? "source"}
                </a>
              </div>
            )}
            {feed.kind === "saved" && <div className="recipe-cover-source">{feed.recipe.path}</div>}
          </footer>
        </div>
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

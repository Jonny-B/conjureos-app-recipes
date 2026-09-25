import { useCallback, useEffect, useMemo, useState } from "react";
import type { CatalogRecipe, FeedRecipe, Recipe, RecipeSource, SavedRecipe } from "../types";
import { getCatalog, categories, toRecipe, loadRecipeBody, withRecipeBody, patchCatalogRecipe } from "../features/catalog";
import {
  listSavedRecipesResult,
  saveRecipe,
  markMade,
  deleteRecipe,
  setSavedFavorite,
} from "../features/storage";
import { loadFavorites, toggleCatalogFavorite } from "../features/favorites";
import { RecipeRow } from "../components/RecipeRow";
import { RecipePlate } from "../components/RecipePlate";
import { RecipeStats } from "../components/RecipeStats";
import { categoryOf, keyIngredients, lookFor } from "../features/recipeLook";
import { RecipeDetail } from "./RecipeDetail";
import { CreateScreen } from "./CreateScreen";
import { SnapRecipeScreen } from "./SnapRecipeScreen";
import { DescribeScreen } from "./DescribeScreen";
import { CHEF_NAME } from "./StudioScreen";
import { fetchChefLatest } from "../bridge/recipesApi";
import { buildScored, daySeed, type Scored } from "../features/recommend";
import { Icon } from "../icons";
import { ErrorBanner, useActionError } from "../components/ErrorBanner";
import { ResumeCook } from "../components/ResumeCook";
import { loadCookSession, type CookSession } from "../features/cookSession";

interface Props {
  /** Which slice to show: all recipes, just the user's saved ones, or favorites. */
  source: RecipeSource;
  onSourceChange: (s: RecipeSource) => void;
  /** Enter the guided cook for a recipe (savedRecipe set when it's in the library). */
  onCook: (recipe: Recipe, saved: SavedRecipe | null) => void;
  /** Bumped by App when the catalog reloads from the DB, so the memos re-run. */
  catalogVersion?: number;
  /** Admin: may give any recipe an AI photo or remove its photo. */
  isAdmin?: boolean;
}

const SOURCE_TABS: { id: RecipeSource; label: string }[] = [
  { id: "all", label: "All" },
  { id: "mine", label: "My recipes" },
  { id: "favorites", label: "Favorites" },
];

const PAGE_SIZE = 60;
/**
 * The three ways a recipe gets INTO the library, all behind the one "+" in the
 * control bar. "Describe a dish" used to be a tile on the Home screen; Home is
 * gone, and an AI that writes a recipe belongs beside the two other ways of
 * adding one, not on a screen of its own. (Design rule: AI is the verb inside a
 * pillar, never a tab.)
 */
type Mode = "list" | "write" | "snap" | "describe";

function keyOf(fi: FeedRecipe): string {
  return fi.kind === "catalog" ? `c:${fi.id}` : `s:${fi.recipe.path}`;
}

export function RecipesBrowseScreen({ source, onSourceChange, onCook, catalogVersion = 0, isAdmin = false }: Props) {
  const [saved, setSaved] = useState<SavedRecipe[]>([]);
  /**
   * A cook left running, if there is one.
   *
   * The guided cook is an OVERLAY, not a tab, so a persisted session has no
   * door of its own — without this banner it would survive its 12h TTL and be
   * unreachable. It used to sit on the Pantry screen because that was home;
   * this is home now.
   */
  const [resumable, setResumable] = useState<CookSession | null>(null);
  const [favs, setFavs] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<FeedRecipe | null>(null);
  const [mode, setMode] = useState<Mode>("list");
  const [addOpen, setAddOpen] = useState(false);
  /** Re-rolls the top recommendation past its equal-scored ties. */
  const [shuffle, setShuffle] = useState(0);
  const [chefPick, setChefPick] = useState<CatalogRecipe | null>(null);

  const catalog = useMemo(() => getCatalog(), [catalogVersion]);

  // A failed library read must not render as "you haven't saved any recipes
  // yet" — that sentence is a claim about the user's data, and getting it wrong
  // reads exactly like data loss. Same three-state treatment PlansScreen uses.
  const [loadFailed, setLoadFailed] = useState(false);

  const refresh = useCallback(async () => {
    const [s, f] = await Promise.all([listSavedRecipesResult(), loadFavorites()]);
    if (s.ok) {
      setSaved(s.recipes);
      setLoadFailed(false);
    } else {
      setLoadFailed(true);
    }
    setFavs(f);
    setLoaded(true);
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    setResumable(loadCookSession());
  }, []);
  // Chef Payson's newest promoted recipe (best-effort; absent if none/offline).
  useEffect(() => {
    fetchChefLatest(1)
      .then((list) => setChefPick(list[0] ?? null))
      .catch(() => {});
  }, []);

  const feedItems = useMemo<FeedRecipe[]>(() => {
    const savedItems: FeedRecipe[] = saved.map((r) => ({ kind: "saved", recipe: r, favorite: !!r.favorite }));
    if (source === "mine") return savedItems;
    if (source === "favorites") {
      const savedFavs = savedItems.filter((fi) => fi.favorite);
      const catFavs: FeedRecipe[] = catalog
        .filter((c) => favs.has(c.id))
        .map((c) => ({ kind: "catalog", id: c.id, recipe: c, favorite: true }));
      return [...savedFavs, ...catFavs];
    }
    const catItems: FeedRecipe[] = catalog.map((c) => ({ kind: "catalog", id: c.id, recipe: c, favorite: favs.has(c.id) }));
    return [...savedItems, ...catItems];
  }, [source, catalog, saved, favs]);

  const ranked = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = feedItems.filter((fi) => {
      if (q && !matchesQuery(fi, q)) return false;
      if (source === "all" && category !== "all") {
        return fi.kind === "catalog" && fi.recipe.category === category;
      }
      return true;
    });
    return items.slice().sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      const ak = a.kind === "saved" ? 0 : 1;
      const bk = b.kind === "saved" ? 0 : 1;
      return ak - bk;
    });
  }, [feedItems, query, category, source]);

  const visible = ranked.slice(0, page * PAGE_SIZE);

  /**
   * "Tonight's pick" — the library's one recommendation (see
   * features/recommend.ts). It no longer scores against a pantry; what is left
   * is favourites, quick recipes and what you have not cooked lately.
   *
   * Deliberately hidden the moment someone is searching or filtering: a
   * suggestion is help when you are browsing and an obstacle when you already
   * know what you are looking for.
   */
  const browsing = source === "all" && !query.trim() && category === "all";
  const scored = useMemo(
    () => (browsing ? buildScored(catalog, saved, favs, daySeed()) : []),
    [browsing, catalog, saved, favs],
  );
  // Rotate through the top of the ranking rather than re-sorting: the ordering
  // is already the answer, the shuffle just walks it.
  const heroPool = scored.slice(0, 12);
  const hero: Scored | null = heroPool.length ? heroPool[shuffle % heroPool.length]! : null;

  // Biggest first, so the rail opens on Dinner (585) and ends on Snack (4).
  const categoryList = useMemo(
    () => categories().slice().sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    [catalogVersion],
  );

  const resetPaging = () => setPage(1);

  // ── mutations ──────────────────────────────────────────────────────
  // All four go through `run` so a failure surfaces in the banner instead of
  // the console — see components/ErrorBanner. Delete is the one that hurt
  // most: the confirm dialog just sat there when the call rejected.
  const { error: actionError, clear: clearActionError, run } = useActionError();
  const onToggleFavorite = (fi: FeedRecipe) =>
    run(async () => {
      if (fi.kind === "catalog") setFavs(await toggleCatalogFavorite(fi.id));
      else {
        const updated = await setSavedFavorite(fi.recipe, !fi.recipe.favorite);
        setSaved((prev) => prev.map((r) => (r.path === updated.path ? updated : r)));
      }
    });
  const onSaveToLibrary = (fi: FeedRecipe) =>
    run(async () => {
      if (fi.kind !== "catalog") return;
      await saveRecipe(toRecipe(await loadRecipeBody(fi.recipe)));
      await refresh();
    });
  const onMade = (fi: FeedRecipe) =>
    run(async () => {
      if (fi.kind !== "saved") return;
      const u = await markMade(fi.recipe);
      setSaved((prev) => prev.map((r) => (r.path === u.path ? u : r)));
    });
  const onDelete = (fi: FeedRecipe) =>
    run(async () => {
      if (fi.kind !== "saved") return;
      await deleteRecipe(fi.recipe);
      setSaved((prev) => prev.filter((r) => r.path !== fi.recipe.path));
      setSelected(null);
    });

  const resolvedSelected = useMemo<FeedRecipe | null>(() => {
    if (!selected) return null;
    if (selected.kind === "catalog")
      return { kind: "catalog", id: selected.id, recipe: selected.recipe, favorite: favs.has(selected.id) };
    const s = saved.find((x) => x.path === selected.recipe.path);
    if (!s) return null;
    return { kind: "saved", recipe: s, favorite: !!s.favorite };
  }, [selected, favs, saved]);

  // ── Add-a-recipe sub-views (by hand / by picture / by description) ──
  if (mode === "write" || mode === "snap" || mode === "describe") {
    const back = () => {
      setMode("list");
      refresh();
    };
    if (mode === "describe") {
      return <DescribeScreen onBack={back} onCook={onCook} />;
    }
    return (
      <div className="browse-screen">
        <div className="detail-actions">
          <button className="btn ghost" onClick={back}>
            <Icon name="chevron-down" className="back-caret" /> Back to recipes
          </button>
        </div>
        {mode === "write" ? <CreateScreen /> : <SnapRecipeScreen />}
      </div>
    );
  }

  if (resolvedSelected) {
    const inLibrary =
      resolvedSelected.kind === "catalog" &&
      saved.some((s) => s.title.toLowerCase() === resolvedSelected.recipe.title.toLowerCase());
    return (
      <>
        <ErrorBanner error={actionError} onDismiss={clearActionError} />
        <RecipeDetail
          feed={resolvedSelected}
          inLibrary={inLibrary}
          onCook={onCook}
          onBack={() => setSelected(null)}
          onToggleFavorite={() => onToggleFavorite(resolvedSelected)}
          onSaveToLibrary={() => onSaveToLibrary(resolvedSelected)}
          onMade={() => onMade(resolvedSelected)}
          onDelete={() => onDelete(resolvedSelected)}
          isAdmin={isAdmin}
          onImageChanged={(patch) => {
            if (resolvedSelected.kind === "catalog") {
              patchCatalogRecipe(resolvedSelected.id, patch);
              setSelected({ ...resolvedSelected, recipe: { ...resolvedSelected.recipe, ...patch } });
            } else {
              setSaved((prev) => prev.map((r) => (r.path === resolvedSelected.recipe.path ? { ...r, ...patch } : r)));
            }
          }}
        />
      </>
    );
  }

  return (
    <div className="browse-screen">
      <ErrorBanner error={actionError} onDismiss={clearActionError} />
      {resumable && (
        <ResumeCook
          session={resumable}
          saved={saved}
          onResume={(r, sv) => onCook(r, sv)}
          onForget={() => setResumable(null)}
        />
      )}
      {/* Ours vs. yours: the primary switch for the whole tab. */}
      <div className="seg" role="tablist" aria-label="Which recipes">
        {SOURCE_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={source === t.id}
            className={`seg-btn${source === t.id ? " active" : ""}`}
            onClick={() => {
              onSourceChange(t.id);
              resetPaging();
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tonight's pick and the chef's newest come BEFORE the search row (#918):
          they are what the tab opens on, and search is how you leave them.
          Both vanish while a query is typed, so the row moves up then. */}
      {browsing && hero && (
        <HeroPick
          scored={hero}
          onView={() => run(async () => setSelected(await withRecipeBody(hero.fi)))}
          onShuffle={() => setShuffle((n) => n + 1)}
          canShuffle={heroPool.length > 1}
        />
      )}

      {browsing && chefPick && (
        <button
          className="chef-promo"
          onClick={() =>
            run(async () =>
              setSelected(
                await withRecipeBody({
                  kind: "catalog" as const,
                  id: chefPick.id,
                  recipe: chefPick,
                  favorite: favs.has(chefPick.id),
                }),
              ),
            )
          }
        >
          <span className="chef-promo-eyebrow">
            <Icon name="utensils" /> {CHEF_NAME}'s newest recipe
          </span>
          <span className="chef-promo-title">{chefPick.title}</span>
          {chefPick.summary && <span className="chef-promo-sub">{chefPick.summary}</span>}
        </button>
      )}

      {/* One slim control bar: search + add. The category rail sits under it. */}
      <div className="lib-header">
        <div className="browse-filter">
          <Icon name="magnifying-glass" />
          <input
            type="text"
            placeholder="Search recipes…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              resetPaging();
            }}
          />
        </div>
        <button
          className={`icon-btn lib-icon${addOpen ? " active" : ""}`}
          onClick={() => {
            setAddOpen((v) => !v);
          }}
          aria-label="Add a recipe"
          title="Add a recipe"
        >
          <Icon name="plus" />
        </button>
      </div>

      {addOpen && (
        <div className="lib-panel add-panel">
          <button className="btn secondary" onClick={() => { setAddOpen(false); setMode("write"); }}>
            <Icon name="pen" /> Write it
          </button>
          <button className="btn secondary" onClick={() => { setAddOpen(false); setMode("snap"); }}>
            <Icon name="camera" /> Snap a photo
          </button>
          <button className="btn secondary" onClick={() => { setAddOpen(false); setMode("describe"); }}>
            <Icon name="wand" /> Describe a dish
          </button>
        </div>
      )}

      {/* Categories, out in the open. They used to sit behind a filter icon in
          a dropdown, so the one way to browse 1,120 recipes by kind was two
          clicks deep and looked like a settings menu. */}
      {source === "all" && categoryList.length > 0 && (
        <div className="cat-rail" role="group" aria-label="Category">
          <button
            type="button"
            aria-pressed={category === "all"}
            className={`cat-chip${category === "all" ? " active" : ""}`}
            onClick={() => {
              setCategory("all");
              resetPaging();
            }}
          >
            All
          </button>
          {categoryList.map((c) => {
            const look = lookFor(c.name);
            const on = category === c.name;
            return (
              <button
                key={c.name}
                type="button"
                aria-pressed={on}
                className={`cat-chip hue-${look.hue}${on ? " active" : ""}`}
                onClick={() => {
                  setCategory(on ? "all" : c.name);
                  resetPaging();
                }}
              >
                <Icon name={look.glyph} />
                {c.name}
                <span className="cat-count">{c.count}</span>
              </button>
            );
          })}
        </div>
      )}

      {loaded && ranked.length > 0 && (
        <p className="lib-count">
          {ranked.length.toLocaleString()} recipe{ranked.length === 1 ? "" : "s"}
        </p>
      )}

      {!loaded ? (
        <div className="center-spinner"><div className="spinner" /></div>
      ) : ranked.length === 0 ? (
        <EmptyState source={source} hasQuery={!!query || (source === "all" && category !== "all")} onAdd={() => setMode("write")} failed={loadFailed} onRetry={() => { setLoaded(false); void refresh(); }} />
      ) : (
        <>
          <div className="browse-list">
            {visible.map((fi) => (
              <RecipeRow
                key={keyOf(fi)}
                fi={fi}
                onOpen={() => run(async () => setSelected(await withRecipeBody(fi)))}
              />
            ))}
          </div>
          {visible.length < ranked.length && (
            <div style={{ textAlign: "center", marginTop: 4 }}>
              <button className="btn ghost" onClick={() => setPage((p) => p + 1)}>
                Show more ({ranked.length - visible.length} left)
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The library's one recommendation. Lifted off the old Home screen; since
 * 0.54.0 it is a poster (the recipe's plate, or its photo) beside the pitch,
 * because a feature that looks exactly like a feed row is just a big row.
 */
function HeroPick({
  scored,
  onView,
  onShuffle,
  canShuffle,
}: {
  scored: Scored;
  onView: () => void;
  onShuffle: () => void;
  canShuffle: boolean;
}) {
  const r = scored.fi.recipe;
  const category = categoryOf(scored.fi);
  const keys = keyIngredients(scored.fi, 5);
  return (
    <article className="hero-card">
      <RecipePlate recipe={r} category={category} variant="poster" />
      <div className="hero-body">
        {canShuffle && (
          <button className="hero-refresh" onClick={onShuffle} aria-label="Another idea" title="Another idea">
            <Icon name="rotate" />
          </button>
        )}
        <div className="hero-eyebrow">
          <Icon name="wand" /> Tonight's pick
        </div>
        <h3 className="hero-title">{r.title}</h3>
        {keys.length > 0 && <div className="hero-keys">{keys.join(" · ")}</div>}
        <RecipeStats recipe={r} />
        <div className="hero-foot">
          <button className="btn" onClick={onView}>
            View recipe
          </button>
          <span className="hero-why">{scored.reason}</span>
        </div>
      </div>
    </article>
  );
}

function matchesQuery(fi: FeedRecipe, q: string): boolean {
  if (fi.recipe.title.toLowerCase().includes(q)) return true;
  if (fi.kind === "catalog") {
    if (fi.recipe.category.toLowerCase().includes(q)) return true;
    if (fi.recipe.tags.some((t) => t.includes(q))) return true;
    if (fi.recipe.tokens.some((t) => t.includes(q))) return true;
  } else {
    if (fi.recipe.ingredients.some((i) => i.toLowerCase().includes(q))) return true;
  }
  return false;
}

function EmptyState({ source, hasQuery, onAdd, failed, onRetry }: { source: RecipeSource; hasQuery: boolean; onAdd: () => void; failed: boolean; onRetry: () => void }) {
  if (hasQuery)
    return (
      <div className="empty-state">
        <Icon name="bowl-food" className="empty-icon" />
        <div>No recipes match that filter.</div>
      </div>
    );
  if (source === "favorites")
    return (
      <div className="empty-state">
        <Icon name="heart" className="empty-icon" />
        <div>No favorites yet. Tap the heart on any recipe to save it here.</div>
      </div>
    );
  if (source === "mine")
    return failed ? (
      <div className="empty-state">
        <Icon name="bowl-food" className="empty-icon" />
        <div>Couldn&apos;t load your recipes. They&apos;re still saved — this is a
          connection problem, not a missing library.</div>
        <button className="btn" onClick={onRetry}>Try again</button>
      </div>
    ) : (
      <div className="empty-state">
        <Icon name="bowl-food" className="empty-icon" />
        <div>You haven't saved any recipes yet. Save one from All, or add your own.</div>
        <button className="btn" onClick={onAdd}>
          <Icon name="plus" /> Add a recipe
        </button>
      </div>
    );
  return (
    <div className="empty-state">
      <Icon name="bowl-food" className="empty-icon" />
      <div>No recipes to show.</div>
    </div>
  );
}

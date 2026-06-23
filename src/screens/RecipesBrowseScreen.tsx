import { useCallback, useEffect, useMemo, useState } from "react";
import type { CoverageResult } from "../features/scaling";
import type { FeedRecipe, PantryItem, Recipe, SavedRecipe } from "../types";
import { getCatalog, categories, toRecipe } from "../features/catalog";
import {
  listSavedRecipes,
  saveRecipe,
  markMade,
  deleteRecipe,
  setSavedFavorite,
} from "../features/storage";
import { loadFavorites, toggleCatalogFavorite } from "../features/favorites";
import { ingredientsFromPantry } from "../features/pantry";
import { computeCoverage } from "../features/scaling";
import { Dropdown, type DropdownOption } from "../components/Dropdown";
import { RecipeRow } from "../components/RecipeRow";
import { RecipeDetail } from "./RecipeDetail";
import { Icon } from "../icons";

interface Props {
  mode: "browse" | "favorites";
  pantry: PantryItem[] | null;
  onOpenPantry: () => void;
  /** Bumped by App when the catalog reloads from the DB, so the memos re-run. */
  catalogVersion?: number;
}

const PAGE_SIZE = 60;

function keyOf(fi: FeedRecipe): string {
  return fi.kind === "catalog" ? `c:${fi.id}` : `s:${fi.recipe.path}`;
}
function recipeOf(fi: FeedRecipe): Recipe {
  return fi.recipe;
}

export function RecipesBrowseScreen({ mode, pantry, onOpenPantry, catalogVersion = 0 }: Props) {
  const [saved, setSaved] = useState<SavedRecipe[]>([]);
  const [favs, setFavs] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [view, setView] = useState<"browse" | "suggest">("browse");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<FeedRecipe | null>(null);

  const catalog = useMemo(() => getCatalog(), [catalogVersion]);
  const pantryIng = useMemo(() => (pantry ? ingredientsFromPantry(pantry) : []), [pantry]);
  const hasPantry = pantryIng.length > 0;

  const refresh = useCallback(async () => {
    const [s, f] = await Promise.all([listSavedRecipes(), loadFavorites()]);
    setSaved(s);
    setFavs(f);
    setLoaded(true);
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Favorites view is inherently a "suggestions" surface; in browse, default
  // to plain browse and let the user opt into ranking once they have a pantry.
  useEffect(() => {
    if (!hasPantry && view === "suggest") setView("browse");
  }, [hasPantry, view]);

  const showCoverage = (mode === "favorites" || view === "suggest") && hasPantry;

  const feedItems = useMemo<FeedRecipe[]>(() => {
    if (mode === "favorites") {
      const savedFavs: FeedRecipe[] = saved
        .filter((r) => r.favorite)
        .map((r) => ({ kind: "saved", recipe: r, favorite: true }));
      const catFavs: FeedRecipe[] = catalog
        .filter((c) => favs.has(c.id))
        .map((c) => ({ kind: "catalog", id: c.id, recipe: c, favorite: true }));
      return [...savedFavs, ...catFavs];
    }
    const savedItems: FeedRecipe[] = saved.map((r) => ({
      kind: "saved",
      recipe: r,
      favorite: !!r.favorite,
    }));
    const catItems: FeedRecipe[] = catalog.map((c) => ({
      kind: "catalog",
      id: c.id,
      recipe: c,
      favorite: favs.has(c.id),
    }));
    return [...savedItems, ...catItems];
  }, [mode, catalog, saved, favs]);

  // Coverage computed once per (items, pantry) change, keyed by item identity.
  const coverageMap = useMemo(() => {
    const m = new Map<string, CoverageResult>();
    if (hasPantry) for (const fi of feedItems) m.set(keyOf(fi), computeCoverage(recipeOf(fi), pantryIng));
    return m;
  }, [feedItems, pantryIng, hasPantry]);

  const ranked = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = feedItems.filter((fi) => {
      if (q && !matchesQuery(fi, q)) return false;
      if (category !== "all") return fi.kind === "catalog" && fi.recipe.category === category;
      return true;
    });
    const rank = view === "suggest" && hasPantry;
    return items.slice().sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      if (rank) {
        const sa = coverageMap.get(keyOf(a))?.score ?? -Infinity;
        const sb = coverageMap.get(keyOf(b))?.score ?? -Infinity;
        if (sb !== sa) return sb - sa;
        return recipeOf(a).cookTime - recipeOf(b).cookTime;
      }
      const ak = a.kind === "saved" ? 0 : 1;
      const bk = b.kind === "saved" ? 0 : 1;
      return ak - bk;
    });
  }, [feedItems, query, category, view, hasPantry, coverageMap]);

  const visible = ranked.slice(0, page * PAGE_SIZE);

  const categoryOptions = useMemo<DropdownOption<string>[]>(
    () => [
      { value: "all", label: "All categories" },
      ...categories().map((c) => ({ value: c.name, label: `${c.name} (${c.count})` })),
    ],
    [catalogVersion],
  );

  const resetPaging = () => setPage(1);

  // ── mutations ──────────────────────────────────────────────────────
  const onToggleFavorite = async (fi: FeedRecipe) => {
    if (fi.kind === "catalog") {
      setFavs(await toggleCatalogFavorite(fi.id));
    } else {
      const updated = await setSavedFavorite(fi.recipe, !fi.recipe.favorite);
      setSaved((prev) => prev.map((r) => (r.path === updated.path ? updated : r)));
    }
  };
  const onSaveToLibrary = async (fi: FeedRecipe) => {
    if (fi.kind !== "catalog") return;
    await saveRecipe(toRecipe(fi.recipe));
    await refresh();
  };
  const onMade = async (fi: FeedRecipe) => {
    if (fi.kind !== "saved") return;
    const u = await markMade(fi.recipe);
    setSaved((prev) => prev.map((r) => (r.path === u.path ? u : r)));
  };
  const onDelete = async (fi: FeedRecipe) => {
    if (fi.kind !== "saved") return;
    await deleteRecipe(fi.recipe);
    setSaved((prev) => prev.filter((r) => r.path !== fi.recipe.path));
    setSelected(null);
  };

  // Re-resolve the selected item against fresh state so the detail reflects
  // favorite/made changes live (and bails if a saved recipe was deleted).
  const resolvedSelected = useMemo<FeedRecipe | null>(() => {
    if (!selected) return null;
    if (selected.kind === "catalog") {
      return { kind: "catalog", id: selected.id, recipe: selected.recipe, favorite: favs.has(selected.id) };
    }
    const s = saved.find((x) => x.path === selected.recipe.path);
    if (!s) return null;
    return { kind: "saved", recipe: s, favorite: !!s.favorite };
  }, [selected, favs, saved]);

  if (resolvedSelected) {
    const inLibrary =
      resolvedSelected.kind === "catalog" &&
      saved.some((s) => s.title.toLowerCase() === resolvedSelected.recipe.title.toLowerCase());
    return (
      <RecipeDetail
        feed={resolvedSelected}
        pantry={pantry}
        inLibrary={inLibrary}
        onBack={() => setSelected(null)}
        onToggleFavorite={() => onToggleFavorite(resolvedSelected)}
        onSaveToLibrary={() => onSaveToLibrary(resolvedSelected)}
        onMade={() => onMade(resolvedSelected)}
        onDelete={() => onDelete(resolvedSelected)}
      />
    );
  }

  const title = mode === "favorites" ? "Favorites" : "Recipes";

  return (
    <div className="browse-screen">
      <div className="browse-header">
        <h2>{title}</h2>
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
        {mode === "browse" && (
          <Dropdown
            options={categoryOptions}
            value={category}
            onChange={(v) => {
              setCategory(v);
              resetPaging();
            }}
            ariaLabel="Filter by category"
          />
        )}
      </div>

      {mode === "browse" && (
        <div className="feed-toolbar">
          <button
            className={`nav-btn${view === "browse" ? " active" : ""}`}
            onClick={() => {
              setView("browse");
              resetPaging();
            }}
          >
            Browse
          </button>
          <button
            className={`nav-btn${view === "suggest" ? " active" : ""}`}
            onClick={() => {
              if (!hasPantry) return;
              setView("suggest");
              resetPaging();
            }}
            disabled={!hasPantry}
            title={hasPantry ? "Rank by what's in your pantry" : "Add pantry items to use this"}
          >
            <Icon name="sliders" /> What can I make
          </button>
          {!hasPantry && (
            <button className="btn ghost feed-toolbar-cta" onClick={onOpenPantry}>
              <Icon name="carrot" /> Add pantry items
            </button>
          )}
        </div>
      )}

      {!loaded ? (
        <div className="center-spinner">
          <div className="spinner" />
        </div>
      ) : ranked.length === 0 ? (
        <EmptyState mode={mode} hasQuery={!!query || category !== "all"} />
      ) : (
        <>
          <div className="browse-list">
            {visible.map((fi) => (
              <RecipeRow
                key={keyOf(fi)}
                fi={fi}
                cov={showCoverage ? coverageMap.get(keyOf(fi)) : undefined}
                onOpen={() => setSelected(fi)}
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

function EmptyState({ mode, hasQuery }: { mode: "browse" | "favorites"; hasQuery: boolean }) {
  if (mode === "favorites") {
    return (
      <div className="empty-state">
        <Icon name="heart" className="empty-icon" />
        <div>No favorites yet. Tap the heart on any recipe to save it here.</div>
      </div>
    );
  }
  return (
    <div className="empty-state">
      <Icon name="bowl-food" className="empty-icon" />
      <div>{hasQuery ? "No recipes match that filter." : "No recipes to show."}</div>
    </div>
  );
}

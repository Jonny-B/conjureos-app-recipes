import { useCallback, useEffect, useMemo, useState } from "react";
import type { FeedRecipe, PantryItem, Recipe, RecipeSource, SavedRecipe } from "../types";
import { getCatalog, categories, toRecipe, loadRecipeBody } from "../features/catalog";
import {
  listSavedRecipes,
  saveRecipe,
  markMade,
  deleteRecipe,
  setSavedFavorite,
} from "../features/storage";
import { loadFavorites, toggleCatalogFavorite } from "../features/favorites";
import { Dropdown, type DropdownOption } from "../components/Dropdown";
import { RecipeRow } from "../components/RecipeRow";
import { RecipeDetail } from "./RecipeDetail";
import { CreateScreen } from "./CreateScreen";
import { SnapRecipeScreen } from "./SnapRecipeScreen";
import { ingredientsFromPantry } from "../features/pantry";
import { computeCoverage } from "../features/scaling";
import { Icon } from "../icons";

interface Props {
  /** Which slice to show: all recipes, just the user's saved ones, or favorites. */
  source: RecipeSource;
  onSourceChange: (s: RecipeSource) => void;
  pantry: PantryItem[] | null;
  /** Enter the guided cook for a recipe (savedRecipe set when it's in the library). */
  onCook: (recipe: Recipe, saved: SavedRecipe | null) => void;
  /** Bumped by App when the catalog reloads from the DB, so the memos re-run. */
  catalogVersion?: number;
}

const SOURCE_TABS: { id: RecipeSource; label: string }[] = [
  { id: "all", label: "All" },
  { id: "mine", label: "My recipes" },
  { id: "favorites", label: "Favorites" },
];

const PAGE_SIZE = 60;
type Mode = "list" | "write" | "snap";

function keyOf(fi: FeedRecipe): string {
  return fi.kind === "catalog" ? `c:${fi.id}` : `s:${fi.recipe.path}`;
}

export function RecipesBrowseScreen({ source, onSourceChange, pantry, onCook, catalogVersion = 0 }: Props) {
  const [saved, setSaved] = useState<SavedRecipe[]>([]);
  const [favs, setFavs] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<FeedRecipe | null>(null);
  const [mode, setMode] = useState<Mode>("list");
  const [filterOpen, setFilterOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const catalog = useMemo(() => getCatalog(), [catalogVersion]);

  const refresh = useCallback(async () => {
    const [s, f] = await Promise.all([listSavedRecipes(), loadFavorites()]);
    setSaved(s);
    setFavs(f);
    setLoaded(true);
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

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

  // Pantry coverage for the rows on screen. Home and Pantry already show these
  // chips; the browse list didn't, so applying a category filter looked like it
  // "lost" the have/short/missing counts. Slim catalog rows carry `tokens`,
  // which is what computeCoverage matches on, so this works pre-body-fetch.
  const pantryIng = useMemo(() => (pantry ? ingredientsFromPantry(pantry) : []), [pantry]);
  const covFor = (fi: FeedRecipe) =>
    pantryIng.length > 0 ? computeCoverage(fi.recipe, pantryIng) ?? undefined : undefined;

  const categoryOptions = useMemo<DropdownOption<string>[]>(
    () => [
      { value: "all", label: "All categories" },
      ...categories().map((c) => ({ value: c.name, label: `${c.name} (${c.count})` })),
    ],
    [catalogVersion],
  );

  const resetPaging = () => setPage(1);
  // Source now lives in the always-visible segmented switch, so it's no longer a
  // hidden "filter"; only the category dropdown (All view) counts here.
  const activeFilters = source === "all" && category !== "all" ? 1 : 0;

  // ── mutations ──────────────────────────────────────────────────────
  const onToggleFavorite = async (fi: FeedRecipe) => {
    if (fi.kind === "catalog") setFavs(await toggleCatalogFavorite(fi.id));
    else {
      const updated = await setSavedFavorite(fi.recipe, !fi.recipe.favorite);
      setSaved((prev) => prev.map((r) => (r.path === updated.path ? updated : r)));
    }
  };
  const onSaveToLibrary = async (fi: FeedRecipe) => {
    if (fi.kind !== "catalog") return;
    await saveRecipe(toRecipe(await loadRecipeBody(fi.recipe)));
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

  const resolvedSelected = useMemo<FeedRecipe | null>(() => {
    if (!selected) return null;
    if (selected.kind === "catalog")
      return { kind: "catalog", id: selected.id, recipe: selected.recipe, favorite: favs.has(selected.id) };
    const s = saved.find((x) => x.path === selected.recipe.path);
    if (!s) return null;
    return { kind: "saved", recipe: s, favorite: !!s.favorite };
  }, [selected, favs, saved]);

  // ── Add-a-recipe sub-views (by hand / by picture), hosted in Recipes ──
  if (mode === "write" || mode === "snap") {
    const back = () => {
      setMode("list");
      refresh();
    };
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
      <RecipeDetail
        feed={resolvedSelected}
        pantry={pantry}
        inLibrary={inLibrary}
        onCook={onCook}
        onBack={() => setSelected(null)}
        onToggleFavorite={() => onToggleFavorite(resolvedSelected)}
        onSaveToLibrary={() => onSaveToLibrary(resolvedSelected)}
        onMade={() => onMade(resolvedSelected)}
        onDelete={() => onDelete(resolvedSelected)}
      />
    );
  }

  return (
    <div className="browse-screen">
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
              setFilterOpen(false);
              resetPaging();
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* One slim control bar: search + filter + add. Everything else is the list. */}
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
        {source === "all" && (
          <button
            className={`icon-btn lib-icon${filterOpen || activeFilters ? " active" : ""}`}
            onClick={() => {
              setFilterOpen((v) => !v);
              setAddOpen(false);
            }}
            aria-label="Filter"
            title="Filter by category"
          >
            <Icon name="sliders" />
            {activeFilters > 0 && <span className="lib-badge">{activeFilters}</span>}
          </button>
        )}
        <button
          className={`icon-btn lib-icon${addOpen ? " active" : ""}`}
          onClick={() => {
            setAddOpen((v) => !v);
            setFilterOpen(false);
          }}
          aria-label="Add a recipe"
          title="Add a recipe"
        >
          <Icon name="plus" />
        </button>
      </div>

      {filterOpen && source === "all" && (
        <div className="lib-panel">
          <div className="lib-panel-label">Category</div>
          <Dropdown
            options={categoryOptions}
            value={category}
            onChange={(v) => {
              setCategory(v);
              resetPaging();
            }}
            ariaLabel="Filter by category"
          />
        </div>
      )}

      {addOpen && (
        <div className="lib-panel add-panel">
          <button className="btn secondary" onClick={() => { setAddOpen(false); setMode("write"); }}>
            <Icon name="pen" /> Write it
          </button>
          <button className="btn secondary" onClick={() => { setAddOpen(false); setMode("snap"); }}>
            <Icon name="camera" /> Snap a photo
          </button>
        </div>
      )}

      {!loaded ? (
        <div className="center-spinner"><div className="spinner" /></div>
      ) : ranked.length === 0 ? (
        <EmptyState source={source} hasQuery={!!query || (source === "all" && category !== "all")} onAdd={() => setMode("write")} />
      ) : (
        <>
          <div className="browse-list">
            {visible.map((fi) => (
              <RecipeRow
                key={keyOf(fi)}
                fi={fi}
                cov={covFor(fi)}
                onOpen={async () => {
                  // loadRecipeBody RETURNS the filled row (catalog rows ship
                  // slim — no ingredients/instructions until opened). Awaiting
                  // it and then selecting the original `fi` threw the body away,
                  // so the detail screen rendered empty INGREDIENTS and
                  // INSTRUCTIONS headings.
                  const recipe = await loadRecipeBody(fi.recipe);
                  setSelected({ ...fi, recipe } as FeedRecipe);
                }}
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

function EmptyState({ source, hasQuery, onAdd }: { source: RecipeSource; hasQuery: boolean; onAdd: () => void }) {
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
    return (
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

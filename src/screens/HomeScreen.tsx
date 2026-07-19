import { useCallback, useEffect, useMemo, useState } from "react";
import type { CoverageResult } from "../features/scaling";
import type { CatalogRecipe, FeedRecipe, PantryItem, Recipe, SavedRecipe } from "../types";
import { getCatalog, toRecipe } from "../features/catalog";
import {
  listSavedRecipes,
  saveRecipe,
  markMade,
  deleteRecipe,
  setSavedFavorite,
} from "../features/storage";
import { loadFavorites, toggleCatalogFavorite } from "../features/favorites";
import { ingredientsFromPantry } from "../features/pantry";
import { computeCoverage, prettyIngredient } from "../features/scaling";
import { RecipeRow } from "../components/RecipeRow";
import { RecipeDetail } from "./RecipeDetail";
import { CHEF_NAME } from "./StudioScreen";
import { fetchChefLatest } from "../bridge/recipesApi";
import { Icon, type IconName } from "../icons";

type NavTab = "cook" | "recipes" | "plan";

interface Props {
  pantry: PantryItem[] | null;
  onNavigate: (tab: NavTab) => void;
  /** Open the Recipes tab pre-filtered to the user's favorites. */
  onViewFavorites: () => void;
  /** Open the Cook tab's kitchen (scan/pantry) surface directly. */
  onOpenKitchen: () => void;
  /** Start the guided cook for a recipe (from a Home recommendation's detail). */
  onCook: (recipe: Recipe, saved: SavedRecipe | null) => void;
  /** Bumped by App when the catalog reloads from the DB, so the memo re-runs. */
  catalogVersion?: number;
}

interface Scored {
  fi: FeedRecipe;
  cov: CoverageResult | null;
  score: number;
  reason: string;
}

function keyOf(fi: FeedRecipe): string {
  return fi.kind === "catalog" ? `c:${fi.id}` : `s:${fi.recipe.path}`;
}

export function HomeScreen({ pantry, onNavigate, onViewFavorites, onOpenKitchen, onCook, catalogVersion = 0 }: Props) {
  const [saved, setSaved] = useState<SavedRecipe[]>([]);
  const [favs, setFavs] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [shuffle, setShuffle] = useState(0);
  const [selected, setSelected] = useState<FeedRecipe | null>(null);
  const [chefPick, setChefPick] = useState<CatalogRecipe | null>(null);

  const refresh = useCallback(async () => {
    const [s, f] = await Promise.all([listSavedRecipes(), loadFavorites()]);
    setSaved(s);
    setFavs(f);
    setLoaded(true);
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  // Chef Payson's newest promoted recipe (best-effort; absent if none/offline).
  useEffect(() => {
    fetchChefLatest(1)
      .then((list) => setChefPick(list[0] ?? null))
      .catch(() => {});
  }, []);

  const catalog = useMemo(() => getCatalog(), [catalogVersion]);
  const pantryIng = useMemo(() => (pantry ? ingredientsFromPantry(pantry) : []), [pantry]);
  const hasPantry = pantryIng.length > 0;

  // Daily seed: reshuffles equal-scored ties once a day so "Tonight's pick"
  // (and the idea lists) feel fresh day-to-day instead of frozen.
  const seed = daySeed();
  const scored = useMemo(
    () => buildScored(catalog, saved, favs, pantryIng, hasPantry, seed),
    [catalog, saved, favs, pantryIng, hasPantry, seed],
  );

  const favoriteItems = useMemo(() => scored.filter((s) => s.fi.favorite), [scored]);
  const readyToCook = useMemo(
    () => (hasPantry ? scored.filter((s) => s.cov && s.cov.total > 0 && s.cov.missing === 0).length : 0),
    [scored, hasPantry],
  );

  // "Tonight's pick" rotates through the matches. With a pantry we keep the
  // pool tight (the best coverage matches); without one, every catalog recipe
  // scores about the same, so we open the pool wide and let the seeded-hash
  // ordering (see buildScored) spread the picks across the whole catalog —
  // otherwise the flat scores fall back to an alphabetical tiebreak and the
  // rotate button just loops through the "A" recipes forever.
  const heroPoolSize = Math.min(hasPantry ? 12 : 50, scored.length);
  const heroIdx = heroPoolSize > 0 ? shuffle % heroPoolSize : -1;
  const hero = heroIdx >= 0 ? scored[heroIdx]! : null;
  const ideas = useMemo(
    () => scored.filter((_, i) => i !== heroIdx).slice(0, 4),
    [scored, heroIdx],
  );

  // ── recipe detail (self-contained, mirrors the feed) ─────────────────
  const onToggleFavorite = async (fi: FeedRecipe) => {
    if (fi.kind === "catalog") setFavs(await toggleCatalogFavorite(fi.id));
    else {
      const u = await setSavedFavorite(fi.recipe, !fi.recipe.favorite);
      setSaved((p) => p.map((r) => (r.path === u.path ? u : r)));
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
    setSaved((p) => p.map((r) => (r.path === u.path ? u : r)));
  };
  const onDelete = async (fi: FeedRecipe) => {
    if (fi.kind !== "saved") return;
    await deleteRecipe(fi.recipe);
    setSaved((p) => p.filter((r) => r.path !== fi.recipe.path));
    setSelected(null);
  };

  const resolved = useMemo<FeedRecipe | null>(() => {
    if (!selected) return null;
    if (selected.kind === "catalog")
      return { kind: "catalog", id: selected.id, recipe: selected.recipe, favorite: favs.has(selected.id) };
    const s = saved.find((x) => x.path === selected.recipe.path);
    if (!s) return null;
    return { kind: "saved", recipe: s, favorite: !!s.favorite };
  }, [selected, favs, saved]);

  if (resolved) {
    const inLibrary =
      resolved.kind === "catalog" &&
      saved.some((s) => s.title.toLowerCase() === resolved.recipe.title.toLowerCase());
    return (
      <RecipeDetail
        feed={resolved}
        pantry={pantry}
        inLibrary={inLibrary}
        onCook={onCook}
        onBack={() => setSelected(null)}
        onToggleFavorite={() => onToggleFavorite(resolved)}
        onSaveToLibrary={() => onSaveToLibrary(resolved)}
        onMade={() => onMade(resolved)}
        onDelete={() => onDelete(resolved)}
      />
    );
  }

  if (!loaded) {
    return (
      <div className="center-spinner">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="home-screen">
      <div className="home-greeting">
        <h2>{greeting()}</h2>
        <div className="muted">{tagline(favoriteItems.length, readyToCook, hasPantry)}</div>
      </div>

      {hero && (
        <HeroPick
          scored={hero}
          onView={() => setSelected(hero.fi)}
          onShuffle={() => setShuffle((s) => s + 1)}
          canShuffle={heroPoolSize > 1}
        />
      )}

      {chefPick && (
        <button
          className="chef-promo"
          onClick={() =>
            setSelected({ kind: "catalog", id: chefPick.id, recipe: chefPick, favorite: favs.has(chefPick.id) })
          }
        >
          <span className="chef-promo-eyebrow">
            <Icon name="utensils" /> {CHEF_NAME}'s newest recipe
          </span>
          <span className="chef-promo-title">{chefPick.title}</span>
          {chefPick.summary && <span className="chef-promo-sub">{chefPick.summary}</span>}
        </button>
      )}

      <div className="stat-row">
        <StatTile
          icon="heart"
          value={favoriteItems.length}
          label={favoriteItems.length === 1 ? "favorite" : "favorites"}
          onClick={onViewFavorites}
        />
        <StatTile
          icon="bowl-food"
          value={hasPantry ? readyToCook : "+"}
          label={hasPantry ? "ready to cook" : "add a pantry"}
          onClick={() => (hasPantry ? onNavigate("recipes") : onOpenKitchen())}
          accent
        />
        <StatTile
          icon="carrot"
          value={pantry?.length ?? 0}
          label={(pantry?.length ?? 0) === 1 ? "pantry item" : "pantry items"}
          onClick={onOpenKitchen}
        />
      </div>

      <section className="home-section">
        <div className="home-section-head">
          <h3>Your favorites</h3>
          {favoriteItems.length > 0 && (
            <button className="link-btn" onClick={onViewFavorites}>
              See all
            </button>
          )}
        </div>
        {favoriteItems.length === 0 ? (
          <div className="home-nudge">
            <Icon name="heart" />
            <div>
              <strong>No favorites yet.</strong> Tap the heart on a recipe and it lands here for
              quick reach.
            </div>
            <button className="btn secondary" onClick={() => onNavigate("recipes")}>
              Browse recipes
            </button>
          </div>
        ) : (
          <div className="browse-list">
            {favoriteItems.slice(0, 4).map((s) => (
              <RecipeRow
                key={keyOf(s.fi)}
                fi={s.fi}
                cov={hasPantry ? s.cov ?? undefined : undefined}
                onOpen={() => setSelected(s.fi)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="home-section">
        <div className="home-section-head">
          <h3>{hasPantry ? "More you can make" : "More ideas"}</h3>
          <button className="link-btn" onClick={() => onNavigate("recipes")}>
            Browse all
          </button>
        </div>
        <div className="browse-list">
          {ideas.map((s) => (
            <RecipeRow
              key={keyOf(s.fi)}
              fi={s.fi}
              cov={hasPantry ? s.cov ?? undefined : undefined}
              onOpen={() => setSelected(s.fi)}
            />
          ))}
        </div>
      </section>

      <section className="home-section">
        <div className="home-section-head">
          <h3>Jump in</h3>
        </div>
        <div className="quick-actions">
          <QuickAction icon="camera" title="Scan your fridge" sub="Cook from what you have" onClick={onOpenKitchen} />
          <QuickAction icon="calendar-days" title="Plan my week" sub="One shopping list" onClick={() => onNavigate("plan")} />
          <QuickAction icon="magnifying-glass" title="Browse recipes" sub="~1,200 to explore" onClick={() => onNavigate("recipes")} />
        </div>
      </section>
    </div>
  );
}

// ── hero ────────────────────────────────────────────────────────────────

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
  const cov = scored.cov;
  return (
    <article className="hero-card">
      {canShuffle && (
        <button className="hero-refresh" onClick={onShuffle} aria-label="Another idea" title="Another idea">
          <Icon name="rotate" />
        </button>
      )}
      <div className="hero-eyebrow">
        <Icon name="wand" /> Tonight's pick
      </div>
      <h3 className="hero-title">{r.title}</h3>
      <div className="hero-meta">
        {scored.fi.kind === "catalog" && <span className="pill cat">{scored.fi.recipe.category}</span>}
        <span className={`pill ${r.difficulty}`}>{r.difficulty}</span>
        <span className="pill">{r.cookTime} min</span>
        {r.nutrition && <span className="pill">~{r.nutrition.calories} cal</span>}
      </div>
      <div className={`hero-why${cov && cov.missing === 0 ? " have" : ""}`}>
        <Icon name={cov && cov.missing === 0 ? "check" : "circle-info"} />
        {scored.reason}
      </div>
      {cov && cov.missing > 0 && (cov.missingNames.length > 0 || cov.shortNames.length > 0) && (
        <div className="cov-strip">
          {cov.missingNames.slice(0, 4).map((n) => (
            <span key={n} className="miss-chip">
              {prettyIngredient(n)}
            </span>
          ))}
        </div>
      )}
      <div className="hero-actions">
        <button className="btn" onClick={onView}>
          View recipe
        </button>
      </div>
    </article>
  );
}

// ── small pieces ──────────────────────────────────────────────────────

function StatTile({
  icon,
  value,
  label,
  onClick,
  accent,
}: {
  icon: IconName;
  value: number | string;
  label: string;
  onClick: () => void;
  accent?: boolean;
}) {
  return (
    <button className={`stat-tile${accent ? " accent" : ""}`} onClick={onClick}>
      <Icon name={icon} className="stat-icon" />
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </button>
  );
}

function QuickAction({
  icon,
  title,
  sub,
  onClick,
}: {
  icon: IconName;
  title: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button className="quick-action" onClick={onClick}>
      <Icon name={icon} className="quick-icon" />
      <span className="quick-title">{title}</span>
      <span className="quick-sub">{sub}</span>
    </button>
  );
}

// ── recommendation engine ─────────────────────────────────────────────

function buildScored(
  catalog: CatalogRecipe[],
  saved: SavedRecipe[],
  favs: Set<string>,
  pantryIng: ReturnType<typeof ingredientsFromPantry>,
  hasPantry: boolean,
  seed: number,
): Scored[] {
  const items: FeedRecipe[] = [];
  for (const r of saved) if (r.favorite) items.push({ kind: "saved", recipe: r, favorite: true });
  for (const c of catalog) items.push({ kind: "catalog", id: c.id, recipe: c, favorite: favs.has(c.id) });

  const scored = items.map<Scored>((fi) => {
    const recipe = fi.recipe;
    const cov = hasPantry ? computeCoverage(recipe, pantryIng) : null;
    let score = 0;
    if (cov) score += cov.score; // -1..1, dominant signal when a pantry exists
    if (fi.favorite) score += 0.4;
    if (recipe.cookTime > 0 && recipe.cookTime <= 30) score += 0.1;
    if (cov && cov.total > 0 && cov.missing === 0) score += 0.3;
    return { fi, cov, score, reason: reasonFor(fi, cov) };
  });
  // Tiebreak on a per-recipe seeded hash, NOT the title. A title tiebreak makes
  // equal-scored recipes sort alphabetically, so when scores are flat (no
  // pantry) the whole top of the list is "A" recipes and the hero rotation
  // loops through them. The hash scatters equal-scored items across the
  // catalog, and folding in the daily seed reshuffles them once a day.
  return scored.sort((a, b) => b.score - a.score || shuffleKey(a.fi, seed) - shuffleKey(b.fi, seed));
}

/** Stable FNV-1a hash of the recipe key mixed with a seed → a uint32 sort key. */
function shuffleKey(fi: FeedRecipe, seed: number): number {
  const str = `${keyOf(fi)}:${seed}`;
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function reasonFor(fi: FeedRecipe, cov: CoverageResult | null): string {
  if (cov && cov.total > 0 && cov.missing === 0) return "You have everything for this.";
  if (cov && cov.have > 0) {
    const need = cov.missing === 1 ? "1 thing" : `${cov.missing} things`;
    return `You have ${cov.have} of ${cov.total} ingredients. Just ${need} to grab.`;
  }
  if (fi.favorite) return "One of your favorites, worth revisiting.";
  if (fi.recipe.cookTime > 0 && fi.recipe.cookTime <= 20) return `Quick: on the table in ${fi.recipe.cookTime} minutes.`;
  if (fi.kind === "catalog") return `A ${fi.recipe.category.toLowerCase()} idea worth a try.`;
  return "Worth a try tonight.";
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function tagline(favCount: number, ready: number, hasPantry: boolean): string {
  if (hasPantry && ready > 0) return `${ready} recipe${ready === 1 ? "" : "s"} you can make right now.`;
  if (favCount > 0) return "Here's what's cooking.";
  return "Let's find something to cook.";
}

/** Day index for the daily-rotating hero seed (browser Date; not the workflow sandbox). */
function daySeed(): number {
  return Math.floor(new Date().getTime() / 86_400_000);
}

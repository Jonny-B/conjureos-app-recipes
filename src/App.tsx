import { useCallback, useEffect, useRef, useState } from "react";
import type { Ingredient, PantryItem, Recipe, RecipeSource } from "./types";
import { RecipesScreen } from "./screens/RecipesScreen";
import { CreateScreen } from "./screens/CreateScreen";
import { SnapRecipeScreen } from "./screens/SnapRecipeScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { RecipesBrowseScreen } from "./screens/RecipesBrowseScreen";
import { PantryScreen } from "./screens/PantryScreen";
import { PlanWeekScreen } from "./screens/PlanWeekScreen";
import { generateRecipes } from "./features/recipes";
import { registerActions } from "./bridge/actions";
import { ensureCatalogLoaded } from "./features/catalog";
import { loadPantry, ingredientsFromPantry } from "./features/pantry";
import { getUSDAUsage, type USDAUsageSnapshot } from "./features/nutrition";
import { Icon } from "./icons";
import { APP_VERSION } from "./version";

type Tab = "home" | "cook" | "recipes" | "plan";
// Cook is the kitchen hub: "kitchen" merges the old Pantry tab + fridge-scan
// (what you have -> cook from it); snap/write add a recipe to your library.
type CookMode = "kitchen" | "snap" | "write";

const TABS: { id: Tab; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "cook", label: "Cook" },
  { id: "recipes", label: "Recipes" },
  { id: "plan", label: "Plan" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("home");
  // The Recipes tab's source filter and the Cook tab's mode are lifted here so
  // other surfaces can deep-link into them (Home's "favorites" + a "New recipe"
  // shortcut that drops straight into Cook -> Write your own).
  const [recipeSource, setRecipeSource] = useState<RecipeSource>("all");
  const [cookMode, setCookMode] = useState<CookMode>("kitchen");
  const [pantry, setPantry] = useState<PantryItem[] | null>(null);
  // Bumped once the catalog is (re)loaded from the DB so the catalog-reading
  // screens re-run their memoized decode. Starts on the bundled copy, which
  // renders instantly and stays the offline fallback.
  const [catalogVersion, setCatalogVersion] = useState(0);

  // Register cross-app action handlers once on boot, load the persistent
  // pantry so the Recipes feed can rank against it the moment the user opens
  // that tab, and refresh the catalog from the DB (the bundled copy is the
  // instant baseline). Each failure is non-fatal: the app stays usable, only
  // that one integration is degraded.
  useEffect(() => {
    registerActions().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[recipes] action registration failed:", err);
    });
    loadPantry()
      .then(setPantry)
      .catch(() => setPantry([]));
    ensureCatalogLoaded()
      .then((changed) => {
        if (changed) setCatalogVersion((v) => v + 1);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>
          <Icon name="utensils" className="brand-icon" />
          Recipes
        </h1>
        <div className="header-spacer" />
        <nav className="app-nav">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`nav-btn${tab === t.id ? " active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
          <InfoButton />
        </nav>
      </header>
      <main className="app-body">
        {tab === "home" && (
          <HomeScreen
            pantry={pantry}
            onNavigate={setTab}
            onViewFavorites={() => {
              setRecipeSource("favorites");
              setTab("recipes");
            }}
            catalogVersion={catalogVersion}
          />
        )}
        {tab === "cook" && (
          <CookTab
            mode={cookMode}
            onModeChange={setCookMode}
            pantry={pantry}
            onPantryChange={setPantry}
            onBrowse={() => setTab("recipes")}
          />
        )}
        {tab === "recipes" && (
          <RecipesBrowseScreen
            source={recipeSource}
            onSourceChange={setRecipeSource}
            pantry={pantry}
            onOpenPantry={() => {
              setCookMode("kitchen");
              setTab("cook");
            }}
            onNewRecipe={() => {
              setCookMode("write");
              setTab("cook");
            }}
            catalogVersion={catalogVersion}
          />
        )}
        {tab === "plan" && <PlanWeekScreen pantry={pantry} catalogVersion={catalogVersion} />}
      </main>
      <footer className="app-version">v{APP_VERSION}</footer>
    </div>
  );
}

/**
 * The Cook tab is the "kitchen" hub. Its default mode merges what used to be
 * two separate destinations — the Pantry tab and the fridge-scan flow — into
 * one place: keep what you have on hand, scan to add to it, then cook from it
 * (AI-generate three recipes) or browse what you can make. "Snap a recipe" and
 * "Write your own" add a recipe to your library.
 */
function CookTab({
  mode,
  onModeChange,
  pantry,
  onPantryChange,
  onBrowse,
}: {
  mode: CookMode;
  onModeChange: (m: CookMode) => void;
  pantry: PantryItem[] | null;
  onPantryChange: (items: PantryItem[]) => void;
  onBrowse: () => void;
}) {
  // "Cook from my pantry" sub-flow, seeded from the pantry rather than a fresh
  // scan (the pantry IS the list of what you have now).
  const [cook, setCook] = useState<
    | { kind: "idle" }
    | { kind: "generating"; ingredients: Ingredient[] }
    | { kind: "recipes"; ingredients: Ingredient[]; recipes: Recipe[] }
  >({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);

  const cookFromPantry = useCallback(async () => {
    const ingredients = ingredientsFromPantry(pantry ?? []);
    if (ingredients.length === 0) return;
    setError(null);
    setCook({ kind: "generating", ingredients });
    try {
      const recipes = await generateRecipes(ingredients);
      setCook({ kind: "recipes", ingredients, recipes });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCook({ kind: "idle" });
    }
  }, [pantry]);

  return (
    <>
      <div className="feed-toolbar">
        <button
          className={`nav-btn${mode === "kitchen" ? " active" : ""}`}
          onClick={() => onModeChange("kitchen")}
        >
          <Icon name="carrot" /> My kitchen
        </button>
        <button
          className={`nav-btn${mode === "snap" ? " active" : ""}`}
          onClick={() => onModeChange("snap")}
        >
          <Icon name="images" /> Snap a recipe
        </button>
        <button
          className={`nav-btn${mode === "write" ? " active" : ""}`}
          onClick={() => onModeChange("write")}
        >
          <Icon name="pen" /> Write your own
        </button>
      </div>

      {error && mode === "kitchen" && (
        <div className="status-banner error" style={{ marginBottom: 16 }}>
          <Icon name="wand" />
          <span>{error}</span>
          <div style={{ flex: 1 }} />
          <button className="btn ghost" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {mode === "write" ? (
        <CreateScreen />
      ) : mode === "snap" ? (
        <SnapRecipeScreen />
      ) : cook.kind === "generating" ? (
        <FullscreenSpinner label="Cooking up recipes…" sub="Three options from what you have. ~10 seconds." />
      ) : cook.kind === "recipes" ? (
        <RecipesScreen
          recipes={cook.recipes}
          ingredients={cook.ingredients}
          onEditIngredients={() => setCook({ kind: "idle" })}
          onRestart={() => setCook({ kind: "idle" })}
        />
      ) : (
        <PantryScreen
          pantry={pantry}
          onChange={onPantryChange}
          onCook={cookFromPantry}
          onBrowse={onBrowse}
        />
      )}
    </>
  );
}

function FullscreenSpinner({ label, sub }: { label: string; sub?: string }) {
  return (
    <div className="center-spinner">
      <div className="spinner" />
      <div style={{ fontWeight: 500 }}>{label}</div>
      {sub && <div className="muted" style={{ fontSize: 13 }}>{sub}</div>}
    </div>
  );
}

/**
 * Small "i" button in the header that opens a popover with: app version,
 * USDA quota remaining, and a one-line explanation of what the quota is.
 * Designed to stay out of the way — collapsed by default, opens on
 * click, closes on outside-click or Escape. Doesn't block any other
 * interaction in the app.
 */
function InfoButton() {
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<USDAUsageSnapshot>(() => getUSDAUsage());
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Refresh the USDA snapshot every 5s while the popover is open. The
  // sliding-window count changes over time as old timestamps age out of
  // the rolling hour — polling beats trying to subscribe to a counter
  // we don't event-source.
  useEffect(() => {
    if (!open) return;
    setUsage(getUSDAUsage());
    const t = setInterval(() => setUsage(getUSDAUsage()), 5000);
    return () => clearInterval(t);
  }, [open]);

  // Close on outside-click + Escape so the popover doesn't trap focus.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Time remaining until the rate-limit short-circuit clears, if active.
  // Updated alongside the snapshot poll.
  const rateLimitClearsIn = usage.rateLimited
    ? Math.max(0, Math.ceil((usage.rateLimitedUntil - Date.now()) / 60_000))
    : null;

  return (
    <div className="info-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`info-btn${open ? " active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-label="App info"
        title="App info"
        aria-expanded={open}
      >
        <Icon name="circle-info" />
      </button>
      {open && (
        <div className="info-popover" role="dialog" aria-label="App info">
          <div className="info-row">
            <span className="info-label">Version</span>
            <span className="info-value mono">{APP_VERSION}</span>
          </div>
          <div className="info-divider" />
          <div className="info-row">
            <span className="info-label">Nutrition</span>
            <span className="info-value">USDA food database</span>
          </div>
          {usage.tierKnown && (
            <div className="info-row">
              <span className="info-label">Lookups this hour</span>
              <span className="info-value mono">
                ~{usage.recentInLastHour} / {usage.approxLimit}
              </span>
            </div>
          )}
          {usage.rateLimited ? (
            <p className="info-help warn">
              The hourly nutrition limit was reached. Recipes still work; some
              calorie and macro numbers fill in again in ~{rateLimitClearsIn} min.
            </p>
          ) : (
            <p className="info-help">
              {usage.tierKnown
                ? "Calorie and macro estimates come from the free USDA food database, which limits how many lookups happen per hour. You're well within it."
                : "Calorie and macro estimates come from the free USDA food database. Your hourly usage shows here once you generate your first recipe."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

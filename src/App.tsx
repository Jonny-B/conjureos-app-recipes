import { useCallback, useEffect, useRef, useState } from "react";
import type { CapturedPhoto, Ingredient, PantryItem, Recipe, Screen } from "./types";
import { CaptureScreen } from "./screens/CaptureScreen";
import { IngredientsScreen } from "./screens/IngredientsScreen";
import { RecipesScreen } from "./screens/RecipesScreen";
import { CreateScreen } from "./screens/CreateScreen";
import { RecipesBrowseScreen } from "./screens/RecipesBrowseScreen";
import { PantryScreen } from "./screens/PantryScreen";
import { identifyIngredients } from "./features/vision";
import { generateRecipes } from "./features/recipes";
import { registerActions } from "./bridge/actions";
import { loadPantry } from "./features/pantry";
import { getUSDAUsage, type USDAUsageSnapshot } from "./features/nutrition";
import { Icon } from "./icons";
import { APP_VERSION } from "./version";

type Tab = "cook" | "recipes" | "favorites" | "pantry" | "plan";

const TABS: { id: Tab; label: string }[] = [
  { id: "cook", label: "Cook" },
  { id: "recipes", label: "Recipes" },
  { id: "favorites", label: "Favorites" },
  { id: "pantry", label: "Pantry" },
  { id: "plan", label: "Plan" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("cook");
  const [pantry, setPantry] = useState<PantryItem[] | null>(null);

  // Register cross-app action handlers once on boot, and load the persistent
  // pantry so the Recipes feed can rank against it the moment the user opens
  // that tab. Registration failure is non-fatal: the app stays usable, only
  // the cross-app integrations break.
  useEffect(() => {
    registerActions().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[recipes] action registration failed:", err);
    });
    loadPantry()
      .then(setPantry)
      .catch(() => setPantry([]));
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
        {tab === "cook" && <CookTab />}
        {tab === "recipes" && (
          <RecipesBrowseScreen mode="browse" pantry={pantry} onOpenPantry={() => setTab("pantry")} />
        )}
        {tab === "favorites" && (
          <RecipesBrowseScreen mode="favorites" pantry={pantry} onOpenPantry={() => setTab("pantry")} />
        )}
        {tab === "pantry" && <PantryScreen pantry={pantry} onChange={setPantry} />}
        {tab === "plan" && <PlanPlaceholder />}
      </main>
      <footer className="app-version">v{APP_VERSION}</footer>
    </div>
  );
}

/**
 * The Cook tab hosts the original scan-to-recipe flow plus a "Write your own"
 * mode (the former Create tab, folded in here to keep the top nav to five
 * primary destinations without dropping the feature).
 */
function CookTab() {
  const [mode, setMode] = useState<"scan" | "write">("scan");
  const [screen, setScreen] = useState<Screen>({ kind: "capture" });
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setScreen({ kind: "capture" });
    setError(null);
  }, []);

  // Back one step: recipes -> ingredients, preserving photos + confirmed
  // ingredients so the user can tweak without re-shooting or regenerating.
  const editIngredients = useCallback(
    (photos: CapturedPhoto[], ingredients: Ingredient[]) => {
      setError(null);
      setScreen({ kind: "ingredients", photos, ingredients });
    },
    [],
  );

  const onIdentify = useCallback(async (photos: CapturedPhoto[]) => {
    setError(null);
    setScreen({ kind: "identifying", photos });
    try {
      const ingredients = await identifyIngredients(photos);
      setScreen({ kind: "ingredients", photos, ingredients });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setScreen({ kind: "capture" });
    }
  }, []);

  const onIngredientsConfirmed = useCallback(
    async (photos: CapturedPhoto[], ingredients: Ingredient[]) => {
      setError(null);
      setScreen({ kind: "generating", photos, ingredients });
      try {
        const recipes = await generateRecipes(ingredients);
        setScreen({ kind: "recipes", photos, ingredients, recipes });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setScreen({ kind: "ingredients", photos, ingredients });
      }
    },
    [],
  );

  return (
    <>
      <div className="feed-toolbar">
        <button
          className={`nav-btn${mode === "scan" ? " active" : ""}`}
          onClick={() => setMode("scan")}
        >
          <Icon name="camera" /> Scan fridge
        </button>
        <button
          className={`nav-btn${mode === "write" ? " active" : ""}`}
          onClick={() => setMode("write")}
        >
          <Icon name="pen" /> Write your own
        </button>
      </div>

      {error && mode === "scan" && (
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
      ) : (
        <BuildPane
          screen={screen}
          onIdentify={onIdentify}
          onIngredientsConfirmed={onIngredientsConfirmed}
          onEditIngredients={editIngredients}
          onReset={reset}
        />
      )}
    </>
  );
}

function PlanPlaceholder() {
  return (
    <div className="empty-state">
      <Icon name="calendar-days" className="empty-icon" />
      <div>Plan My Week is coming together. Hang tight.</div>
    </div>
  );
}

interface BuildPaneProps {
  screen: Screen;
  onIdentify: (photos: CapturedPhoto[]) => void;
  onIngredientsConfirmed: (photos: CapturedPhoto[], ingredients: Ingredient[]) => void;
  onEditIngredients: (photos: CapturedPhoto[], ingredients: Ingredient[]) => void;
  onReset: () => void;
}

function BuildPane({ screen, onIdentify, onIngredientsConfirmed, onEditIngredients, onReset }: BuildPaneProps) {
  switch (screen.kind) {
    case "capture":
      return <CaptureScreen onIdentify={onIdentify} />;
    case "identifying":
      return (
        <FullscreenSpinner
          label={`Looking at ${screen.photos.length} photo${screen.photos.length === 1 ? "" : "s"}…`}
          sub="Identifying + deduping ingredients with Claude. ~5-10 seconds."
        />
      );
    case "ingredients":
      return (
        <IngredientsScreen
          photos={screen.photos}
          initialIngredients={screen.ingredients}
          onConfirm={(items) => onIngredientsConfirmed(screen.photos, items)}
          onRetake={onReset}
        />
      );
    case "generating":
      return <FullscreenSpinner label="Cooking up recipes…" sub="Generating three options. ~10 seconds." />;
    case "recipes":
      return (
        <RecipesScreen
          recipes={screen.recipes as Recipe[]}
          ingredients={screen.ingredients}
          onEditIngredients={() => onEditIngredients(screen.photos, screen.ingredients)}
          onRestart={onReset}
        />
      );
  }
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

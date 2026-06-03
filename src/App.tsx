import { useCallback, useEffect, useRef, useState } from "react";
import type { CapturedPhoto, Ingredient, Recipe, Screen } from "./types";
import { CaptureScreen } from "./screens/CaptureScreen";
import { IngredientsScreen } from "./screens/IngredientsScreen";
import { RecipesScreen } from "./screens/RecipesScreen";
import { BrowseScreen } from "./screens/BrowseScreen";
import { identifyIngredients } from "./features/vision";
import { generateRecipes } from "./features/recipes";
import { registerActions } from "./bridge/actions";
import { getUSDAUsage, type USDAUsageSnapshot } from "./features/nutrition";
import { APP_VERSION } from "./version";

type Tab = "build" | "browse";

export function App() {
  const [tab, setTab] = useState<Tab>("build");
  const [screen, setScreen] = useState<Screen>({ kind: "capture" });
  const [error, setError] = useState<string | null>(null);

  // Register cross-app action handlers once on boot. Other apps (calorie
  // tracker, meal planner, shopping list, etc.) can invoke these via
  // window.__conjureos.actions.invoke('/apps/recipes', actionName, params).
  // Failure to register is non-fatal — the app stays usable, only the
  // cross-app integrations break.
  useEffect(() => {
    registerActions().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[recipes] action registration failed:", err);
    });
  }, []);

  const reset = useCallback(() => {
    setScreen({ kind: "capture" });
    setError(null);
  }, []);

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
    <div className="app">
      <header className="app-header">
        <h1>Recipes</h1>
        <div className="header-spacer" />
        <nav className="app-nav">
          <button
            className={`nav-btn${tab === "build" ? " active" : ""}`}
            onClick={() => setTab("build")}
          >
            Cook now
          </button>
          <button
            className={`nav-btn${tab === "browse" ? " active" : ""}`}
            onClick={() => setTab("browse")}
          >
            Saved
          </button>
          <InfoButton />
        </nav>
      </header>
      <main className="app-body">
        {error && (
          <div className="status-banner error" style={{ marginBottom: 16 }}>
            <span>⚠</span>
            <span>{error}</span>
            <div style={{ flex: 1 }} />
            <button className="btn ghost" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        {tab === "browse" ? (
          <BrowseScreen />
        ) : (
          <BuildPane
            screen={screen}
            onIdentify={onIdentify}
            onIngredientsConfirmed={onIngredientsConfirmed}
            onReset={reset}
          />
        )}
      </main>
      <footer className="app-version">v{APP_VERSION}</footer>
    </div>
  );
}

interface BuildPaneProps {
  screen: Screen;
  onIdentify: (photos: CapturedPhoto[]) => void;
  onIngredientsConfirmed: (photos: CapturedPhoto[], ingredients: Ingredient[]) => void;
  onReset: () => void;
}

function BuildPane({ screen, onIdentify, onIngredientsConfirmed, onReset }: BuildPaneProps) {
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
          onRestart={onReset}
        />
      );
    case "browse":
      return <BrowseScreen />;
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
        i
      </button>
      {open && (
        <div className="info-popover" role="dialog" aria-label="App info">
          <div className="info-row">
            <span className="info-label">Version</span>
            <span className="info-value mono">{APP_VERSION}</span>
          </div>
          <div className="info-divider" />
          <div className="info-row">
            <span className="info-label">USDA nutrition</span>
            <span className="info-value">
              {usage.usingDemoKey ? "Shared demo key" : "ConjureOS key"}
            </span>
          </div>
          <div className="info-row">
            <span className="info-label">Used this hour</span>
            <span className="info-value mono">
              ~{usage.recentInLastHour} / {usage.approxLimit}
            </span>
          </div>
          {usage.rateLimited ? (
            <p className="info-help warn">
              Hit the cap. Nutrition lookups pause for ~{rateLimitClearsIn} min,
              then resume. Recipes still generate; macros just stay blank.
            </p>
          ) : (
            <p className="info-help">
              {usage.usingDemoKey
                ? "Nutrition runs through a ConjureOS proxy on USDA's shared demo key — ~30 lookups/hr across everyone on this instance. Hit the cap? Recipes still generate; macros stay blank until it clears."
                : "Nutrition runs through a ConjureOS proxy on a registered USDA key — ~1000 lookups/hr."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

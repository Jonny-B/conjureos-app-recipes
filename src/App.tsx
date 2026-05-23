import { useCallback, useEffect, useState } from "react";
import type { CapturedPhoto, Ingredient, Recipe, Screen } from "./types";
import { CaptureScreen } from "./screens/CaptureScreen";
import { IngredientsScreen } from "./screens/IngredientsScreen";
import { RecipesScreen } from "./screens/RecipesScreen";
import { BrowseScreen } from "./screens/BrowseScreen";
import { identifyIngredients } from "./features/vision";
import { generateRecipes } from "./features/recipes";
import { registerActions } from "./bridge/actions";

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

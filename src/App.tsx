import { useCallback, useState } from "react";
import type { Ingredient, Recipe, Screen } from "./types";
import { CaptureScreen } from "./screens/CaptureScreen";
import { IngredientsScreen } from "./screens/IngredientsScreen";
import { RecipesScreen } from "./screens/RecipesScreen";
import { BrowseScreen } from "./screens/BrowseScreen";
import { identifyIngredients } from "./features/vision";
import { generateRecipes } from "./features/recipes";

type Tab = "build" | "browse";

export function App() {
  const [tab, setTab] = useState<Tab>("build");
  const [screen, setScreen] = useState<Screen>({ kind: "capture" });
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setScreen({ kind: "capture" });
    setError(null);
  }, []);

  const onPhotoSelected = useCallback(async (photoDataUrl: string) => {
    setError(null);
    setScreen({ kind: "identifying", photoDataUrl });
    try {
      const ingredients = await identifyIngredients(photoDataUrl);
      setScreen({ kind: "ingredients", photoDataUrl, ingredients });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setScreen({ kind: "capture" });
    }
  }, []);

  const onIngredientsConfirmed = useCallback(
    async (photoDataUrl: string, ingredients: Ingredient[]) => {
      setError(null);
      setScreen({ kind: "generating", photoDataUrl, ingredients });
      try {
        const recipes = await generateRecipes(ingredients);
        setScreen({ kind: "recipes", photoDataUrl, ingredients, recipes });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setScreen({ kind: "ingredients", photoDataUrl, ingredients });
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
            onPhotoSelected={onPhotoSelected}
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
  onPhotoSelected: (dataUrl: string) => void;
  onIngredientsConfirmed: (dataUrl: string, ingredients: Ingredient[]) => void;
  onReset: () => void;
}

function BuildPane({ screen, onPhotoSelected, onIngredientsConfirmed, onReset }: BuildPaneProps) {
  switch (screen.kind) {
    case "capture":
      return <CaptureScreen onPhoto={onPhotoSelected} />;
    case "identifying":
      return <FullscreenSpinner label="Looking at your fridge…" sub="Identifying ingredients with Claude. ~5 seconds." />;
    case "ingredients":
      return (
        <IngredientsScreen
          photoDataUrl={screen.photoDataUrl}
          initialIngredients={screen.ingredients}
          onConfirm={(items) => onIngredientsConfirmed(screen.photoDataUrl, items)}
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

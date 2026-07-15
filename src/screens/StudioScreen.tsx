import { useCallback, useEffect, useState } from "react";
import type { CatalogRecipe } from "../types";
import { fetchChefLatest } from "../bridge/recipesApi";
import { CreateScreen } from "./CreateScreen";
import { SnapRecipeScreen } from "./SnapRecipeScreen";
import { RecipeEditor } from "../components/RecipeEditor";
import { RecipeRow } from "../components/RecipeRow";
import { Icon } from "../icons";

export const CHEF_NAME = "Chef Payson";

type Mode =
  | { kind: "list" }
  | { kind: "write" }
  | { kind: "snap" }
  | { kind: "edit"; recipe: CatalogRecipe };

/**
 * Chef Payson's private Studio (only mounted when whoami().isChef). His space to
 * publish promoted recipes — via the shared manual/snap create flows in chef
 * mode — each with an optional long-form blog. Publishing marks the recipe
 * chef_featured + public server-side, so it surfaces app-wide as his newest.
 */
export function StudioScreen() {
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [posts, setPosts] = useState<CatalogRecipe[] | null>(null);

  const refresh = useCallback(() => {
    fetchChefLatest(50)
      .then(setPosts)
      .catch(() => setPosts([]));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const backToList = () => {
    setMode({ kind: "list" });
    refresh();
  };

  if (mode.kind === "write" || mode.kind === "snap" || mode.kind === "edit") {
    return (
      <div className="create-screen">
        <div className="detail-actions">
          <button className="btn ghost" onClick={backToList}>
            <Icon name="chevron-down" className="back-caret" /> Studio
          </button>
        </div>
        {mode.kind === "write" && <CreateScreen chefMode onPublished={refresh} />}
        {mode.kind === "snap" && <SnapRecipeScreen chefMode onPublished={refresh} />}
        {mode.kind === "edit" && (
          <RecipeEditor
            initial={mode.recipe}
            editId={mode.recipe.id}
            chefMode
            onPublished={refresh}
            onStartOver={backToList}
            startOverLabel="Back to Studio"
          />
        )}
      </div>
    );
  }

  return (
    <div className="studio-screen">
      <div className="studio-hero">
        <span className="studio-badge"><Icon name="utensils" /></span>
        <div>
          <h2 style={{ margin: 0 }}>{CHEF_NAME}'s Studio</h2>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
            Publish a recipe and it goes out to everyone as "{CHEF_NAME}'s newest recipe."
            Add an optional story readers can scroll through.
          </p>
        </div>
      </div>

      <div className="capture-buttons" style={{ justifyContent: "flex-start", marginTop: 16 }}>
        <button className="btn" onClick={() => setMode({ kind: "write" })}>
          <Icon name="pen" /> Write a recipe
        </button>
        <button className="btn secondary" onClick={() => setMode({ kind: "snap" })}>
          <Icon name="camera" /> Snap a recipe
        </button>
      </div>

      <h3 style={{ marginBottom: 8 }}>Your published recipes</h3>
      {posts === null ? (
        <div className="center-spinner"><div className="spinner" /></div>
      ) : posts.length === 0 ? (
        <div className="empty-state">
          <Icon name="bowl-food" className="empty-icon" />
          <div>No recipes published yet. Write or snap your first one above.</div>
        </div>
      ) : (
        <div className="browse-list">
          {posts.map((r) => (
            <RecipeRow
              key={r.id}
              fi={{ kind: "catalog", id: r.id, recipe: r, favorite: false }}
              onOpen={() => setMode({ kind: "edit", recipe: r })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

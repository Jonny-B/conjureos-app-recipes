import { useState } from "react";
import type { CapturedPhoto, Recipe } from "../types";
import { extractRecipeFromPhotos } from "../features/customRecipe";
import { CaptureScreen } from "./CaptureScreen";
import { RecipeEditor } from "../components/RecipeEditor";
import { Icon } from "../icons";

/**
 * Snap a recipe: photograph an existing recipe (a card, cookbook page,
 * handwritten note, screenshot) and the vision model transcribes it into a
 * structured recipe. The user lands on the shared RecipeEditor to check the
 * transcription, fix any line by hand, optionally AI-tidy, and save to their
 * recipe library. Distinct from "Scan fridge", which reads ingredients to
 * generate brand-new recipes.
 */
export function SnapRecipeScreen({
  chefMode = false,
  onPublished,
}: {
  chefMode?: boolean;
  onPublished?: () => void;
} = {}) {
  const [stage, setStage] = useState<"capture" | "reading" | "editing">("capture");
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  // Bumped per extraction so the RecipeEditor remounts on a re-snap.
  const [nonce, setNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Retained across the read round trip: setStage unmounts CaptureScreen, so a
  // failed extraction used to send the user back to an empty tray — having to
  // re-photograph a cookbook page because the model returned bad JSON.
  const [lastPhotos, setLastPhotos] = useState<CapturedPhoto[]>([]);

  const onPhotos = async (photos: CapturedPhoto[]) => {
    setError(null);
    setLastPhotos(photos);
    setStage("reading");
    try {
      const r = await extractRecipeFromPhotos(photos);
      setRecipe(r);
      setNonce((n) => n + 1);
      setLastPhotos([]);
      setStage("editing");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("capture");
    }
  };

  const reset = () => {
    setRecipe(null);
    setError(null);
    setStage("capture");
  };

  if (stage === "reading") {
    return (
      <div className="center-spinner">
        <div className="spinner" />
        <div style={{ fontWeight: 500 }}>Reading the recipe…</div>
        <div className="muted" style={{ fontSize: 13 }}>
          Transcribing it from your photo with Claude. ~10 seconds.
        </div>
      </div>
    );
  }

  if (stage === "editing" && recipe) {
    return (
      <div className="create-screen">
        <div className="muted" style={{ fontSize: 13 }}>
          Transcribed from your photo. Check it over, fix any line, then save.
        </div>
        <RecipeEditor
          key={nonce}
          initial={recipe}
          onStartOver={reset}
          startOverLabel="Snap another"
          chefMode={chefMode}
          onPublished={onPublished}
        />
      </div>
    );
  }

  return (
    <>
      {error && (
        <div className="status-banner error" style={{ marginBottom: 16 }}>
          <Icon name="triangle-exclamation" />
          <span>{error}</span>
        </div>
      )}
      <CaptureScreen
        onIdentify={onPhotos}
        initialPhotos={lastPhotos}
        title="Snap a recipe"
        emptyHint="Photograph or upload a recipe: a recipe card, a cookbook or magazine page, a handwritten note, or a screenshot. I'll read it and turn it into a saved recipe you can edit."
        moreHint="Multi-page recipe? Add a shot of each page (ingredients, then method) and I'll merge them into one."
        actionLabel={(n) => `Read recipe from ${n} photo${n === 1 ? "" : "s"} →`}
      />
    </>
  );
}

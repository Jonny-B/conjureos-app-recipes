import type { FeedRecipe } from "../types";
import { categoryOf, keyIngredients, lookFor } from "../features/recipeLook";
import { DifficultyMark, RecipePlate } from "./RecipePlate";
import { Icon } from "../icons";

/**
 * One recipe row for the browse and favourites feeds: the plate (or photo),
 * the title, what's in it, and one quiet meta line.
 *
 * It used to be a title over a row of capsules — DINNER, EASY — repeated
 * 1,120 times, which made the feed read as a directory listing. What a row
 * needs to answer is "what is this dish?", and the ingredients answer that
 * better than a category chip does, so they get the second line and the
 * category drops to a coloured word in the meta line.
 *
 * It used to take a `cov` and draw have/short/missing chips against the pantry.
 * That moved to Conjure Pantry with the pantry, and `CoverageChips` went with
 * it rather than being left here with no caller.
 */
export function RecipeRow({
  fi,
  onOpen,
}: {
  fi: FeedRecipe;
  onOpen: () => void;
}) {
  const r = fi.recipe;
  const category = categoryOf(fi);
  const keys = keyIngredients(fi);
  return (
    // A button, not a div-with-onClick: every recipe row in the app is this
    // component, so the whole feed was keyboard-unreachable. `type="button"`
    // matters because these do appear inside forms.
    <button type="button" className="browse-item" onClick={onOpen}>
      <RecipePlate recipe={r} category={category} variant="tile" />
      <div className="title-block">
        <div className="title">
          {r.title}
          {fi.favorite && <Icon name="heart" className="fav-mark" />}
        </div>
        {keys.length > 0 && <div className="keys">{keys.join(" · ")}</div>}
        <div className="meta">
          <span className={`meta-cat hue-${lookFor(category).hue}`}>{category ?? "My recipe"}</span>
          {/* The USDA corpus carries no times, so an unguarded "{cookTime} min"
              prints "0 min" on all 1,120 rows. Guarded at every call site. */}
          {r.cookTime > 0 && <span>{r.cookTime} min</span>}
          {r.nutrition && r.nutrition.calories > 0 && <span>~{r.nutrition.calories} cal</span>}
          {r.nutrition && r.nutrition.protein > 0 && <span>{r.nutrition.protein}g protein</span>}
          {fi.kind === "saved" && fi.recipe.madeCount > 0 && <span>made {fi.recipe.madeCount}×</span>}
          <DifficultyMark recipe={r} />
        </div>
      </div>
    </button>
  );
}

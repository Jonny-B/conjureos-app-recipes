import type { FeedRecipe } from "../types";
import { RECIPE_PHOTOS_ENABLED } from "../features/flags";
import { Icon } from "../icons";

/**
 * One dense recipe row for the browse and favourites feeds. Title, meta and a
 * favourite mark.
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
  const category = fi.kind === "catalog" ? fi.recipe.category : null;
  return (
    // A button, not a div-with-onClick: every recipe row in the app is this
    // component, so the whole feed was keyboard-unreachable. `type="button"`
    // matters because these do appear inside forms.
    <button type="button" className="browse-item" onClick={onOpen}>
      {RECIPE_PHOTOS_ENABLED && r.imageUrl && (
        <div className="browse-thumb">
          <img src={r.imageUrl} alt="" loading="lazy" />
        </div>
      )}
      <div className="title-block">
        <div className="title">
          {r.title}
          {fi.favorite && <Icon name="heart" className="fav-mark" />}
        </div>
        <div className="meta">
          {category && (
            <>
              <span className="pill cat">{category}</span>{" "}
            </>
          )}
          <span className={`pill ${r.difficulty}`}>{r.difficulty}</span>
          {/* The USDA corpus carries no times, so an unguarded "{cookTime} min"
              prints "0 min" on all 1,120 rows. Guarded at every call site. */}
          {r.cookTime > 0 && ` · ${r.cookTime} min`}
          {r.nutrition && ` · ~${r.nutrition.calories} cal`}
          {fi.kind === "saved" && " · saved"}
        </div>
      </div>
    </button>
  );
}

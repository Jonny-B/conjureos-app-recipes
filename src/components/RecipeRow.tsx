import type { FeedRecipe } from "../types";
import type { CoverageResult } from "../features/scaling";
import { prettyIngredient } from "../features/scaling";
import { RECIPE_PHOTOS_ENABLED } from "../features/flags";
import { Icon } from "../icons";

/**
 * One dense recipe row for the browse / favorites / home feeds. Shows title,
 * meta, a favorite mark, and (when a coverage result is supplied) compact
 * mint/amber/coral chips for have / short / missing against the pantry.
 */
export function RecipeRow({
  fi,
  cov,
  onOpen,
}: {
  fi: FeedRecipe;
  cov?: CoverageResult;
  onOpen: () => void;
}) {
  const r = fi.recipe;
  const category = fi.kind === "catalog" ? fi.recipe.category : null;
  return (
    <div className="browse-item" onClick={onOpen}>
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
          {" · "}
          {r.cookTime} min
          {r.nutrition && ` · ~${r.nutrition.calories} cal`}
          {fi.kind === "saved" && " · saved"}
        </div>
        {cov && <CoverageChips cov={cov} />}
      </div>
    </div>
  );
}

export function CoverageChips({ cov }: { cov: CoverageResult }) {
  // `total === 0` means we couldn't read the recipe's ingredients at all, not
  // that you own all of them — the same misread that made the nutrition strip
  // claim a confident estimate off zero matches. Rendering it drew a green
  // "0/0 have — complete" badge on every unopened catalog recipe.
  if (cov.total === 0) return null;
  const chips = [
    ...cov.missingNames.map((n) => ({ t: "miss" as const, n })),
    ...cov.shortNames.map((n) => ({ t: "short" as const, n })),
  ];
  const shown = chips.slice(0, 3);
  const extra = chips.length - shown.length;
  return (
    <div className="cov-strip">
      <span className={`cov-chip${cov.missing === 0 ? " complete" : ""}`}>
        {cov.have}/{cov.total} have
      </span>
      {shown.map((c, i) => (
        <span key={i} className={c.t === "miss" ? "miss-chip" : "short-chip"}>
          {prettyIngredient(c.n)}
          {c.t === "short" ? " low" : ""}
        </span>
      ))}
      {extra > 0 && <span className="more-chip">+{extra} more</span>}
    </div>
  );
}

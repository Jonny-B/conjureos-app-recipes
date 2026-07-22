import type { FeedRecipe } from "../types";
import type { CoverageResult } from "../features/scaling";
import { prettyIngredient } from "../features/scaling";
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
      {r.imageUrl && (
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

/**
 * "You left something on the hob."
 *
 * The guided cook persists its session (ticked steps, gathered ingredients, a
 * scale factor) with a 12h TTL, and there is no Cook tab in the bottom bar to
 * get back to it from — so without this banner a persisted session would
 * survive and still be unreachable. It lived on the old Home screen; Home is
 * gone, so it lives here and the Pantry screen (the new home) renders it.
 *
 * Deliberately the first thing on the screen and deliberately quiet: it is
 * time-sensitive in a way nothing else in this app is (there is food cooking),
 * but it is a way back to something you were already doing, not a pitch.
 */
import type { SavedRecipe, Recipe } from "../types";
import { clearCookSession, type CookSession } from "../features/cookSession";
import { Icon } from "../icons";

/** "3 of 7 steps · serves 4" — enough to recognise what you're going back to. */
export function resumeSummary(s: CookSession): string {
  const total = s.recipe.instructions.length;
  const bits: string[] = [];
  if (total > 0) bits.push(`${s.steps.length} of ${total} steps`);
  else if (s.ingredients.length > 0) bits.push(`${s.ingredients.length} gathered`);
  if (s.factor !== 1) {
    const base = s.recipe.servings > 0 ? s.recipe.servings : 1;
    bits.push(`serves ${Math.max(1, Math.round(base * s.factor))}`);
  }
  return bits.join(" · ");
}

export function ResumeCook({
  session,
  saved,
  onResume,
  onForget,
}: {
  session: CookSession;
  /** The library rows, so a resumed cook can re-attach to the recipe it came from. */
  saved: SavedRecipe[];
  onResume: (recipe: Recipe, saved: SavedRecipe | null) => void;
  onForget: () => void;
}) {
  return (
    <div className="resume-cook">
      <button
        className="resume-cook-main"
        onClick={() => onResume(session.recipe, saved.find((r) => r.path === session.savedPath) ?? null)}
      >
        <Icon name="utensils" />
        <span className="resume-cook-text">
          <strong>Still cooking</strong>
          <span className="resume-cook-title">{session.recipe.title}</span>
          <span className="muted">{resumeSummary(session)}</span>
        </span>
        <Icon name="chevron-down" className="resume-cook-go" />
      </button>
      <button
        className="icon-btn"
        aria-label="Forget this cook"
        title="Forget this cook"
        onClick={() => {
          clearCookSession(session.key);
          onForget();
        }}
      >
        <Icon name="xmark" />
      </button>
    </div>
  );
}

import { useState } from "react";
import type { Recipe } from "../types";
import { RECIPE_PHOTOS_ENABLED } from "../features/flags";
import { difficultyLevel, lookFor } from "../features/recipeLook";
import { Icon } from "../icons";

/**
 * The picture slot every recipe surface has: a feed row's square tile, the
 * poster in Tonight's pick, and the cover behind an open recipe.
 *
 * With a photo (and RECIPE_PHOTOS_ENABLED) it is the photo. Without one it is
 * a PLATE: a flat field of the category's hue with the category's glyph —
 * never a grey placeholder, because the catalog has no photos today and a
 * grid of 1,120 empty frames is worse than no frames at all (see flags.ts).
 * The slot is the same box either way, so turning photos on changes what
 * fills it and nothing about the layout around it.
 *
 * A photo that fails to load falls back to the plate rather than leaving a
 * broken-image icon in the feed.
 */
export function RecipePlate({
  recipe,
  category,
  variant,
}: {
  recipe: Pick<Recipe, "imageUrl" | "title">;
  category: string | null | undefined;
  /**
   * "tile": the square in a feed row. "poster": Tonight's pick. "cover": the
   * picture the open recipe is laid over — no label or small glyph of its
   * own, because the page's pills already name the category.
   */
  variant: "tile" | "poster" | "cover";
}) {
  const [broken, setBroken] = useState(false);
  const look = lookFor(category);
  const photo = RECIPE_PHOTOS_ENABLED && recipe.imageUrl && !broken ? recipe.imageUrl : null;

  if (photo) {
    return (
      <div className={`plate plate--${variant} plate--photo`}>
        <img src={photo} alt="" loading="lazy" onError={() => setBroken(true)} />
      </div>
    );
  }
  return (
    <div className={`plate plate--${variant} hue-${look.hue}`} aria-hidden="true">
      {/* The poster sets the glyph twice: once large, bled off the corner as
          a watermark, and once at reading size. The tile only has room for
          the one, and the cover only wants the watermark. */}
      {variant !== "tile" && <Icon name={look.glyph} className="plate-mark" />}
      {variant !== "cover" && <Icon name={look.glyph} className="plate-glyph" />}
      {variant === "poster" && category && <span className="plate-label">{category}</span>}
    </div>
  );
}

/**
 * Difficulty as three squares, filled one to three. Replaces the coloured
 * EASY / MEDIUM / HARD pill that sat on every row: the same fact, a quarter
 * of the ink, and the row stops being a parade of capsules.
 */
export function DifficultyMark({
  recipe,
  decorative = false,
}: {
  recipe: Pick<Recipe, "difficulty">;
  /** The word is printed right beside it, so don't announce it twice. */
  decorative?: boolean;
}) {
  const level = difficultyLevel(recipe);
  const a11y = decorative
    ? { "aria-hidden": true as const }
    : { role: "img", "aria-label": `Difficulty: ${recipe.difficulty}`, title: recipe.difficulty };
  return (
    <span className="diff-mark" {...a11y}>
      {[1, 2, 3].map((i) => (
        <span key={i} className={i <= level ? "on" : undefined} />
      ))}
    </span>
  );
}

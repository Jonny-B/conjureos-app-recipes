import type { CSSProperties } from "react";
import art from "../assets/splash-art.webp";

/**
 * The opening screen: the owner's kitchen-table art with a fork and spoon
 * and a spinner, over the app until the catalog has loaded (App.tsx).
 *
 * The art is PORTRAIT (1154×1363) with its props in the four corners and
 * plain dark texture in the middle. Stretched to cover a landscape screen it
 * would lose the top and bottom rows of props, so it is drawn twice instead,
 * height-fitted: the left half of the screen shows the art's left edge and
 * the right half its right edge, each fading toward the middle into the
 * fill matched to the art's own lighting, under a faint film grain that
 * hides the fade's banding (styles.css .splash). On any shape of screen the
 * herbs, tomatoes, oil and spinach stay in their corners.
 *
 * Always Spring DARK (`cui-t-spr-d`), whatever flavour the user picked: the
 * art is a dark picture, and the icon and spinner have to read on it.
 */
export function Splash({ leaving }: { leaving: boolean }) {
  return (
    <div
      className={`splash cui-t-spr-d${leaving ? " splash--leaving" : ""}`}
      style={{ "--splash-art": `url("${art}")` } as CSSProperties}
      role="status"
      aria-label="Loading recipes"
    >
      <div className="splash-grain" aria-hidden="true" />
      <div className="splash-mark" aria-hidden="true">
        <svg className="splash-icon" viewBox="0 0 64 64" fill="none">
          {/* Each drawn upright, then crossed: fork leaning left, spoon right. */}
          <path transform="rotate(-45 32 32)" d="M26 5v9a6 6 0 0 0 12 0V5M32 5v15M32 20v39" />
          <g transform="rotate(45 32 32)">
            <ellipse cx="32" cy="14" rx="7" ry="10" />
            <path d="M32 24v35" />
          </g>
        </svg>
        <span className="splash-spinner" />
      </div>
    </div>
  );
}

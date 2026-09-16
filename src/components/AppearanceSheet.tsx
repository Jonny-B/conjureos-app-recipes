import { useEffect, useState } from "react";
import {
  FLAVORS,
  resolve,
  setFlavor,
  subscribeAppearance,
  type Appearance,
  type Flavor,
} from "../theme";
import { Icon } from "../icons";

/**
 * Recipes' own appearance control: light or dark. That's the whole sheet.
 *
 * The palette is locked to Spring, so there is nothing to pick there and no
 * picker for it. Until the user taps one of these two buttons, the flavor
 * tracks whatever ConjureOS is wearing, live; the first tap is a one-way
 * door — from then on this app's own stored choice wins, in or out of
 * ConjureOS, and this sheet has no control that hands it back.
 */
export function AppearanceSheet({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<Appearance>(() => resolve());

  // Also fires for pushes from ConjureOS, so the buttons stay honest while
  // someone changes the OS flavor in another window with this sheet open —
  // right up until the user's own choice takes over.
  useEffect(() => subscribeAppearance(setState), []);

  const pickFlavor = (next: Flavor) => {
    setState(setFlavor(next));
  };

  // Falls back to "dark" only to give a button something to highlight when
  // nothing has an opinion yet (no stored choice, no ConjureOS to follow);
  // it never writes an attribute on its own — see theme.ts.
  const effectiveFlavor: Flavor = state.flavor ?? "dark";

  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div
        className="settings-sheet appearance-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Appearance"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-handle" />
        <h2 className="appearance-title">Appearance</h2>

        <div className="appearance-controls">
          <div className="appearance-field">
            <span className="appearance-field-label">Light or dark</span>
            <div className="appearance-flavors">
              {FLAVORS.map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`appearance-flavor${effectiveFlavor === f ? " on" : ""}`}
                  aria-pressed={effectiveFlavor === f}
                  onClick={() => pickFlavor(f)}
                >
                  <Icon name={f === "dark" ? "moon" : "sun"} />
                  {f === "dark" ? "Dark" : "Light"}
                </button>
              ))}
            </div>
          </div>
        </div>

        <button className="sheet-item appearance-done" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

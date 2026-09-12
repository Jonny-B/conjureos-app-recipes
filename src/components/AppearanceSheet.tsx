import { useEffect, useState } from "react";
import {
  FLAVORS,
  THEMES,
  followConjureOS,
  overrideConjureOS,
  resolve,
  setFlavor,
  setTheme,
  subscribeAppearance,
  type Appearance,
  type Flavor,
  type ThemeId,
} from "../theme";
import { Icon } from "../icons";

/**
 * Recipes' own appearance controls.
 *
 * One switch and two pickers, in that order because the switch decides whether
 * the pickers mean anything:
 *
 *   Use ConjureOS appearance   on  → the palette and light/dark follow the OS,
 *                                    live, and both pickers are disabled
 *                              off → Recipes keeps its own pair, and the
 *                                    pickers are how you set them
 *
 * Turning the switch OFF does not change how the app looks. It seeds both
 * axes from whatever is on screen and hands the controls over, so the act of
 * taking control is not also a restyle the user did not ask for. Turning it
 * back ON drops both overrides in one write, so the app never spends a frame
 * with the palette following the OS and the flavor not.
 *
 * Outside ConjureOS (`npm run dev`, the standalone dist smoke test) there is
 * no OS to follow. The switch stays, because the stored state is the same
 * either way and hiding it would make the two builds diverge, but the hint
 * says plainly that nothing is answering.
 */
export function AppearanceSheet({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<Appearance>(() => resolve());

  // Also fires for pushes from ConjureOS, so the controls stay honest while
  // someone changes the OS theme in another window with this sheet open.
  useEffect(() => subscribeAppearance(setState), []);

  const following = state.following;

  const toggleFollow = () => {
    setState(following ? overrideConjureOS() : followConjureOS());
  };

  const pickTheme = (raw: string) => {
    setState(setTheme((raw || null) as ThemeId | null));
  };

  const pickFlavor = (next: Flavor) => {
    setState(setFlavor(next));
  };

  const osLabel = state.osTheme
    ? (THEMES.find((t) => t.id === state.osTheme)?.label ?? state.osTheme)
    : "Conjure";

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

        <label className="appearance-follow">
          <span className="appearance-follow-text">
            <span className="appearance-follow-label">Use ConjureOS appearance</span>
            <span className="appearance-follow-hint">
              {state.inConjureOS
                ? `ConjureOS is on ${osLabel}${state.osFlavor ? `, ${state.osFlavor}` : ""}.`
                : "Nothing is answering — Recipes is running outside ConjureOS."}
            </span>
          </span>
          <input
            type="checkbox"
            className="appearance-switch"
            checked={following}
            onChange={toggleFollow}
            role="switch"
            aria-checked={following}
          />
        </label>

        <div className="appearance-controls" aria-hidden={following}>
          <label className="appearance-field">
            <span className="appearance-field-label">Theme</span>
            <select
              className="appearance-select"
              value={state.userTheme ?? ""}
              disabled={following}
              onChange={(e) => pickTheme(e.target.value)}
            >
              {THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>

          <div className="appearance-field">
            <span className="appearance-field-label">Light or dark</span>
            <div className="appearance-flavors">
              {FLAVORS.map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`appearance-flavor${state.userFlavor === f ? " on" : ""}`}
                  disabled={following}
                  aria-pressed={state.userFlavor === f}
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

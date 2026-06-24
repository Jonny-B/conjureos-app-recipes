import { Icon } from "../icons";

/**
 * Star rating, two modes.
 *
 * <Stars value={n} /> — read-only display. Renders 5 outline stars with a
 * gold fill overlay clipped to the rating, rounded to the nearest HALF star
 * (so a 3.7 average shows as 3.5). Used on recipe cards + detail.
 *
 * <Stars value={n} onPick={fn} /> — interactive 1-5 picker (whole stars).
 * Used in the guided cook's post-cook "rate this dish" prompt.
 */
export function Stars({
  value,
  onPick,
  size = 16,
}: {
  value: number | null | undefined;
  onPick?: (n: number) => void;
  size?: number;
}) {
  const v = value ?? 0;

  if (onPick) {
    return (
      <div className="stars stars--pick" style={{ fontSize: size }} role="radiogroup" aria-label="Rate this dish">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            className={`star-btn${n <= v ? " on" : ""}`}
            onClick={() => onPick(n)}
            aria-label={`${n} star${n === 1 ? "" : "s"}`}
            aria-pressed={n <= v}
            title={`${n} star${n === 1 ? "" : "s"}`}
          >
            <Icon name="star" />
          </button>
        ))}
      </div>
    );
  }

  // Read-only: clip a filled layer to nearest half.
  const rounded = Math.round(v * 2) / 2;
  const pct = (rounded / 5) * 100;
  return (
    <span className="stars stars--show" style={{ fontSize: size }} aria-label={`${rounded} out of 5 stars`}>
      <span className="stars-empty">
        {[0, 1, 2, 3, 4].map((i) => (
          <Icon key={i} name="star" />
        ))}
      </span>
      <span className="stars-fill" style={{ width: `${pct}%` }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <Icon key={i} name="star" />
        ))}
      </span>
    </span>
  );
}

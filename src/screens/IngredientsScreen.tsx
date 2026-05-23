import { useMemo, useState, type FormEvent } from "react";
import type { Ingredient } from "../types";

interface Props {
  photoDataUrl: string;
  initialIngredients: Ingredient[];
  onConfirm: (ingredients: Ingredient[]) => void;
  onRetake: () => void;
}

export function IngredientsScreen({ photoDataUrl, initialIngredients, onConfirm, onRetake }: Props) {
  const [items, setItems] = useState<Ingredient[]>(initialIngredients);
  const [adding, setAdding] = useState("");

  const confirmed = useMemo(() => items.filter((i) => i.confirmed), [items]);
  const unconfirmed = useMemo(() => items.filter((i) => !i.confirmed), [items]);

  const setConfirmed = (name: string, value: boolean) => {
    setItems((prev) => prev.map((i) => (i.name === name ? { ...i, confirmed: value } : i)));
  };

  const remove = (name: string) => {
    setItems((prev) => prev.filter((i) => i.name !== name));
  };

  const addManual = (e: FormEvent) => {
    e.preventDefault();
    const name = adding.trim().toLowerCase();
    if (!name) return;
    if (items.some((i) => i.name === name)) {
      setAdding("");
      return;
    }
    setItems((prev) => [
      ...prev,
      { name, confidence: 1, confirmed: true },
    ]);
    setAdding("");
  };

  return (
    <div className="ing-screen">
      <img className="thumb" src={photoDataUrl} alt="Your fridge" />

      <div className="row" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>
            {items.length} ingredients spotted
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            Confirm what's actually there. Toggle off anything I got wrong, add what I missed.
          </div>
        </div>
        <button className="btn ghost" onClick={onRetake}>
          ↺ Retake
        </button>
      </div>

      {confirmed.length > 0 && (
        <div className="ing-group">
          <div className="ing-group-label">Confirmed · {confirmed.length}</div>
          {confirmed.map((ing) => (
            <IngredientRow
              key={ing.name}
              ingredient={ing}
              onToggle={() => setConfirmed(ing.name, false)}
              onRemove={() => remove(ing.name)}
              confirmedView
            />
          ))}
        </div>
      )}

      {unconfirmed.length > 0 && (
        <div className="ing-group">
          <div className="ing-group-label">Is this here? · {unconfirmed.length}</div>
          {unconfirmed.map((ing) => (
            <IngredientRow
              key={ing.name}
              ingredient={ing}
              onToggle={() => setConfirmed(ing.name, true)}
              onRemove={() => remove(ing.name)}
              confirmedView={false}
            />
          ))}
        </div>
      )}

      <div className="ing-group">
        <div className="ing-group-label">Add an ingredient</div>
        <form className="add-ing-form" onSubmit={addManual}>
          <input
            type="text"
            placeholder="e.g. olive oil, lemon, leftover rice…"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
          />
          <button className="btn secondary" type="submit" disabled={!adding.trim()}>
            Add
          </button>
        </form>
      </div>

      <div className="capture-buttons" style={{ marginTop: 8 }}>
        <button
          className="btn"
          disabled={confirmed.length === 0}
          onClick={() => onConfirm(confirmed)}
        >
          Find recipes ({confirmed.length}) →
        </button>
      </div>
    </div>
  );
}

interface RowProps {
  ingredient: Ingredient;
  onToggle: () => void;
  onRemove: () => void;
  confirmedView: boolean;
}

function IngredientRow({ ingredient, onToggle, onRemove, confirmedView }: RowProps) {
  return (
    <div className={`ing-row ${confirmedView ? "confirmed" : "unconfirmed"}`}>
      <button className="icon-btn" onClick={onToggle} title={confirmedView ? "Remove from confirmed" : "Confirm this is here"}>
        {confirmedView ? "✓" : "○"}
      </button>
      <span className="name">{ingredient.name}</span>
      {ingredient.notes && <span className="notes">{ingredient.notes}</span>}
      <span className="conf" title="Confidence">{Math.round(ingredient.confidence * 100)}%</span>
      <div className="actions">
        <button className="icon-btn" onClick={onRemove} title="Remove">
          ✕
        </button>
      </div>
    </div>
  );
}

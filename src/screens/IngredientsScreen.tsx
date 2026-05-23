import { useMemo, useState, type FormEvent } from "react";
import type { CapturedPhoto, Ingredient } from "../types";
import { sanitizeName } from "../features/vision";

interface Props {
  photos: CapturedPhoto[];
  initialIngredients: Ingredient[];
  onConfirm: (ingredients: Ingredient[]) => void;
  onRetake: () => void;
}

export function IngredientsScreen({ photos, initialIngredients, onConfirm, onRetake }: Props) {
  const [items, setItems] = useState<Ingredient[]>(initialIngredients);
  const [adding, setAdding] = useState("");
  const [addingQty, setAddingQty] = useState("");
  // Track which ingredient has its quantity editor open. Only one at a
  // time — there's no UI need for parallel edits and an `editingName`
  // state is simpler than per-row component state.
  const [editingQty, setEditingQty] = useState<string | null>(null);
  const [editingQtyValue, setEditingQtyValue] = useState("");

  const confirmed = useMemo(() => items.filter((i) => i.confirmed), [items]);
  const unconfirmed = useMemo(() => items.filter((i) => !i.confirmed), [items]);

  const setConfirmed = (name: string, value: boolean) => {
    setItems((prev) => prev.map((i) => (i.name === name ? { ...i, confirmed: value } : i)));
  };

  const remove = (name: string) => {
    setItems((prev) => prev.filter((i) => i.name !== name));
    if (editingQty === name) {
      setEditingQty(null);
      setEditingQtyValue("");
    }
  };

  const setQuantity = (name: string, quantity: string) => {
    const trimmed = quantity.trim().slice(0, 40);
    setItems((prev) =>
      prev.map((i) =>
        i.name === name ? { ...i, quantity: trimmed || undefined } : i,
      ),
    );
    setEditingQty(null);
    setEditingQtyValue("");
  };

  const beginEditQty = (i: Ingredient) => {
    setEditingQty(i.name);
    setEditingQtyValue(i.quantity ?? "");
  };

  const addManual = (e: FormEvent) => {
    e.preventDefault();
    // Sanitize user-typed names with the same allowlist as vision-emitted
    // names. Lowercases, strips weird characters, caps length.
    const name = sanitizeName(adding);
    if (!name) {
      setAdding("");
      return;
    }
    if (items.some((i) => i.name === name)) {
      setAdding("");
      setAddingQty("");
      return;
    }
    const qty = addingQty.trim().slice(0, 40);
    setItems((prev) => [
      ...prev,
      {
        name,
        confidence: 1,
        confirmed: true,
        ...(qty ? { quantity: qty } : {}),
      },
    ]);
    setAdding("");
    setAddingQty("");
  };

  return (
    <div className="ing-screen">
      <PhotoStrip photos={photos} />

      <div className="row" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>
            {items.length} ingredient{items.length === 1 ? "" : "s"} spotted
            {photos.length > 1 && (
              <span className="faint" style={{ fontSize: 13, fontWeight: 400 }}>
                {" "}from {photos.length} photos, deduped
              </span>
            )}
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            Confirm what's actually there. Edit a quantity if mine looks wrong. Toggle off what I missed.
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
              editingQty={editingQty === ing.name ? editingQtyValue : null}
              onSetEditingQty={(v) => setEditingQtyValue(v)}
              onCommitQty={(v) => setQuantity(ing.name, v)}
              onCancelQty={() => {
                setEditingQty(null);
                setEditingQtyValue("");
              }}
              onBeginEditQty={() => beginEditQty(ing)}
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
              editingQty={editingQty === ing.name ? editingQtyValue : null}
              onSetEditingQty={(v) => setEditingQtyValue(v)}
              onCommitQty={(v) => setQuantity(ing.name, v)}
              onCancelQty={() => {
                setEditingQty(null);
                setEditingQtyValue("");
              }}
              onBeginEditQty={() => beginEditQty(ing)}
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
            maxLength={50}
          />
          <input
            type="text"
            placeholder="qty (optional)"
            value={addingQty}
            onChange={(e) => setAddingQty(e.target.value)}
            maxLength={40}
            style={{ maxWidth: 140 }}
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

function PhotoStrip({ photos }: { photos: CapturedPhoto[] }) {
  if (photos.length === 1) {
    return <img className="thumb" src={photos[0]!.dataUrl} alt="Your fridge" />;
  }
  return (
    <div className="photo-strip" role="list" aria-label="Captured photos">
      {photos.map((p, i) => (
        <img
          key={p.id}
          src={p.dataUrl}
          alt={`Photo ${i + 1}`}
          className="photo-strip-img"
          role="listitem"
        />
      ))}
    </div>
  );
}

interface RowProps {
  ingredient: Ingredient;
  editingQty: string | null;
  onSetEditingQty: (v: string) => void;
  onCommitQty: (v: string) => void;
  onCancelQty: () => void;
  onBeginEditQty: () => void;
  onToggle: () => void;
  onRemove: () => void;
  confirmedView: boolean;
}

function IngredientRow({
  ingredient,
  editingQty,
  onSetEditingQty,
  onCommitQty,
  onCancelQty,
  onBeginEditQty,
  onToggle,
  onRemove,
  confirmedView,
}: RowProps) {
  return (
    <div className={`ing-row ${confirmedView ? "confirmed" : "unconfirmed"}`}>
      <button
        className="icon-btn"
        onClick={onToggle}
        title={confirmedView ? "Remove from confirmed" : "Confirm this is here"}
      >
        {confirmedView ? "✓" : "○"}
      </button>
      <span className="name">{ingredient.name}</span>
      {editingQty !== null ? (
        <form
          className="qty-edit-form"
          onSubmit={(e) => {
            e.preventDefault();
            onCommitQty(editingQty);
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="text"
            value={editingQty}
            onChange={(e) => onSetEditingQty(e.target.value)}
            maxLength={40}
            autoFocus
            placeholder="e.g. 1 pint, 200g"
          />
          <button type="submit" className="icon-btn" title="Save">✓</button>
          <button
            type="button"
            className="icon-btn"
            title="Cancel"
            onClick={onCancelQty}
          >
            ✕
          </button>
        </form>
      ) : (
        <button
          className="qty-pill"
          onClick={onBeginEditQty}
          title="Edit quantity"
        >
          {ingredient.quantity ?? "+ qty"}
        </button>
      )}
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

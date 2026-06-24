import { useMemo, useState, type FormEvent } from "react";
import type { CapturedPhoto, Ingredient, PantryItem } from "../types";
import {
  addPantryItem,
  addPantryItems,
  updatePantryItem,
  removePantryItem,
} from "../features/pantry";
import { identifyIngredients } from "../features/vision";
import { CaptureScreen } from "./CaptureScreen";
import { Icon } from "../icons";

interface Props {
  pantry: PantryItem[] | null;
  onChange: (items: PantryItem[]) => void;
  /** Generate recipes from everything in the pantry (the "cook now" action). */
  onCook?: () => void;
  /** Browse the catalog ranked by what's in the pantry. */
  onBrowse?: () => void;
}

type Mode = "list" | "capture" | "identifying" | "confirm";

export function PantryScreen({ pantry, onChange, onCook, onBrowse }: Props) {
  const [mode, setMode] = useState<Mode>("list");
  const [scanned, setScanned] = useState<Ingredient[]>([]);
  const [error, setError] = useState<string | null>(null);

  const onScanned = async (photos: CapturedPhoto[]) => {
    setError(null);
    setMode("identifying");
    try {
      const items = await identifyIngredients(photos);
      setScanned(items.map((i) => ({ ...i, confirmed: i.confirmed })));
      setMode("confirm");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMode("capture");
    }
  };

  const commitScanned = async () => {
    const include = scanned.filter((i) => i.confirmed);
    if (include.length === 0) {
      setMode("list");
      return;
    }
    const next = await addPantryItems(
      include.map((i) => ({ name: i.name, quantity: i.quantity, notes: i.notes })),
    );
    onChange(next);
    setScanned([]);
    setMode("list");
  };

  if (mode === "capture") {
    return (
      <div className="browse-screen">
        <BackBar label="Back to pantry" onBack={() => setMode("list")} />
        {error && (
          <div className="status-banner error">
            <Icon name="wand" />
            <span>{error}</span>
          </div>
        )}
        <CaptureScreen
          onIdentify={onScanned}
          title="Add to your kitchen"
          emptyHint="Snap your fridge or shelves — I'll list what I see so you can add it in a tap."
          actionLabel={(n) => `Find items in ${n} photo${n === 1 ? "" : "s"} →`}
        />
      </div>
    );
  }

  if (mode === "identifying") {
    return (
      <div className="center-spinner">
        <div className="spinner" />
        <div style={{ fontWeight: 500 }}>Reading your photos…</div>
      </div>
    );
  }

  if (mode === "confirm") {
    return (
      <ScanConfirm
        scanned={scanned}
        onToggle={(name) =>
          setScanned((prev) => prev.map((i) => (i.name === name ? { ...i, confirmed: !i.confirmed } : i)))
        }
        onRemove={(name) => setScanned((prev) => prev.filter((i) => i.name !== name))}
        onBack={() => setMode("list")}
        onCommit={commitScanned}
      />
    );
  }

  return (
    <PantryList
      pantry={pantry}
      onChange={onChange}
      onScan={() => {
        setError(null);
        setMode("capture");
      }}
      onCook={onCook}
      onBrowse={onBrowse}
    />
  );
}

// ── List + manual editing ──────────────────────────────────────────────

function PantryList({
  pantry,
  onChange,
  onScan,
  onCook,
  onBrowse,
}: {
  pantry: PantryItem[] | null;
  onChange: (items: PantryItem[]) => void;
  onScan: () => void;
  onCook?: () => void;
  onBrowse?: () => void;
}) {
  const [name, setName] = useState("");
  const [qty, setQty] = useState("");
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const items = pantry ?? [];
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items;
  }, [items, filter]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      const next = await addPantryItem({ name, quantity: qty });
      onChange(next);
      setName("");
      setQty("");
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    }
  };

  const commitQty = async (itemName: string) => {
    const next = await updatePantryItem(itemName, { quantity: editValue.trim() || undefined });
    onChange(next);
    setEditing(null);
    setEditValue("");
  };

  const remove = async (itemName: string) => {
    const next = await removePantryItem(itemName);
    onChange(next);
  };

  if (pantry === null) {
    return (
      <div className="center-spinner">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="browse-screen">
      <div className="browse-header">
        <div className="browse-title-row">
          <h2>My kitchen</h2>
          <button className="btn secondary new-recipe-btn" onClick={onScan}>
            <Icon name="camera" /> Scan to add
          </button>
        </div>
        <div className="browse-filter">
          <Icon name="magnifying-glass" />
          <input
            type="text"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>

      {(onCook || onBrowse) && (
        <div className="kitchen-actions">
          {onCook && (
            <button className="btn" disabled={items.length === 0} onClick={onCook}>
              <Icon name="wand" /> Cook from my kitchen
            </button>
          )}
          {onBrowse && (
            <button className="btn secondary" onClick={onBrowse}>
              <Icon name="magnifying-glass" /> Browse what I can make
            </button>
          )}
        </div>
      )}

      <div className="muted" style={{ fontSize: 13 }}>
        What you have on hand — recipes rank by how much of it you already have.
      </div>

      <form className="add-ing-form" onSubmit={add}>
        <input
          type="text"
          placeholder="Add an ingredient (e.g. sour cream)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={50}
        />
        <input
          type="text"
          placeholder="Amount (optional)"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          maxLength={40}
        />
        <button className="btn" type="submit" disabled={!name.trim()}>
          <Icon name="plus" /> Add
        </button>
      </form>

      {err && (
        <div className="status-banner error">
          <Icon name="triangle-exclamation" />
          <span>{err}</span>
        </div>
      )}

      {items.length === 0 ? (
        <div className="empty-state">
          <Icon name="carrot" className="empty-icon" />
          <div>Your kitchen is empty. Add items above, or scan your fridge to fill it fast.</div>
        </div>
      ) : (
        <div className="ing-group">
          <div className="ing-group-label">
            {filtered.length} item{filtered.length === 1 ? "" : "s"}
          </div>
          {filtered.map((it) => (
            <div className="ing-row confirmed" key={it.name}>
              <span className="name">{it.name}</span>
              {editing === it.name ? (
                <form
                  className="qty-edit-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    commitQty(it.name);
                  }}
                >
                  <input
                    type="text"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    maxLength={40}
                    autoFocus
                    placeholder="e.g. 1 pint, 200g"
                  />
                  <button type="submit" className="icon-btn" title="Save">
                    <Icon name="check" />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="Cancel"
                    onClick={() => {
                      setEditing(null);
                      setEditValue("");
                    }}
                  >
                    <Icon name="xmark" />
                  </button>
                </form>
              ) : (
                <button
                  className="qty-pill"
                  onClick={() => {
                    setEditing(it.name);
                    setEditValue(it.quantity ?? "");
                  }}
                  title="Edit amount"
                >
                  {it.quantity ?? "+ amount"}
                </button>
              )}
              <div className="actions">
                <button className="icon-btn" onClick={() => remove(it.name)} title="Remove">
                  <Icon name="xmark" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Scan confirm ────────────────────────────────────────────────────────

function ScanConfirm({
  scanned,
  onToggle,
  onRemove,
  onBack,
  onCommit,
}: {
  scanned: Ingredient[];
  onToggle: (name: string) => void;
  onRemove: (name: string) => void;
  onBack: () => void;
  onCommit: () => void;
}) {
  const included = scanned.filter((i) => i.confirmed);
  return (
    <div className="browse-screen">
      <BackBar label="Cancel" onBack={onBack} />
      <div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Found {scanned.length} items</div>
        <div className="muted" style={{ fontSize: 13 }}>
          Uncheck anything that isn't yours, then add the rest to your pantry.
        </div>
      </div>
      <div className="ing-group">
        {scanned.map((ing) => (
          <div className={`ing-row ${ing.confirmed ? "confirmed" : "unconfirmed"}`} key={ing.name}>
            <button
              className="icon-btn"
              onClick={() => onToggle(ing.name)}
              title={ing.confirmed ? "Exclude" : "Include"}
            >
              <Icon name={ing.confirmed ? "check" : "circle"} />
            </button>
            <span className="name">{ing.name}</span>
            {ing.quantity && <span className="qty-pill">{ing.quantity}</span>}
            {ing.notes && <span className="notes">{ing.notes}</span>}
            <div className="actions">
              <button className="icon-btn" onClick={() => onRemove(ing.name)} title="Remove">
                <Icon name="xmark" />
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="capture-buttons" style={{ marginTop: 8 }}>
        <button className="btn" disabled={included.length === 0} onClick={onCommit}>
          <Icon name="plus" /> Add {included.length} to pantry
        </button>
      </div>
    </div>
  );
}

function BackBar({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <div className="detail-actions">
      <button className="btn ghost" onClick={onBack}>
        <Icon name="chevron-down" className="back-caret" /> {label}
      </button>
    </div>
  );
}

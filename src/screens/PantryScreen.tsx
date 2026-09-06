import { useMemo, useState, type FormEvent } from "react";
import type { CapturedPhoto, Ingredient, PantryItem, Recipe, SavedRecipe } from "../types";
import {
  addPantryItem,
  addPantryItems,
  updatePantryItem,
  removePantryItem,
  ingredientsFromPantry,
} from "../features/pantry";
import { identifyIngredients } from "../features/vision";
import { generateRecipes } from "../features/recipes";
import { getCatalog, toRecipe, loadRecipeBody } from "../features/catalog";
import { computeCoverage } from "../features/scaling";
import { CaptureScreen } from "./CaptureScreen";
import { RecipesScreen } from "./RecipesScreen";
import { RecipeRow } from "../components/RecipeRow";
import { Icon } from "../icons";

interface Props {
  pantry: PantryItem[] | null;
  onChange: (items: PantryItem[]) => void;
  /** Return to the Cook launcher. */
  onBack?: () => void;
  /** Start the guided cook for a recipe (savedRecipe null — kitchen cooks catalog/AI recipes). */
  onCook?: (recipe: Recipe, saved: SavedRecipe | null) => void;
  catalogVersion?: number;
}

type Mode = "list" | "capture" | "identifying" | "confirm";
type Gen = { kind: "idle" } | { kind: "generating" } | { kind: "recipes"; recipes: Recipe[] };

export function PantryScreen({ pantry, onChange, onBack, onCook, catalogVersion = 0 }: Props) {
  const [mode, setMode] = useState<Mode>("list");
  const [scanned, setScanned] = useState<Ingredient[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [gen, setGen] = useState<Gen>({ kind: "idle" });

  // Retained so a failed identify doesn't cost the user their photos — see
  // CaptureScreen's initialPhotos. Cleared on success, so the next scan starts
  // from an empty tray rather than re-offering shots already used.
  const [lastPhotos, setLastPhotos] = useState<CapturedPhoto[]>([]);

  const onScanned = async (photos: CapturedPhoto[]) => {
    setError(null);
    setLastPhotos(photos);
    setMode("identifying");
    try {
      const items = await identifyIngredients(photos);
      setScanned(items.map((i) => ({ ...i, confirmed: i.confirmed })));
      setLastPhotos([]);
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
    const next = await addPantryItems(include.map((i) => ({ name: i.name, quantity: i.quantity, notes: i.notes })));
    onChange(next);
    setScanned([]);
    setMode("list");
  };

  const inventWithAI = async () => {
    const ings = ingredientsFromPantry(pantry ?? []);
    if (ings.length === 0) return;
    setError(null);
    setGen({ kind: "generating" });
    try {
      const recipes = await generateRecipes(ings);
      setGen({ kind: "recipes", recipes });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setGen({ kind: "idle" });
    }
  };

  if (gen.kind === "generating") {
    return (
      <div className="center-spinner">
        <div className="spinner" />
        <div style={{ fontWeight: 500 }}>Cooking up ideas…</div>
        <div className="muted" style={{ fontSize: 13 }}>Three recipes from what you have. ~10 seconds.</div>
      </div>
    );
  }
  if (gen.kind === "recipes") {
    return (
      <div className="browse-screen">
        <BackBar label="Back to kitchen" onBack={() => setGen({ kind: "idle" })} />
        <RecipesScreen
          recipes={gen.recipes}
          ingredients={ingredientsFromPantry(pantry ?? [])}
          onEditIngredients={() => setGen({ kind: "idle" })}
          onRestart={() => setGen({ kind: "idle" })}
          onCook={onCook ? (r) => onCook(r, null) : undefined}
        />
      </div>
    );
  }

  if (mode === "capture") {
    return (
      <div className="browse-screen">
        <BackBar label="Back to kitchen" onBack={() => setMode("list")} />
        {error && (
          <div className="status-banner error">
            <Icon name="wand" />
            <span>{error}</span>
          </div>
        )}
        <CaptureScreen
          onIdentify={onScanned}
          initialPhotos={lastPhotos}
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
        onToggle={(name) => setScanned((prev) => prev.map((i) => (i.name === name ? { ...i, confirmed: !i.confirmed } : i)))}
        onRemove={(name) => setScanned((prev) => prev.filter((i) => i.name !== name))}
        onBack={() => setMode("list")}
        onCommit={commitScanned}
      />
    );
  }

  return (
    <KitchenList
      pantry={pantry}
      onChange={onChange}
      onBack={onBack}
      onCook={onCook}
      onScan={() => {
        setError(null);
        setMode("capture");
      }}
      onInvent={inventWithAI}
      catalogVersion={catalogVersion}
    />
  );
}

// ── Kitchen list: what you have + scan + "what can I make" ──────────────

function KitchenList({
  pantry,
  onChange,
  onBack,
  onCook,
  onScan,
  onInvent,
  catalogVersion,
}: {
  pantry: PantryItem[] | null;
  onChange: (items: PantryItem[]) => void;
  onBack?: () => void;
  onCook?: (recipe: Recipe, saved: SavedRecipe | null) => void;
  onScan: () => void;
  onInvent: () => void;
  catalogVersion: number;
}) {
  const [name, setName] = useState("");
  const [qty, setQty] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showMatches, setShowMatches] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const items = pantry ?? [];
  const hasItems = items.length > 0;

  const catalog = useMemo(() => getCatalog(), [catalogVersion]);
  const pantryIng = useMemo(() => ingredientsFromPantry(items), [items]);
  const matches = useMemo(() => {
    if (!pantryIng.length) return [];
    return catalog
      .map((c) => ({ c, cov: computeCoverage(c, pantryIng) }))
      .filter((x) => x.cov.have > 0)
      .sort((a, b) => b.cov.score - a.cov.score)
      .slice(0, 30);
  }, [catalog, pantryIng]);

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
  const remove = async (itemName: string) => onChange(await removePantryItem(itemName));

  if (pantry === null) {
    return <div className="center-spinner"><div className="spinner" /></div>;
  }

  return (
    <div className="browse-screen">
      {onBack && <BackBar label="Cook" onBack={onBack} />}

      <div className="kitchen-top">
        <h2>My kitchen</h2>
        <button className="btn" onClick={onScan}>
          <Icon name="camera" /> Scan
        </button>
      </div>

      {err && (
        <div className="status-banner error">
          <Icon name="triangle-exclamation" />
          <span>{err}</span>
        </div>
      )}

      {!hasItems ? (
        <div className="empty-state">
          <Icon name="carrot" className="empty-icon" />
          <div>Your kitchen is empty. Scan your fridge to fill it fast, or add items by hand.</div>
          <button className="btn secondary" onClick={() => setShowAdd(true)}>
            <Icon name="plus" /> Add by hand
          </button>
        </div>
      ) : (
        <>
          <div className="kitchen-list-head">
            <span className="ing-group-label">{items.length} item{items.length === 1 ? "" : "s"}</span>
            <button className="link-btn" onClick={() => setShowAdd((v) => !v)}>
              <Icon name="plus" /> Add by hand
            </button>
          </div>
          <div className="ing-group">
            {items.map((it) => (
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
                    <input type="text" value={editValue} onChange={(e) => setEditValue(e.target.value)} maxLength={40} autoFocus placeholder="e.g. 1 pint" />
                    <button type="submit" className="icon-btn" title="Save"><Icon name="check" /></button>
                    <button type="button" className="icon-btn" title="Cancel" onClick={() => { setEditing(null); setEditValue(""); }}><Icon name="xmark" /></button>
                  </form>
                ) : (
                  <button className="qty-pill" onClick={() => { setEditing(it.name); setEditValue(it.quantity ?? ""); }} title="Edit amount">
                    {it.quantity ?? "+ amount"}
                  </button>
                )}
                <div className="actions">
                  <button className="icon-btn" onClick={() => remove(it.name)} title="Remove"><Icon name="xmark" /></button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {showAdd && (
        <form className="add-ing-form" onSubmit={add}>
          <input type="text" placeholder="Add an ingredient (e.g. sour cream)" value={name} onChange={(e) => setName(e.target.value)} maxLength={50} autoFocus />
          <input type="text" placeholder="Amount (optional)" value={qty} onChange={(e) => setQty(e.target.value)} maxLength={40} />
          <button className="btn" type="submit" disabled={!name.trim()}><Icon name="plus" /> Add</button>
        </form>
      )}

      {hasItems && (
        <div className="kitchen-make-section">
          <button className="btn kitchen-make" onClick={() => setShowMatches((v) => !v)}>
            <Icon name="bowl-food" /> What can I make?
            <Icon name="chevron-down" className={showMatches ? "rot-flip" : ""} />
          </button>
          {showMatches && (
            <div className="kitchen-matches">
              <button className="btn secondary kitchen-invent" onClick={onInvent}>
                <Icon name="wand" /> Invent with AI from what I have
              </button>
              {matches.length > 0 ? (
                <div className="browse-list">
                  {matches.map(({ c, cov }) => (
                    <RecipeRow
                      key={c.id}
                      fi={{ kind: "catalog", id: c.id, recipe: c, favorite: false }}
                      cov={cov}
                      onOpen={async () => onCook?.(toRecipe(await loadRecipeBody(c)), null)}
                    />
                  ))}
                </div>
              ) : (
                <p className="muted" style={{ fontSize: 13 }}>Add a few more items and matches will show here.</p>
              )}
            </div>
          )}
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
        <div className="muted" style={{ fontSize: 13 }}>Uncheck anything that isn't yours, then add the rest to your kitchen.</div>
      </div>
      <div className="ing-group">
        {scanned.map((ing) => (
          <div className={`ing-row ${ing.confirmed ? "confirmed" : "unconfirmed"}`} key={ing.name}>
            <button className="icon-btn" onClick={() => onToggle(ing.name)} title={ing.confirmed ? "Exclude" : "Include"}>
              <Icon name={ing.confirmed ? "check" : "circle"} />
            </button>
            <span className="name">{ing.name}</span>
            {ing.quantity && <span className="qty-pill">{ing.quantity}</span>}
            {ing.notes && <span className="notes">{ing.notes}</span>}
            <div className="actions">
              <button className="icon-btn" onClick={() => onRemove(ing.name)} title="Remove"><Icon name="xmark" /></button>
            </div>
          </div>
        ))}
      </div>
      <div className="capture-buttons" style={{ marginTop: 8 }}>
        <button className="btn" disabled={included.length === 0} onClick={onCommit}>
          <Icon name="plus" /> Add {included.length} to kitchen
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

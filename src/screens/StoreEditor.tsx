import { useEffect, useRef, useState } from "react";
import {
  loadStores,
  saveStores,
  newStore,
  newId,
  unassignedCategories,
  aiSortEnabled,
  setAiSortEnabled,
  STORE_CATEGORIES,
  type StoresState,
  type StoreLayout,
} from "../features/storeLayout";
import { Icon } from "../icons";

/**
 * Grocery-store layout editor. Personal, VFS-backed (see storeLayout.ts).
 * Each store is an ORDERED list of aisles (walking path); categories slot into
 * aisles, with per-item exceptions. Changes save immediately to the VFS so the
 * shopping list re-groups the next time it's viewed.
 */
export function StoreEditor({ onBack }: { onBack: () => void }) {
  const [state, setState] = useState<StoresState | null>(null);
  const [editingId, setEditingId] = useState<string>("");
  const [aiOn, setAiOn] = useState<boolean>(aiSortEnabled());

  useEffect(() => {
    loadStores().then((s) => {
      setState(s);
      setEditingId(s.defaultId);
    });
  }, []);

  // Every field here is a controlled text input, so a naive save-on-change wrote
  // the whole stores file to the VFS once per KEYSTROKE — and each write marks
  // the file dirty for cloud sync. Debounce the write (state still updates
  // immediately, so typing stays responsive) and flush on unmount so nothing is
  // lost when the user backs out mid-word.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<StoresState | null>(null);
  const flush = () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (pending.current) {
      void saveStores(pending.current);
      pending.current = null;
    }
  };
  useEffect(() => flush, []);

  const commit = (next: StoresState) => {
    setState(next);
    pending.current = next;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, 500);
  };

  if (!state) {
    return (
      <div className="center-spinner">
        <div className="spinner" />
      </div>
    );
  }

  const store = state.stores.find((s) => s.id === editingId) ?? state.stores[0]!;

  const patchStore = (fn: (s: StoreLayout) => StoreLayout) => {
    commit({ ...state, stores: state.stores.map((s) => (s.id === store.id ? fn(s) : s)) });
  };

  const addStore = () => {
    const s = newStore("New store");
    commit({ ...state, stores: [...state.stores, s] });
    setEditingId(s.id);
  };
  const deleteStore = () => {
    if (state.stores.length <= 1) return;
    const rest = state.stores.filter((s) => s.id !== store.id);
    const nextDefault = state.defaultId === store.id ? rest[0]!.id : state.defaultId;
    commit({ ...state, stores: rest, defaultId: nextDefault });
    setEditingId(rest[0]!.id);
  };
  const setDefault = () => commit({ ...state, defaultId: store.id });

  return (
    <div className="browse-screen form-screen">
      <div className="detail-actions">
        <button className="btn ghost" onClick={onBack}>
          <Icon name="chevron-down" className="back-caret" /> Plans
        </button>
      </div>
      <div className="browse-header">
        <h2>Grocery stores</h2>
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        Lay out your store's aisles in the order you walk them. Shopping lists group
        and sort to match — switch stores anytime.
      </p>

      <label className="ai-toggle">
        <input
          type="checkbox"
          checked={aiOn}
          onChange={(e) => {
            setAiOn(e.target.checked);
            setAiSortEnabled(e.target.checked);
          }}
        />
        <span>
          <Icon name="wand" /> Let AI place items your layout doesn't cover
        </span>
      </label>

      {/* Store switcher */}
      {state.stores.length > 1 && (
        <div className="store-switch">
          {state.stores.map((s) => (
            <button
              key={s.id}
              className={`chip-tab${s.id === store.id ? " active" : ""}`}
              onClick={() => setEditingId(s.id)}
            >
              {s.name}
              {state.defaultId === s.id && <span className="chip-default">default</span>}
            </button>
          ))}
        </div>
      )}

      <div className="store-card">
        <div className="add-ing-form">
          <input
            type="text"
            value={store.name}
            onChange={(e) => patchStore((s) => ({ ...s, name: e.target.value }))}
            maxLength={40}
            aria-label="Store name"
            placeholder="Store name"
          />
          <button className="btn" onClick={addStore} type="button">
            <Icon name="plus" /> Store
          </button>
        </div>
        <div className="store-card-actions">
          {state.defaultId === store.id ? (
            <span className="muted" style={{ fontSize: 12 }}>
              <Icon name="check" /> Default store
            </span>
          ) : (
            <button className="link-btn" onClick={setDefault} type="button">Make default</button>
          )}
          {Object.keys(store.learned ?? {}).length > 0 && (
            <button
              className="link-btn"
              type="button"
              onClick={() => patchStore((s) => ({ ...s, learned: {} }))}
            >
              Clear {Object.keys(store.learned ?? {}).length} AI-learned
            </button>
          )}
          <div style={{ flex: 1 }} />
          {state.stores.length > 1 && (
            <button className="btn ghost" onClick={deleteStore} type="button" aria-label="Delete store">
              <Icon name="trash-can" /> Delete store
            </button>
          )}
        </div>
      </div>

      <AisleList store={store} patchStore={patchStore} />
      <ExceptionList store={store} patchStore={patchStore} />
    </div>
  );
}

function AisleList({
  store,
  patchStore,
}: {
  store: StoreLayout;
  patchStore: (fn: (s: StoreLayout) => StoreLayout) => void;
}) {
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= store.aisles.length) return;
    patchStore((s) => {
      const a = [...s.aisles];
      [a[i], a[j]] = [a[j]!, a[i]!];
      return { ...s, aisles: a };
    });
  };
  const rename = (id: string, name: string) =>
    patchStore((s) => ({ ...s, aisles: s.aisles.map((a) => (a.id === id ? { ...a, name } : a)) }));
  const remove = (id: string) =>
    patchStore((s) => ({ ...s, aisles: s.aisles.filter((a) => a.id !== id) }));
  const addAisle = () =>
    patchStore((s) => ({ ...s, aisles: [...s.aisles, { id: newId(), name: "", categories: [] }] }));
  const toggleCat = (aisleId: string, cat: string) =>
    patchStore((s) => ({
      ...s,
      aisles: s.aisles.map((a) => {
        if (a.id === aisleId) {
          const has = a.categories.includes(cat);
          return { ...a, categories: has ? a.categories.filter((c) => c !== cat) : [...a.categories, cat] };
        }
        // A category has exactly one home: strip it from every other aisle.
        return { ...a, categories: a.categories.filter((c) => c !== cat) };
      }),
    }));

  const unassigned = unassignedCategories(store);

  return (
    <section className="home-section">
      <div className="home-section-head">
        <h3>Aisles</h3>
        <span className="muted" style={{ fontSize: 12 }}>walking order</span>
      </div>

      {store.aisles.map((a, i) => (
        <div key={a.id} className="aisle-card">
          <div className="aisle-head">
            <div className="aisle-reorder">
              <button className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                <Icon name="chevron-up" />
              </button>
              <button
                className="icon-btn"
                onClick={() => move(i, 1)}
                disabled={i === store.aisles.length - 1}
                aria-label="Move down"
              >
                <Icon name="chevron-down" />
              </button>
            </div>
            <input
              type="text"
              className="aisle-name"
              value={a.name}
              placeholder={`Aisle ${i + 1} — number or name`}
              onChange={(e) => rename(a.id, e.target.value)}
              maxLength={40}
            />
            <button className="icon-btn" onClick={() => remove(a.id)} aria-label="Remove aisle">
              <Icon name="trash-can" />
            </button>
          </div>
          <div className="aisle-cats">
            {STORE_CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                className={`cat-chip${a.categories.includes(c) ? " on" : ""}`}
                onClick={() => toggleCat(a.id, c)}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      ))}

      <button className="btn secondary" onClick={addAisle} type="button">
        <Icon name="plus" /> Add aisle
      </button>

      {unassigned.length > 0 && (
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Not placed yet (these fall to an "Unsorted" group at the end): {unassigned.join(", ")}.
        </p>
      )}
    </section>
  );
}

function ExceptionList({
  store,
  patchStore,
}: {
  store: StoreLayout;
  patchStore: (fn: (s: StoreLayout) => StoreLayout) => void;
}) {
  const add = () =>
    patchStore((s) => ({
      ...s,
      itemOverrides: [...s.itemOverrides, { keyword: "", aisleId: s.aisles[0]?.id ?? "" }],
    }));
  const setKw = (i: number, keyword: string) =>
    patchStore((s) => ({ ...s, itemOverrides: s.itemOverrides.map((o, j) => (j === i ? { ...o, keyword } : o)) }));
  const setAisle = (i: number, aisleId: string) =>
    patchStore((s) => ({ ...s, itemOverrides: s.itemOverrides.map((o, j) => (j === i ? { ...o, aisleId } : o)) }));
  const remove = (i: number) =>
    patchStore((s) => ({ ...s, itemOverrides: s.itemOverrides.filter((_, j) => j !== i) }));

  return (
    <section className="home-section">
      <div className="home-section-head">
        <h3>Item exceptions</h3>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        For items that don't live with their category — e.g. <em>flour</em> in your oil aisle.
      </p>
      {store.itemOverrides.map((o, i) => (
        <div key={i} className="exception-row">
          <input
            type="text"
            className="exception-kw"
            value={o.keyword}
            placeholder="item (e.g. flour)"
            onChange={(e) => setKw(i, e.target.value)}
            maxLength={40}
          />
          <span className="muted">→</span>
          <select className="exception-aisle" value={o.aisleId} onChange={(e) => setAisle(i, e.target.value)}>
            {store.aisles.map((a, idx) => (
              <option key={a.id} value={a.id}>{a.name || `Aisle ${idx + 1}`}</option>
            ))}
          </select>
          <button className="icon-btn" onClick={() => remove(i)} aria-label="Remove exception">
            <Icon name="xmark" />
          </button>
        </div>
      ))}
      <button className="btn secondary" onClick={add} type="button" disabled={store.aisles.length === 0}>
        <Icon name="plus" /> Add exception
      </button>
    </section>
  );
}

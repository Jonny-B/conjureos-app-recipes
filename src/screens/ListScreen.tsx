/**
 * The shopping list — its own tab, because it is the one screen in this app
 * you use standing up, one-handed, in a shop, in bad light.
 *
 * Everything here follows from that. Rows are 56px with a 26px square box and
 * the WHOLE row is the target, so a thumb aimed roughly at a line hits it.
 * Groups are the aisles of the store you picked, in the order you walk it.
 * Nothing floats, nothing animates, and the only colour that means anything is
 * the fill of a ticked box.
 *
 * Aisle placement is the app's clearest example of the AI-proposes rule: the
 * deterministic category map places what it can, the model places the rest by
 * analogy to what is already in each aisle, and the "Move" control on any row
 * lets the user overrule both — as a store EXCEPTION, which is a thing they can
 * see and edit later in the store editor, not as another opaque learned entry.
 *
 * The plan record itself is owned by PlansScreen (one load, one realtime
 * subscription, one PlanWriter shared with the Plan tab); this screen only
 * reads it and reports ticks back up.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ShoppingListItem } from "../types";
import type { PlanRecord } from "../bridge/recipesApi";
import {
  loadStoresState,
  saveStores,
  groupByStore,
  readLastStoreId,
  writeLastStoreId,
  aiSortEnabled,
  withLearned,
  UNSORTED,
  type StoreLayout,
} from "../features/storeLayout";
import { inferAislePlacements } from "../features/aiStoreSort";
import { printShoppingList } from "../features/printList";
import { Icon } from "../icons";

export function ListScreen({
  rec,
  familyName,
  dateLabel,
  onToggle,
  onUncheckAll,
  onManageStores,
}: {
  rec: PlanRecord;
  familyName: string | null;
  dateLabel: string;
  onToggle: (canonical: string) => void;
  onUncheckAll: () => void;
  onManageStores: () => void;
}) {
  const plan = rec.data;

  const [stores, setStores] = useState<StoreLayout[]>([]);
  const [storeId, setStoreId] = useState<string>("");
  const [defaultId, setDefaultId] = useState<string>("");
  const [aiNote, setAiNote] = useState<string | null>(null);
  /** Which row has its "move to aisle" picker open. One at a time. */
  const [moving, setMoving] = useState<string | null>(null);
  const askedRef = useRef<Set<string>>(new Set());
  /**
   * Deliberately the STRICT loader. This screen WRITES stores back (the
   * AI-placement effect and the move control below), and `loadStores`
   * fabricates a default layout when the file is unreadable — so the lenient
   * loader here would let that synthetic default overwrite the user's real
   * aisle orders, the exact clobber the jsonDoc split exists to prevent.
   */
  const [storesUnreadable, setStoresUnreadable] = useState(false);
  useEffect(() => {
    loadStoresState().then((r) => {
      if (!r.ok) {
        setStoresUnreadable(true);
        return;
      }
      const { stores: st, defaultId: d } = r.value;
      setStores(st);
      setDefaultId(d);
      const last = readLastStoreId();
      setStoreId(st.some((s) => s.id === last) ? last! : d);
    });
  }, []);

  // Latest stores, for the async AI-placement effect below (which resolves long
  // after the render that started it).
  const storesRef = useRef<StoreLayout[]>(stores);
  storesRef.current = stores;
  const store = stores.find((s) => s.id === storeId) ?? stores[0] ?? null;
  const pickStore = (id: string) => {
    setStoreId(id);
    writeLastStoreId(id);
    setMoving(null);
  };

  /**
   * Grouped by aisle when we have a store layout; a single flat group when we
   * don't.
   *
   * The flat fallback is load-bearing: with no store this used to return `[]`
   * while `total` still counted the items, so the header said "12 to buy" with
   * nothing underneath it. That state is reachable whenever the store file is
   * unreadable — and briefly on every load, before the layout resolves.
   */
  const groups = useMemo(() => {
    const list = plan.shoppingList ?? [];
    if (store) return groupByStore(list, store);
    return list.length > 0 ? [{ aisleId: UNSORTED, aisleName: "Shopping list", items: list }] : [];
  }, [plan, store]);
  const unsorted = useMemo(() => groups.find((g) => g.aisleId === UNSORTED)?.items ?? [], [groups]);

  // Whenever a list has items the store layout doesn't cover, hand the layout to
  // the model and let it place them by analogy to what's already in each aisle.
  // Placements are learned onto the store, so the same items are instant + free
  // next time. Each (store, item) is asked at most once.
  useEffect(() => {
    // storesUnreadable: skip entirely rather than pay for an AI call whose
    // result we must not persist.
    if (!store || storesUnreadable || !aiSortEnabled() || unsorted.length === 0) return;
    const toAsk = unsorted.filter((i) => !askedRef.current.has(`${store.id}:${i.canonical}`));
    if (toAsk.length === 0) return;
    const keys = toAsk.map((i) => `${store.id}:${i.canonical}`);
    keys.forEach((k) => askedRef.current.add(k));
    let cancelled = false;
    void (async () => {
      // "Asked" has to mean ANSWERED. Marking before the call and never
      // unmarking meant one network blip stranded those items in Unsorted for
      // the rest of the session, with no note and no way to retry — the effect
      // simply never looked at them again. On a failure (or an empty answer)
      // the marks come off, so the next render asks once more.
      let placements: Record<string, string> = {};
      try {
        placements = await inferAislePlacements(
          toAsk.map((i) => ({ name: i.name, canonical: i.canonical })),
          store,
        );
      } catch {
        placements = {};
      }
      if (cancelled) return;
      if (Object.keys(placements).length === 0) {
        keys.forEach((k) => askedRef.current.delete(k));
        return;
      }
      // Items the model DID look at but declined to place stay marked: it
      // answered, it just had no aisle for them, and re-asking buys nothing.
      // The write lives outside the state updater: React may invoke an updater
      // more than once for the same change (StrictMode does it deliberately),
      // and each extra invocation would be another VFS write + sync push.
      const next = (storesRef.current ?? []).map((s) =>
        s.id === store.id ? withLearned(s, placements) : s,
      );
      void saveStores({ stores: next, defaultId });
      setStores(next);
      const n = Object.keys(placements).length;
      setAiNote(`Placed ${n} item${n === 1 ? "" : "s"} using your store layout`);
    })();
    return () => {
      cancelled = true;
    };
  }, [store, unsorted, defaultId, storesUnreadable]);

  /**
   * Move one item to an aisle, permanently, for this store.
   *
   * Written as an `itemOverrides` EXCEPTION rather than into `learned`, and
   * that distinction matters twice: user exceptions outrank AI placements in
   * groupByStore, so a correction cannot be undone by a later inference; and
   * the store editor lists exceptions as editable rows, so a correction made
   * here is visible and reversible rather than disappearing into a cache whose
   * only control is "Clear N AI-learned".
   */
  const moveToAisle = (item: ShoppingListItem, aisleId: string) => {
    setMoving(null);
    if (!store || storesUnreadable) return;
    const keyword = item.canonical;
    const next = stores.map((s) =>
      s.id !== store.id
        ? s
        : {
            ...s,
            itemOverrides: [
              // Replace rather than append: moving the same item twice must
              // leave one rule, not two with the first one winning forever.
              ...s.itemOverrides.filter((o) => o.keyword.trim().toLowerCase() !== keyword),
              { keyword, aisleId },
            ],
          },
    );
    setStores(next);
    void saveStores({ stores: next, defaultId });
    setAiNote(null);
  };

  const checked = useMemo(() => new Set(plan.checked ?? []), [plan]);
  const total = (plan.shoppingList ?? []).length;
  const doneCount = (plan.shoppingList ?? []).filter((i) => checked.has(i.canonical)).length;
  const allDone = total > 0 && doneCount === total;

  // Print a purpose-built sheet rather than the app's own DOM — see printList.ts.
  // Items already in the cart still print (struck through): the paper copy is a
  // record of the whole trip, and someone else may be holding it.
  const doPrint = () => {
    // The store layout is read from the VFS, so for the first moments after a
    // plan opens `groups` is empty while `total` isn't. Printing that would
    // hand over a sheet saying "nothing to buy" for a list full of items —
    // fall back to one ungrouped list rather than lie on paper.
    const printGroups =
      groups.length > 0
        ? groups
        : [{ aisleId: "all", aisleName: "Shopping list", items: plan.shoppingList ?? [] }];
    printShoppingList({
      groups: printGroups.map((g) => ({
        aisleName: g.aisleName,
        items: g.items.map((i) => ({
          name: i.name,
          quantity: i.quantity,
          quantityNote: i.quantityNote,
          checked: checked.has(i.canonical),
        })),
      })),
      meals: (plan.picks ?? []).map((p) => p.title),
      dateLabel,
      familyName: rec.familyId ? familyName : null,
      storeName: store?.name ?? null,
    });
  };

  if (total === 0) {
    return (
      <div className="plan-view">
        <div className="empty-state">
          <Icon name="check" className="empty-icon" />
          <div>Nothing to buy — this week is fully covered by what you already have.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="plan-view print-area">
      <div className="print-only print-title">Shopping list — {dateLabel}</div>

      <div className="store-bar no-print">
        <Icon name="store" />
        {stores.length > 1 ? (
          <select
            className="store-bar-select"
            value={store?.id ?? ""}
            onChange={(e) => pickStore(e.target.value)}
            aria-label="Which store"
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="store-bar-name">{store?.name ?? "My store"}</span>
        )}
        <div style={{ flex: 1 }} />
        <button className="link-btn" onClick={onManageStores}>
          Edit store
        </button>
      </div>

      <div className="list-progress no-print">
        <span className="shopping-progress">
          {doneCount === 0 ? (
            `${total} to buy`
          ) : allDone ? (
            <span className="all-done">
              <Icon name="check" /> All {total} in the cart
            </span>
          ) : (
            <>
              {doneCount}/{total} in the cart ·{" "}
              <button className="link-btn" onClick={onUncheckAll}>
                Uncheck all
              </button>
            </>
          )}
        </span>
        <button className="link-btn" onClick={doPrint} title="Print this list">
          <Icon name="print" /> Print
        </button>
      </div>

      {aiNote && (
        <div className="store-ai-note no-print">
          <Icon name="wand" /> {aiNote} · tap Move on any row to correct one
        </div>
      )}

      {storesUnreadable && (
        <div className="status-banner error no-print">
          <Icon name="triangle-exclamation" />
          <span>
            Couldn't read your store layouts, so this list isn't sorted by aisle and moving an
            item won't stick. Everything you need is still here.
          </span>
        </div>
      )}

      {groups.map((g) => (
        <section className="aisle-block" key={g.aisleId}>
          <h3 className="aisle-title">{g.aisleName}</h3>
          <div className="aisle-items">
            {g.items.map((item) => {
              const isChecked = checked.has(item.canonical);
              const isMoving = moving === item.canonical;
              return (
                <div className={`buy-row${isChecked ? " checked" : ""}`} key={item.canonical}>
                  <button
                    type="button"
                    className="buy-main"
                    onClick={() => onToggle(item.canonical)}
                    aria-pressed={isChecked}
                  >
                    <span className="buy-box" aria-hidden="true">
                      {isChecked && <Icon name="check" />}
                    </span>
                    <span className="buy-text">
                      <span className="buy-name">{item.name}</span>
                      {(item.quantity || item.quantityNote) && (
                        <span className="buy-sub">
                          {item.quantity}
                          {item.quantity && item.quantityNote ? " · " : ""}
                          {item.quantityNote}
                        </span>
                      )}
                    </span>
                  </button>
                  {store && !storesUnreadable && (
                    <button
                      type="button"
                      className={`buy-move no-print${isMoving ? " active" : ""}`}
                      aria-expanded={isMoving}
                      aria-label={`Move ${item.name} to another aisle`}
                      onClick={() => setMoving((cur) => (cur === item.canonical ? null : item.canonical))}
                    >
                      Move
                    </button>
                  )}
                  {isMoving && store && (
                    <div className="buy-aisles no-print">
                      <span className="buy-aisles-label">Put {item.name} in</span>
                      <div className="aisle-cats">
                        {store.aisles.map((a) => (
                          <button
                            key={a.id}
                            type="button"
                            className={`cat-chip${a.id === g.aisleId ? " on" : ""}`}
                            onClick={() => moveToAisle(item, a.id)}
                          >
                            {a.name || "Aisle"}
                          </button>
                        ))}
                      </div>
                      <span className="faint">Remembered for {store.name}.</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

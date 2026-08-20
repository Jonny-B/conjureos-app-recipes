import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PantryItem, WeekPlan } from "../types";
import { importVfsPlansOnce, planTitle } from "../features/planStorage";
import {
  deletePlanRecord,
  getMyProfile,
  listPlans,
  savePlanRecord,
  type AppProfile,
  type PlanRecord,
} from "../bridge/recipesApi";
import { subscribeFamilyChannels, type RealtimeHandle } from "../bridge/realtime";
import { PlanWeekScreen } from "./PlanWeekScreen";
import { FamilyScreen } from "./FamilyScreen";
import { StoreEditor } from "./StoreEditor";
import {
  loadStores,
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
import type { PlansIntent, CogItem } from "../App";
import { Icon } from "../icons";

type Scope = "my" | "family";
type Mode = "landing" | "new" | "family" | "stores";

const byUpdated = (a: PlanRecord, b: PlanRecord) => (b.updatedAt || "").localeCompare(a.updatedAt || "");

// Remember the last plan + scope the user viewed, so opening the Plans tab
// reopens exactly where they left off (local-only, per device).
const LAST_VIEW_KEY = "recipes.plans.lastView";
function readLastView(): { scope: Scope; planId: string | null } | null {
  try {
    const s = localStorage.getItem(LAST_VIEW_KEY);
    const v = s ? JSON.parse(s) : null;
    return v && (v.scope === "my" || v.scope === "family") ? v : null;
  } catch {
    return null;
  }
}
function writeLastView(v: { scope: Scope; planId: string | null }): void {
  try {
    localStorage.setItem(LAST_VIEW_KEY, JSON.stringify(v));
  } catch {
    /* private mode / no storage — non-fatal */
  }
}

/**
 * The "Plans" tab. Plans live in the DB (personal + family); the My/Family
 * switch splits them. Family plans sync live: we subscribe (anon key) to each
 * family's Realtime broadcast channel and refetch on any push, and every local
 * edit persists through recipes-db, which broadcasts to the rest of the family.
 */
export function PlansScreen({
  pantry,
  catalogVersion = 0,
  intent = null,
  onIntentConsumed,
  onCogItems,
}: {
  pantry: PantryItem[] | null;
  catalogVersion?: number;
  /** A sub-screen to open, requested from the app-header cog. */
  intent?: PlansIntent | null;
  onIntentConsumed?: () => void;
  /** Contribute plan actions (share / delete) to the header settings sheet. */
  onCogItems?: (items: CogItem[]) => void;
}) {
  const [profile, setProfile] = useState<AppProfile | null>(null);
  const [plans, setPlans] = useState<PlanRecord[] | null>(null);
  const [scope, setScope] = useState<Scope>(() => readLastView()?.scope ?? "my");
  const [mode, setMode] = useState<Mode>("landing");
  const [viewing, setViewing] = useState(0);
  // The last-viewed plan id to restore once, after the first plans load.
  const restoreRef = useRef<string | null>(readLastView()?.planId ?? null);
  const rt = useRef<RealtimeHandle | null>(null);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadPlans = useCallback(async () => {
    const list = await listPlans().catch(() => [] as PlanRecord[]);
    setPlans(list);
  }, []);
  const loadProfile = useCallback(async () => {
    const p = await getMyProfile().catch(() => null);
    setProfile(p);
    return p;
  }, []);

  // Joining or leaving a family changes which plans exist for us, not just the
  // profile — reload both so the list can't keep showing a family's plans after
  // we've left it.
  const familyChanged = useCallback(async () => {
    const p = await loadProfile();
    await loadPlans();
    return p;
  }, [loadProfile, loadPlans]);

  useEffect(() => {
    (async () => {
      await loadProfile();
      await importVfsPlansOnce().catch(() => {});
      await loadPlans();
    })();
  }, [loadProfile, loadPlans]);

  // The exact channel set, as a stable string. Keying the effect on `profile`
  // tore the websocket down and rebuilt it on EVERY profile refresh (each
  // getMyProfile returns a fresh object), so renaming a family or any
  // incidental reload caused a needless reconnect. What actually matters is
  // whether the channel list changed.
  const realtimeUrl = profile?.realtimeUrl ?? "";
  const anonKey = profile?.anonKey ?? "";
  const channelKey = (profile?.families ?? [])
    .map((f) => `family-${f.channelToken}`)
    .sort()
    .join(",");

  // Realtime: subscribe to my families' channels. Any push → debounced refetch
  // (coalesces a burst of edits from another member).
  useEffect(() => {
    if (!anonKey || !realtimeUrl || channelKey === "") {
      rt.current?.close();
      rt.current = null;
      return;
    }
    const channels = channelKey.split(",");
    if (rt.current) {
      rt.current.setChannels(channels); // reconcile in place, keep the socket
      return;
    }
    rt.current = subscribeFamilyChannels({
      url: realtimeUrl,
      anonKey,
      channels,
      onMessage: () => {
        if (refetchTimer.current) clearTimeout(refetchTimer.current);
        refetchTimer.current = setTimeout(() => void loadPlans(), 400);
      },
    });
  }, [realtimeUrl, anonKey, channelKey, loadPlans]);

  // Tear the socket down — and cancel any in-flight debounced refetch, which
  // would otherwise fire ~400ms after unmount and setState on a dead screen.
  useEffect(
    () => () => {
      rt.current?.close();
      rt.current = null;
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
    },
    [],
  );

  const myPlans = useMemo(() => (plans ?? []).filter((p) => !p.familyId).sort(byUpdated), [plans]);
  const familyPlans = useMemo(() => (plans ?? []).filter((p) => p.familyId).sort(byUpdated), [plans]);
  const families = profile?.families ?? [];
  const hasFamilies = families.length > 0;
  /** Stable identity for "which families, called what" — see the cog effect. */
  const familyKey = families.map((f) => `${f.id}:${f.name}`).join(",");
  const familyName = useCallback(
    (id: string | null) => families.find((f) => f.id === id)?.name ?? "Family",
    [families],
  );

  const active = scope === "my" ? myPlans : familyPlans;
  // When plans/scope change: restore the last-viewed plan once (on first load),
  // otherwise snap to the most recent.
  useEffect(() => {
    if (restoreRef.current && plans) {
      const idx = active.findIndex((p) => p.id === restoreRef.current);
      restoreRef.current = null;
      setViewing(idx >= 0 ? idx : 0);
    } else {
      setViewing(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, plans]);

  // Persist where the user is, so the next visit reopens here.
  const currentId = (active[viewing] ?? active[0])?.id ?? null;
  useEffect(() => {
    if (currentId) writeLastView({ scope, planId: currentId });
  }, [currentId, scope]);


  // ── mutations (optimistic where it helps) ──
  // Latest plans, readable from callbacks that outlive the render they were
  // created in (the header-cog actions).
  const plansRef = useRef<PlanRecord[] | null>(null);
  plansRef.current = plans;

  const patchLocal = (rec: PlanRecord) =>
    setPlans((prev) => (prev ? prev.map((p) => (p.id === rec.id ? rec : p)) : prev));

  const persistNewPlan = async (plan: WeekPlan) => {
    // On the Family tab a new plan must land in a FAMILY, not silently become
    // private. Prefer the family whose plan is currently open, else the first
    // one. (The old code only did this when you had exactly one family, so
    // anyone in 2+ families got a private plan without being told.)
    const familyId =
      scope === "family"
        ? (active[viewing] ?? active[0])?.familyId ?? families[0]?.id ?? null
        : null;
    await savePlanRecord({ plan, title: planTitle(plan), familyId });
    await loadPlans();
  };

  const saveData = async (rec: PlanRecord, data: WeekPlan) => {
    patchLocal({ ...rec, data });
    try {
      const saved = await savePlanRecord({ id: rec.id, plan: data });
      patchLocal(saved);
    } catch {
      await loadPlans();
    }
  };
  const toggleChecked = (rec: PlanRecord, canonical: string) => {
    const set = new Set(rec.data.checked ?? []);
    set.has(canonical) ? set.delete(canonical) : set.add(canonical);
    return saveData(rec, { ...rec.data, checked: [...set] });
  };
  const uncheckAll = (rec: PlanRecord) => saveData(rec, { ...rec.data, checked: [] });

  // Both take an ID, not a record. The header-cog effect below only re-runs
  // when the plan's id/scope changes, so a captured record goes stale the
  // moment anything else about the plan does — sharing after ticking items off
  // was re-uploading the pre-tick data and undoing the check-offs.
  const sharePlan = async (planId: string, familyId: string | null) => {
    const rec = plansRef.current?.find((p) => p.id === planId);
    if (!rec) return;
    await savePlanRecord({ id: rec.id, plan: rec.data, title: rec.title, familyId }).catch(() => {});
    await loadPlans();
    setScope(familyId ? "family" : "my");
  };
  const removePlan = async (planId: string) => {
    setPlans((prev) => (prev ? prev.filter((p) => p.id !== planId) : prev));
    await deletePlanRecord(planId).catch(() => {});
    await loadPlans();
  };

  // A header-cog intent (Family / Stores / New) opens that sub-screen.
  useEffect(() => {
    if (!intent) return;
    setMode(intent);
    onIntentConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent]);

  // Contribute the in-view plan's actions (share / make private / delete) to the
  // app-header settings sheet. Cleared when no plan is shown or on unmount.
  const cogPlan = mode === "landing" ? active[viewing] ?? active[0] : undefined;
  useEffect(() => {
    if (!onCogItems) return;
    if (!cogPlan) {
      onCogItems([]);
      return;
    }
    const planId = cogPlan.id;
    const items: CogItem[] = [];
    if (cogPlan.familyId) {
      items.push({ key: "private", label: "Make private", icon: "user", onClick: () => void sharePlan(planId, null) });
    } else {
      for (const f of families) {
        items.push({
          key: `share-${f.id}`,
          label: families.length > 1 ? `Share with ${f.name}` : "Share with family",
          icon: "user",
          onClick: () => void sharePlan(planId, f.id),
        });
      }
    }
    items.push({ key: "delete", label: "Delete plan", icon: "trash-can", danger: true, onClick: () => void removePlan(planId) });
    onCogItems(items);
    return () => onCogItems([]);
    // `familyKey` (not families.length) so renaming a family relabels
    // "Share with <name>" instead of leaving the old name in the sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cogPlan?.id, cogPlan?.familyId, mode, familyKey]);

  // ── routed sub-screens ──
  if (mode === "new") {
    return (
      <PlanWeekScreen
        pantry={pantry}
        catalogVersion={catalogVersion}
        onPersist={persistNewPlan}
        onDone={() => {
          setMode("landing");
          void loadPlans();
        }}
      />
    );
  }
  if (mode === "family") {
    return (
      <FamilyScreen
        profile={profile}
        onChanged={familyChanged}
        onBack={() => {
          setMode("landing");
          void loadProfile();
          void loadPlans();
        }}
      />
    );
  }
  if (mode === "stores") {
    return <StoreEditor onBack={() => setMode("landing")} />;
  }

  if (plans === null) {
    return (
      <div className="center-spinner">
        <div className="spinner" />
      </div>
    );
  }

  const current = active[viewing] ?? active[0];

  return (
    <div className="browse-screen">
      <div className="plans-tabs-row">
        <div className="seg" role="tablist" aria-label="Plan scope">
          <button role="tab" aria-selected={scope === "my"} className={`seg-btn${scope === "my" ? " active" : ""}`} onClick={() => setScope("my")}>
            My plans
          </button>
          <button role="tab" aria-selected={scope === "family"} className={`seg-btn${scope === "family" ? " active" : ""}`} onClick={() => setScope("family")}>
            Family{familyPlans.length ? ` (${familyPlans.length})` : ""}
          </button>
        </div>
        <button className="btn plans-new" onClick={() => setMode("new")} aria-label="New plan">
          <Icon name="plus" /> New
        </button>
      </div>

      {scope === "family" && !hasFamilies ? (
        <div className="home-nudge">
          <Icon name="user" />
          <div>
            <strong>No family yet.</strong> Create one or join with a code, then share plans and
            shopping lists that sync live to everyone.
          </div>
          <button className="btn" onClick={() => setMode("family")}>
            <Icon name="user" /> Set up a family
          </button>
        </div>
      ) : active.length === 0 ? (
        <div className="home-nudge">
          <Icon name="calendar-days" />
          <div>
            {scope === "my" ? (
              <><strong>No plans yet.</strong> Plan a week and get one deduped shopping list.</>
            ) : (
              <><strong>No family plans yet.</strong> Make a new plan here, or share one of yours to the family.</>
            )}
          </div>
          <button className="btn" onClick={() => setMode("new")}>
            <Icon name="calendar-days" /> Plan my week
          </button>
        </div>
      ) : (
        current && (
          <>
            <PlanView
              rec={current}
              isLatest={viewing === 0}
              familyName={current.familyId ? familyName(current.familyId) : null}
              onToggle={(c) => toggleChecked(current, c)}
              onUncheckAll={() => uncheckAll(current)}
              onManageStores={() => setMode("stores")}
            />
            {active.length > 1 && (
              <section className="home-section">
                <div className="home-section-head">
                  <h3>{scope === "my" ? "Previous plans" : "Other family plans"}</h3>
                </div>
                <div className="browse-list">
                  {active.map((p, i) =>
                    i === viewing ? null : (
                      <PlanRow
                        key={p.id}
                        rec={p}
                        familyName={p.familyId ? familyName(p.familyId) : null}
                        onOpen={() => setViewing(i)}
                      />
                    ),
                  )}
                </div>
              </section>
            )}
          </>
        )
      )}
    </div>
  );
}

// ── one saved plan, read-only + check-off ────────────────────────────────

function PlanView({
  rec,
  isLatest,
  familyName,
  onToggle,
  onUncheckAll,
  onManageStores,
}: {
  rec: PlanRecord;
  isLatest: boolean;
  familyName: string | null;
  onToggle: (canonical: string) => void;
  onUncheckAll: () => void;
  onManageStores: () => void;
}) {
  const plan = rec.data;

  // Group the shopping list by the user's selected store layout (personal, VFS).
  const [stores, setStores] = useState<StoreLayout[]>([]);
  const [storeId, setStoreId] = useState<string>("");
  const [defaultId, setDefaultId] = useState<string>("");
  const [aiNote, setAiNote] = useState<string | null>(null);
  const askedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    loadStores().then(({ stores: st, defaultId: d }) => {
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
  };
  const groups = useMemo(
    () => (store ? groupByStore(plan.shoppingList ?? [], store) : []),
    [plan, store],
  );
  const unsorted = useMemo(() => groups.find((g) => g.aisleId === UNSORTED)?.items ?? [], [groups]);

  // Whenever a list has items the store layout doesn't cover, hand the layout to
  // the model and let it place them by analogy to what's already in each aisle.
  // Placements are learned onto the store, so the same items are instant + free
  // next time. Each (store, item) is asked at most once.
  useEffect(() => {
    if (!store || !aiSortEnabled() || unsorted.length === 0) return;
    const toAsk = unsorted.filter((i) => !askedRef.current.has(`${store.id}:${i.canonical}`));
    if (toAsk.length === 0) return;
    toAsk.forEach((i) => askedRef.current.add(`${store.id}:${i.canonical}`));
    let cancelled = false;
    void (async () => {
      const placements = await inferAislePlacements(
        toAsk.map((i) => ({ name: i.name, canonical: i.canonical })),
        store,
      );
      if (cancelled || Object.keys(placements).length === 0) return;
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
  }, [store, unsorted, defaultId]);

  const checked = useMemo(() => new Set(plan.checked ?? []), [plan]);
  const total = (plan.shoppingList ?? []).length;

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
      dateLabel: formatDate(plan.createdAt),
      familyName: rec.familyId ? familyName : null,
      storeName: store?.name ?? null,
    });
  };

  const doneCount = (plan.shoppingList ?? []).filter((i) => checked.has(i.canonical)).length;
  const allDone = total > 0 && doneCount === total;
  const shared = !!rec.familyId;

  return (
    <div className="plan-view print-area">
      <div className="print-only print-title">
        Shopping list — {formatDate(plan.createdAt)}
      </div>
      <div className="plan-view-head">
        <div className="plan-view-tags">
          {isLatest && <span className="plan-latest">Latest</span>}
          {shared && (
            <span className="plan-family-chip">
              <Icon name="user" /> {familyName}
            </span>
          )}
        </div>
        <div className="plan-view-meta muted">
          Planned {formatDate(plan.createdAt)} · {(plan.picks ?? []).length} meal
          {(plan.picks ?? []).length === 1 ? "" : "s"} · {total} to buy
        </div>
      </div>

      <section className="home-section">
        <div className="home-section-head">
          <h3>This week's meals</h3>
        </div>
        <div className="browse-list">
          {(plan.picks ?? []).map((pick) => (
            <div key={pick.id} className="browse-item" style={{ cursor: "default" }}>
              <div className="title-block">
                <div className="title">{pick.title}</div>
                <div className="meta">
                  {pick.haveCount}/{pick.totalCount} on hand
                  {pick.marginalNew.length > 0 && ` · ${pick.marginalNew.length} to buy`}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="home-section">
        <div className="home-section-head">
          <h3>Shopping list</h3>
          {total > 0 && (
            <button className="link-btn no-print" onClick={doPrint} title="Print this list">
              <Icon name="print" /> Print
            </button>
          )}
          {total > 0 && (
            <span className="shopping-progress">
              {doneCount === 0 ? (
                `${total} to buy`
              ) : allDone ? (
                <span className="all-done"><Icon name="check" /> All {total} in the cart</span>
              ) : (
                <>
                  {doneCount}/{total} in the cart ·{" "}
                  <button className="link-btn" onClick={onUncheckAll}>Uncheck all</button>
                </>
              )}
            </span>
          )}
        </div>

        {total > 0 && (
          <div className="store-bar">
            <Icon name="store" />
            {stores.length > 1 ? (
              <select className="store-bar-select" value={store?.id ?? ""} onChange={(e) => pickStore(e.target.value)}>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            ) : (
              <span className="store-bar-name">{store?.name ?? "My store"}</span>
            )}
            <div style={{ flex: 1 }} />
            <button className="link-btn" onClick={onManageStores}>Edit store</button>
          </div>
        )}

        {aiNote && (
          <div className="store-ai-note">
            <Icon name="wand" /> {aiNote}
          </div>
        )}

        {total === 0 ? (
          <div className="empty-state">
            <Icon name="check" className="empty-icon" />
            <div>Nothing to buy — this week is fully covered by what you have.</div>
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.aisleId} className="shopping-group">
              <div className="ing-group-label">{g.aisleName}</div>
              {g.items.map((item) => {
                const isChecked = checked.has(item.canonical);
                return (
                  <button
                    key={item.canonical}
                    type="button"
                    className={`shopping-line check-line${isChecked ? " checked" : ""}`}
                    onClick={() => onToggle(item.canonical)}
                    aria-pressed={isChecked}
                  >
                    <span className="shopping-check" aria-hidden="true">
                      {isChecked && <Icon name="check" />}
                    </span>
                    <div className="shopping-line-main">
                      <span className="shopping-name">{item.name}</span>
                      {item.quantity && <span className="shopping-qty">{item.quantity}</span>}
                      {item.quantityNote && <span className="serves">{item.quantityNote}</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </section>
    </div>
  );
}

function PlanRow({ rec, familyName, onOpen }: { rec: PlanRecord; familyName: string | null; onOpen: () => void }) {
  const titles = (rec.data.picks ?? []).map((p) => p.title).join(", ");
  return (
    <div className="browse-item" onClick={onOpen}>
      <div className="browse-thumb plan-row-icon">
        <Icon name="calendar-days" />
      </div>
      <div className="title-block">
        <div className="title">
          {formatDate(rec.data.createdAt)}
          {familyName && <span className="plan-family-chip inline"><Icon name="user" /> {familyName}</span>}
        </div>
        <div className="meta">
          {(rec.data.picks ?? []).length} meal{(rec.data.picks ?? []).length === 1 ? "" : "s"}
          {titles ? ` · ${titles}` : ""}
        </div>
      </div>
    </div>
  );
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

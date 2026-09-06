import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PantryItem, WeekPlan } from "../types";
import { importVfsPlansOnce, planTitle } from "../features/planStorage";
import { PlanWriter } from "../features/planSync";
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

/**
 * Three-state load, never two. A bare `T | null` forces "still loading" and
 * "the request failed" to share one value, and the screens below then render a
 * confident conclusion about it — "You're not in a family yet", "No family
 * plans yet". Those sentences told a user his family data had been deleted
 * when in fact one fetch hadn't landed. `stale` marks an OK value whose last
 * refresh failed: we keep showing it rather than blanking the screen.
 */
type Loaded<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; value: T; stale?: boolean };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

// Where the user last chose to send a new plan ("my" or a family id). The
// wizard asks every time, but a household that always plans together shouldn't
// have to re-pick "The Blewitts" on every plan.
const LAST_DEST_KEY = "recipes.plans.lastDestination";
function readLastDestination(): string | null {
  try {
    return localStorage.getItem(LAST_DEST_KEY);
  } catch {
    return null;
  }
}
function writeLastDestination(v: string): void {
  try {
    localStorage.setItem(LAST_DEST_KEY, v);
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
  familyEpoch = 0,
}: {
  pantry: PantryItem[] | null;
  catalogVersion?: number;
  /**
   * Bumped by the host when the user joins a family from OUTSIDE this screen
   * (the invite-link prompt). Joining changes which plans exist for us, and the
   * realtime channel we'd otherwise learn it from is listed on the profile —
   * which we haven't reloaded yet — so without this a user who joined while
   * sitting on the Plans tab saw nothing until they navigated away and back.
   */
  familyEpoch?: number;
  /** A sub-screen to open, requested from the app-header cog. */
  intent?: PlansIntent | null;
  onIntentConsumed?: () => void;
  /** Contribute plan actions (share / delete) to the header settings sheet. */
  onCogItems?: (items: CogItem[]) => void;
}) {
  const [profile, setProfile] = useState<Loaded<AppProfile>>({ status: "loading" });
  const [plans, setPlans] = useState<Loaded<PlanRecord[]>>({ status: "loading" });
  const [scope, setScope] = useState<Scope>(() => readLastView()?.scope ?? "my");
  const [mode, setMode] = useState<Mode>("landing");
  const [viewing, setViewing] = useState(0);
  /** A failed share / delete. Rendered on the landing; cleared on the next try. */
  const [actionError, setActionError] = useState<string | null>(null);
  // The last-viewed plan id to restore once, after the first plans load.
  const restoreRef = useRef<string | null>(readLastView()?.planId ?? null);
  const rt = useRef<RealtimeHandle | null>(null);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Shopping-list ticks go through here, not through a whole-blob save per tap
   * — see features/planSync.ts for why (lost ticks, and two shoppers erasing
   * each other). Created once per mount; `overlay` replays anything still
   * queued on top of whatever the server just told us.
   */
  const writerRef = useRef<PlanWriter | null>(null);
  if (!writerRef.current) {
    writerRef.current = new PlanWriter({
      save: (a) => savePlanRecord(a),
      onRecord: (rec) =>
        setPlans((prev) =>
          prev.status === "ok"
            ? { ...prev, value: prev.value.map((p) => (p.id === rec.id ? rec : p)) }
            : prev,
        ),
      onError: (e) => {
        setActionError(`Couldn't save your shopping list — ${errText(e)}`);
        void loadPlansRef.current?.();
      },
    });
  }
  const writer = writerRef.current;

  const loadPlans = useCallback(async () => {
    try {
      // Replay un-acknowledged ticks over the fetched rows: a realtime refetch
      // fires ~400ms after any family edit, and without this it would paint the
      // pre-tap list over a tap the server hasn't confirmed yet.
      setPlans({ status: "ok", value: (await listPlans()).map((p) => writer.overlay(p)) });
    } catch (e) {
      // A failed REFETCH must never blank a list we already have. The realtime
      // refetch fires exactly when another family member edits a plan, so one
      // dropped request showed up as "the family's plans vanished the moment
      // my wife touched one". Keep the list; mark it stale and say so.
      setPlans((prev) =>
        prev.status === "ok" ? { ...prev, stale: true } : { status: "error", message: errText(e) },
      );
    }
    // `writer` comes from a ref and never changes identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The writer outlives the render that built it, so it reaches the CURRENT
  // loadPlans through a ref instead of capturing the first render's copy.
  const loadPlansRef = useRef<(() => Promise<void>) | null>(null);
  loadPlansRef.current = loadPlans;
  const loadProfile = useCallback(async () => {
    try {
      const p = await getMyProfile();
      setProfile({ status: "ok", value: p });
      return p;
    } catch (e) {
      setProfile((prev) =>
        prev.status === "ok" ? { ...prev, stale: true } : { status: "error", message: errText(e) },
      );
      return null;
    }
  }, []);
  /** Re-run both loads from scratch — the "Try again" button on the error card. */
  const retryLoad = useCallback(() => {
    setProfile({ status: "loading" });
    setPlans({ status: "loading" });
    setActionError(null);
    void (async () => {
      await loadProfile();
      await loadPlans();
    })();
  }, [loadProfile, loadPlans]);

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

  // Reload on an external family join. Skipped on mount — the effect above
  // already did the first load, and running both would double-fetch.
  const mountedEpoch = useRef(familyEpoch);
  useEffect(() => {
    if (familyEpoch === mountedEpoch.current) return;
    mountedEpoch.current = familyEpoch;
    void familyChanged();
  }, [familyEpoch, familyChanged]);

  // The exact channel set, as a stable string. Keying the effect on `profile`
  // tore the websocket down and rebuilt it on EVERY profile refresh (each
  // getMyProfile returns a fresh object), so renaming a family or any
  // incidental reload caused a needless reconnect. What actually matters is
  // whether the channel list changed.
  const profileValue = profile.status === "ok" ? profile.value : null;
  const planList = plans.status === "ok" ? plans.value : null;

  const realtimeUrl = profileValue?.realtimeUrl ?? "";
  const anonKey = profileValue?.anonKey ?? "";
  const channelKey = (profileValue?.families ?? [])
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

  const myPlans = useMemo(() => (planList ?? []).filter((p) => !p.familyId).sort(byUpdated), [planList]);
  const familyPlans = useMemo(() => (planList ?? []).filter((p) => p.familyId).sort(byUpdated), [planList]);
  const families = profileValue?.families ?? [];
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
    if (restoreRef.current && planList) {
      const idx = active.findIndex((p) => p.id === restoreRef.current);
      restoreRef.current = null;
      setViewing(idx >= 0 ? idx : 0);
    } else {
      setViewing(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, planList]);

  // Persist where the user is, so the next visit reopens here.
  const currentId = (active[viewing] ?? active[0])?.id ?? null;
  useEffect(() => {
    if (currentId) writeLastView({ scope, planId: currentId });
  }, [currentId, scope]);


  // ── mutations (optimistic where it helps) ──
  // Latest plans, readable from callbacks that outlive the render they were
  // created in (the header-cog actions).
  const plansRef = useRef<PlanRecord[] | null>(null);
  plansRef.current = planList;

  /**
   * Where a new plan lands, PRE-SELECTED for the wizard's final step — not
   * decided there. Inferring it from whichever scope tab happened to be open
   * is what silently privatized plans people meant to share: a freshly-joined
   * member has no saved last-view, lands on "My plans", and every route into
   * the wizard then saved private with nothing on screen saying so.
   *
   * Coming from the Family tab means the family you're looking at; otherwise
   * whatever you picked last time, and personal if you've never picked.
   */
  const defaultFamilyId = (): string | null => {
    if (scope === "family") return (active[viewing] ?? active[0])?.familyId ?? families[0]?.id ?? null;
    const last = readLastDestination();
    return last && last !== "my" && families.some((f) => f.id === last) ? last : null;
  };

  const persistNewPlan = async (plan: WeekPlan, familyId: string | null) => {
    // The destination is now an explicit choice, so a family that doesn't
    // resolve is a REFUSAL, not a fallback to private. The old expression fell
    // through to `null` whenever `families` was empty — reachable any time the
    // profile fetch failed, since this screen remounts on every tab switch.
    if (familyId !== null && !families.some((f) => f.id === familyId)) {
      throw new Error("That family isn't loaded right now, so this plan wasn't shared. Reopen Plans and try again.");
    }
    await savePlanRecord({ plan, title: planTitle(plan), familyId });
    writeLastDestination(familyId ?? "my");
    await loadPlans();
  };

  // Ticks are OPS, not blob writes. `rec` here is what's on screen (server
  // state + anything still queued), so the toggle reads the box the user just
  // looked at, and the op that goes out sets that item to a value rather than
  // uploading a whole list built from data that may already be stale.
  const toggleChecked = (rec: PlanRecord, canonical: string) => {
    const checked = new Set(rec.data.checked ?? []);
    writer.push(rec, { kind: "setChecked", canonical, value: !checked.has(canonical) });
  };
  const uncheckAll = (rec: PlanRecord) => writer.push(rec, { kind: "uncheckAll" });

  // Both take an ID, not a record. The header-cog effect below only re-runs
  // when the plan's id/scope changes, so a captured record goes stale the
  // moment anything else about the plan does — sharing after ticking items off
  // was re-uploading the pre-tick data and undoing the check-offs.
  const sharePlan = async (planId: string, familyId: string | null) => {
    const rec = plansRef.current?.find((p) => p.id === planId);
    if (!rec) return;
    setActionError(null);
    try {
      await savePlanRecord({ id: rec.id, plan: rec.data, title: rec.title, familyId });
    } catch (e) {
      // Swallowing this and switching to the Family tab regardless looked
      // EXACTLY like a successful share landing on an empty family: the plan
      // was still private and nothing on screen said so.
      setActionError(
        `${familyId ? "Couldn't share that plan" : "Couldn't make that plan private"} — ${errText(e)}`,
      );
      await loadPlans();
      return;
    }
    await loadPlans();
    setScope(familyId ? "family" : "my");
  };
  const removePlan = async (planId: string) => {
    setActionError(null);
    setPlans((prev) =>
      prev.status === "ok" ? { ...prev, value: prev.value.filter((p) => p.id !== planId) } : prev,
    );
    try {
      await deletePlanRecord(planId);
    } catch (e) {
      // The optimistic removal above is undone by the reload; without this the
      // plan just reappeared with no explanation.
      setActionError(`Couldn't delete that plan — ${errText(e)}`);
    }
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
      // Only the owner may move a plan out of the family. Offering this to any
      // member meant tapping it made someone else's plan vanish for the whole
      // family — and it didn't land in the tapper's own list either, because
      // ownership never moved. The server enforces this too (forbidden_reassign).
      if (cogPlan.mine) {
        items.push({ key: "private", label: "Make private", icon: "user", onClick: () => void sharePlan(planId, null) });
      }
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
  // The store editor is pure local VFS, so it must not be gated behind a
  // backend load it doesn't use.
  if (mode === "stores") {
    return <StoreEditor onBack={() => setMode("landing")} />;
  }

  const backToLanding = () => {
    setMode("landing");
    void loadProfile();
    void loadPlans();
  };

  // Load state is resolved BEFORE anything that draws a conclusion about the
  // user's data. The Family sub-screen used to render ahead of the spinner
  // guard, so opening cog → Family painted the full "You're not in a family
  // yet" page while its own fetch was still in flight.
  if (mode === "family") {
    if (profile.status === "loading") return <Spinner />;
    if (profile.status === "error") {
      return <LoadError message={profile.message} onRetry={retryLoad} onBack={backToLanding} />;
    }
    return <FamilyScreen profile={profile.value} onChanged={familyChanged} onBack={backToLanding} />;
  }

  if (profile.status === "loading" || plans.status === "loading") return <Spinner />;
  if (profile.status === "error") return <LoadError message={profile.message} onRetry={retryLoad} />;
  if (plans.status === "error") return <LoadError message={plans.message} onRetry={retryLoad} />;

  if (mode === "new") {
    return (
      <PlanWeekScreen
        pantry={pantry}
        catalogVersion={catalogVersion}
        families={families}
        defaultFamilyId={defaultFamilyId()}
        onPersist={persistNewPlan}
        onDone={() => {
          setMode("landing");
          void loadPlans();
        }}
      />
    );
  }

  const current = active[viewing] ?? active[0];

  return (
    <div className="browse-screen">
      {(plans.stale || profile.stale) && (
        <div className="status-banner">
          <Icon name="circle-info" />
          <span>Couldn't refresh just now — showing what loaded last time.</span>
        </div>
      )}
      {actionError && (
        <div className="status-banner error">
          <Icon name="triangle-exclamation" />
          <span>{actionError}</span>
        </div>
      )}
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

function Spinner() {
  return (
    <div className="center-spinner">
      <div className="spinner" />
    </div>
  );
}

/**
 * What a failed load looks like. The point is that it is VISIBLY not an empty
 * state: "no plans yet" and "we couldn't ask" are different facts, and only one
 * of them means the user should go looking for their data.
 */
function LoadError({
  message,
  onRetry,
  onBack,
}: {
  message: string;
  onRetry: () => void;
  onBack?: () => void;
}) {
  return (
    <div className="browse-screen">
      {onBack && (
        <div className="detail-actions">
          <button className="btn ghost" onClick={onBack}>
            <Icon name="chevron-down" className="back-caret" /> Plans
          </button>
        </div>
      )}
      <div className="home-nudge">
        <Icon name="triangle-exclamation" />
        <div>
          <strong>Couldn't reach Recipes.</strong> Check your connection — nothing has been lost,
          we just can't load your plans and families right now.
          {message && (
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {message}
            </div>
          )}
        </div>
        <button className="btn" onClick={onRetry}>
          <Icon name="arrows-rotate" /> Try again
        </button>
      </div>
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

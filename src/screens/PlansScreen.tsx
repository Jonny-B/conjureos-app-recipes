import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PantryItem, PlannedRecipe, WeekPlan } from "../types";
import { prettyIngredient } from "../features/scaling";
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
import {
  subscribeFamilyChannels,
  type PresenceMember,
  type RealtimeHandle,
} from "../bridge/realtime";
import { scoreWeek, scoreSummary } from "../features/weekScore";
import { PlanWeekScreen } from "./PlanWeekScreen";
import { FamilyScreen } from "./FamilyScreen";
import { StoreEditor } from "./StoreEditor";
import { ListScreen } from "./ListScreen";
import type { PlansIntent, CogItem } from "../App";
import { Icon } from "../icons";

type Scope = "my" | "family";
type Mode = "landing" | "new" | "family" | "stores";
/**
 * Which half of a plan this render is about.
 *
 * A week plan is two things — the meals, and the shopping list they add up to —
 * and they are used in two different places: the meals at the kitchen table,
 * the list standing in a shop holding a phone one-handed. They are now two
 * tabs, and App mounts this screen ONCE for both so there is one backend load,
 * one realtime subscription and one PlanWriter between them. Two mounts would
 * mean two writers racing on the same check-offs.
 */
export type PlanFocus = "plan" | "list";

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
  focus = "plan",
  pantry,
  catalogVersion = 0,
  intent = null,
  planSeed = null,
  onIntentConsumed,
  onCogItems,
  familyEpoch = 0,
}: {
  /** Which half of the plan to show — see PlanFocus. */
  focus?: PlanFocus;
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
  /**
   * Ingredient names to open the wizard pre-seeded with. Set when the Pantry's
   * "use these up" block routed here, so the week is planned around exactly
   * the things closest to being thrown out.
   */
  planSeed?: string[] | null;
  onIntentConsumed?: () => void;
  /** Contribute plan actions (share / delete) to the header settings sheet. */
  onCogItems?: (items: CogItem[]) => void;
}) {
  const [profile, setProfile] = useState<Loaded<AppProfile>>({ status: "loading" });
  const [plans, setPlans] = useState<Loaded<PlanRecord[]>>({ status: "loading" });
  const [scope, setScope] = useState<Scope>(() => readLastView()?.scope ?? "my");
  const [mode, setMode] = useState<Mode>("landing");
  /**
   * Which plan the landing is showing, tracked by ID rather than by position.
   *
   * It used to be an index, reset to 0 by an effect keyed on `[scope, planList]`
   * — and every shopping-list tick hands back a NEW plans array (the writer's
   * onRecord maps over it), so ticking an item on any plan but the newest
   * snapped you to the newest one mid-shop. Keyed on identity, a tick is
   * invisible: the id you were looking at is still in the list. `null` means
   * "the newest", which is also where an id that's no longer present resolves
   * to, so a plan deleted underneath us degrades the same way it always did.
   */
  const [viewingId, setViewingId] = useState<string | null>(null);
  /** A failed share / delete. Rendered on the landing; cleared on the next try. */
  const [actionError, setActionError] = useState<string | null>(null);
  /**
   * Who else is on each family channel right now, by channel name.
   *
   * "Share the plan" is only half the pillar — the other half is knowing the
   * other person is actually there, which is what turns a shared plan from a
   * document into a room. Empty is the normal state and renders nothing.
   */
  const [presence, setPresence] = useState<Record<string, PresenceMember[]>>({});
  /** The free-text nudge on the landing, handed to the wizard's mood step. */
  const [nudge, setNudge] = useState("");
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
  /**
   * Our own identity, for presence. In refs rather than in the effect's deps:
   * the socket must not be torn down and rebuilt because a profile refresh
   * handed back a new object with the same id in it.
   */
  const selfIdRef = useRef<string | null>(null);
  const selfNameRef = useRef<string | null>(null);
  selfIdRef.current = profileValue?.userId ?? null;
  selfNameRef.current = profileValue?.username ? `@${profileValue.username}` : null;

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
      // Announce ourselves so the rest of the family can see we're looking at
      // the week too. The key is the user id, which is what presenceMembers
      // filters us out by; the name is whatever we'd be called in the family
      // list, and null is fine (it renders as "someone else").
      presence: { key: selfIdRef.current ?? "", name: selfNameRef.current },
      onPresence: (channel, who) => setPresence((prev) => ({ ...prev, [channel]: who })),
      onMessage: () => {
        if (refetchTimer.current) clearTimeout(refetchTimer.current);
        refetchTimer.current = setTimeout(() => void loadPlans(), 400);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const viewingIdx = viewingId ? active.findIndex((p) => p.id === viewingId) : -1;
  const viewing = viewingIdx >= 0 ? viewingIdx : 0;

  // Restore the last-viewed plan, once, after the first load that contains it.
  useEffect(() => {
    if (!restoreRef.current || !planList) return;
    const id = restoreRef.current;
    restoreRef.current = null;
    if (active.some((p) => p.id === id)) setViewingId(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planList]);

  // The two scope tabs are separate lists; switching starts at the newest.
  useEffect(() => {
    setViewingId(null);
  }, [scope]);

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
  /** A delete waiting on the user's yes — see the cog item that sets it. */
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; shared: boolean } | null>(null);

  const removePlan = async (planId: string) => {
    setConfirmDelete(null);
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

  /**
   * The seed the wizard opens with, captured at the moment the intent arrives.
   *
   * It cannot be read from the prop at render time: `onIntentConsumed` clears
   * it on the host one render later, which would pull the chips back out of a
   * wizard the user is looking at. Held in a ref and cleared when the wizard
   * closes, so opening "New" by hand afterwards starts empty.
   */
  const seededRef = useRef<string[] | null>(null);
  /** Free text the wizard should open its mood step already carrying. */
  const nudgeRef = useRef<string | null>(null);

  // A header-cog intent (Family / Stores / New) opens that sub-screen.
  useEffect(() => {
    if (!intent) return;
    if (intent === "new") seededRef.current = planSeed?.length ? planSeed : null;
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
    // Deletion ASKS first. A shared plan is a week of someone else's meals and
    // their half-ticked shopping list, there is no trash and no undo, and this
    // sat one tap deep in a sheet with no confirmation at all — while
    // reassignment, right above it, was locked to the owner. Personal plans go
    // through the same gate; it costs one tap and the plan is equally gone.
    items.push({
      key: "delete",
      label: "Delete plan",
      icon: "trash-can",
      danger: true,
      onClick: () => setConfirmDelete({ id: planId, shared: !!cogPlan.familyId }),
    });
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
        initialInclude={seededRef.current}
        initialMoodText={nudgeRef.current}
        catalogVersion={catalogVersion}
        families={families}
        defaultFamilyId={defaultFamilyId()}
        onPersist={persistNewPlan}
        onDone={() => {
          seededRef.current = null;
          nudgeRef.current = null;
          setNudge("");
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
      {confirmDelete && (
        <div className="status-banner warn plan-confirm">
          <Icon name="triangle-exclamation" />
          <span>
            {confirmDelete.shared
              ? "Delete this plan for the whole family? Their meals and shopping list go with it, and there's no undo."
              : "Delete this plan? There's no undo."}
          </span>
          <button className="btn secondary" type="button" onClick={() => setConfirmDelete(null)}>
            Keep it
          </button>
          <button className="btn danger" type="button" onClick={() => void removePlan(confirmDelete.id)}>
            Delete
          </button>
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
        <button
          className="btn plans-new"
          onClick={() => {
            seededRef.current = null;
            nudgeRef.current = null;
            setMode("new");
          }}
          aria-label="New plan"
        >
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
          <Icon name={focus === "list" ? "list-check" : "calendar-days"} />
          <div>
            {focus === "list" ? (
              <><strong>No list yet.</strong> The shopping list is what's left over once a week is
              planned around your pantry — plan one and it fills in.</>
            ) : scope === "my" ? (
              <><strong>No plans yet.</strong> Plan a week around what's in your pantry and get one
              deduped shopping list for the rest.</>
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
            {focus === "plan" && (
              <PlanHeader
                rec={current}
                families={families}
                presentMembers={
                  current.familyId
                    ? presence[
                        `family-${families.find((f) => f.id === current.familyId)?.channelToken ?? ""}`
                      ] ?? []
                    : []
                }
                onShare={(familyId) => void sharePlan(current.id, familyId)}
                onSetUpFamily={() => setMode("family")}
              />
            )}
            {focus === "list" ? (
              <ListScreen
                rec={current}
                familyName={current.familyId ? familyName(current.familyId) : null}
                dateLabel={formatDate(current.data.createdAt)}
                onToggle={(c) => toggleChecked(current, c)}
                onUncheckAll={() => uncheckAll(current)}
                onManageStores={() => setMode("stores")}
              />
            ) : (
              <PlanView
                rec={current}
                isLatest={viewing === 0}
                familyName={current.familyId ? familyName(current.familyId) : null}
                dateLabel={formatDate(current.data.createdAt)}
              />
            )}
            {focus === "plan" && (
              <NudgeBox
                value={nudge}
                onChange={setNudge}
                onGo={() => {
                  seededRef.current = null;
                  nudgeRef.current = nudge.trim();
                  setMode("new");
                }}
              />
            )}
            {active.length > 1 && (
              <section className="home-section">
                <div className="home-section-head">
                  <h3>
                    {focus === "list"
                      ? "Another week's list"
                      : scope === "my"
                        ? "Previous plans"
                        : "Other family plans"}
                  </h3>
                </div>
                <div className="browse-list">
                  {active.map((p, i) =>
                    i === viewing ? null : (
                      <PlanRow
                        key={p.id}
                        rec={p}
                        familyName={p.familyId ? familyName(p.familyId) : null}
                        onOpen={() => setViewingId(p.id)}
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
          <strong>Couldn't reach Conjure Pantry.</strong> Check your connection — nothing has been lost,
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

/**
 * One saved plan's MEALS. The shopping list that the same plan adds up to is a
 * separate screen (ListScreen) on its own tab, because the two get used in
 * completely different places — this one at a kitchen table, that one standing
 * in a shop. They share this record, and one PlanWriter, so a tick made while
 * shopping shows up here without a refetch.
 */
function PlanView({
  rec,
  isLatest,
  familyName,
  dateLabel,
}: {
  rec: PlanRecord;
  isLatest: boolean;
  familyName: string | null;
  dateLabel: string;
}) {
  const plan = rec.data;
  const total = (plan.shoppingList ?? []).length;
  const shared = !!rec.familyId;

  return (
    <div className="plan-view">
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
          Planned {dateLabel} · {(plan.picks ?? []).length} meal
          {(plan.picks ?? []).length === 1 ? "" : "s"} · {total} to buy
        </div>
      </div>

      <WeekScoreStrip plan={plan} />

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
                  {pick.category && (
                    <>
                      <span className="pill cat">{pick.category}</span>{" "}
                    </>
                  )}
                  {pick.recipe.cookTime > 0 && `${pick.recipe.cookTime} min`}
                </div>
                <PickChips pick={pick} />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/**
 * The week score: the planner's two objectives, side by side.
 *
 * The planner is trading waste reduction off against variety, and without this
 * strip that trade-off is invisible — a week that came out samey just looks
 * like a bad app. Two numbers and one plain sentence; deliberately not a grade,
 * because a letter score on someone's dinner would be insufferable.
 */
function WeekScoreStrip({ plan }: { plan: WeekPlan }) {
  const s = scoreWeek(plan);
  if (s.meals === 0) return null;
  return (
    <section className="week-score">
      <div className="score-row">
        <div className="score-tile">
          <span className="score-value">{s.pantryUsed}</span>
          <span className="score-label">used up</span>
        </div>
        <div className="score-tile">
          <span className="score-value">{s.varietyUnknown ? "\u2014" : s.cuisines}</span>
          {/* "kinds", not "kinds of meal": the longer label wrapped to two
              lines and left the three tiles sitting at different heights. The
              sentence underneath carries the meaning. */}
          <span className="score-label">{s.cuisines === 1 && !s.varietyUnknown ? "kind" : "kinds"}</span>
        </div>
        <div className="score-tile">
          <span className="score-value">{s.toBuy}</span>
          <span className="score-label">to buy</span>
        </div>
      </div>
      <p className="score-note muted">{scoreSummary(s)}</p>
      {s.cuisineNames.length > 0 && (
        <div className="cov-strip">
          {s.cuisineNames.map((c) => (
            <span key={c} className="token-chip">
              {c}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The same have / short / missing idiom the recipe rows use, built from what a
 * PLANNED pick actually stores (counts and a marginal-buy list) rather than
 * from a CoverageResult the plan never kept.
 */
function PickChips({ pick }: { pick: PlannedRecipe }) {
  if (pick.totalCount === 0) return null;
  const shown = pick.marginalNew.slice(0, 3);
  const extra = pick.marginalNew.length - shown.length;
  return (
    <div className="cov-strip">
      <span className={`cov-chip${pick.marginalNew.length === 0 ? " complete" : ""}`}>
        {pick.haveCount}/{pick.totalCount} have
      </span>
      {shown.map((n) => (
        <span key={n} className="miss-chip">
          {prettyIngredient(n)}
        </span>
      ))}
      {extra > 0 && <span className="more-chip">+{extra} more</span>}
    </div>
  );
}

/**
 * Who this week belongs to, who else is looking at it, and one tap to change
 * that. The cog still carries the full per-family list for the multi-family
 * case; this is the common one — you have one family, and sharing a week
 * should not be a menu dive.
 */
function PlanHeader({
  rec,
  families,
  presentMembers,
  onShare,
  onSetUpFamily,
}: {
  rec: PlanRecord;
  families: { id: string; name: string }[];
  presentMembers: PresenceMember[];
  onShare: (familyId: string | null) => void;
  onSetUpFamily: () => void;
}) {
  const shared = !!rec.familyId;
  const only = families.length === 1 ? families[0] : null;
  return (
    <div className="plan-header-row">
      {shared ? (
        <span className="plan-presence">
          <Icon name="user" />
          {presentMembers.length === 0
            ? "Shared \u00b7 nobody else here right now"
            : presentMembers.length === 1
              ? `${presentMembers[0]!.name ?? "Someone else"} is looking at this too`
              : `${presentMembers.length} others are looking at this`}
        </span>
      ) : (
        <span className="plan-presence faint">
          <Icon name="user" /> Just yours
        </span>
      )}
      {!shared && only && (
        <button className="btn secondary plan-share-btn" onClick={() => onShare(only.id)}>
          <Icon name="user" /> Share with {only.name}
        </button>
      )}
      {!shared && families.length === 0 && (
        <button className="link-btn" onClick={onSetUpFamily}>
          Set up a family
        </button>
      )}
      {shared && rec.mine && (
        <button className="link-btn" onClick={() => onShare(null)}>
          Make private
        </button>
      )}
    </div>
  );
}

/**
 * "Busy Tuesday, no fish."
 *
 * The nudge does not re-plan in place: it opens the wizard with the sentence
 * already in its mood step, which is the one place that owns the planner's
 * inputs (pantry, favourites, blocked recipes, the destination). Re-running it
 * from here would mean a second copy of all of that, drifting from the first.
 * One extra tap, and the user can still adjust the meal count before spending
 * the call.
 */
function NudgeBox({
  value,
  onChange,
  onGo,
}: {
  value: string;
  onChange: (v: string) => void;
  onGo: () => void;
}) {
  return (
    <section className="nudge">
      <label className="nudge-label" htmlFor="plan-nudge">
        Want a different week?
      </label>
      <p className="nudge-sub muted">
        Say what you're after in your own words and it becomes the starting point for the next
        plan.
      </p>
      <div className="nudge-row">
        <input
          id="plan-nudge"
          type="text"
          className="nudge-input"
          value={value}
          maxLength={300}
          placeholder="busy week, two vegetarian nights, nothing with fish"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && value.trim() && onGo()}
        />
        <button className="btn" disabled={!value.trim()} onClick={onGo}>
          <Icon name="wand" /> Re-plan
        </button>
      </div>
    </section>
  );
}

function PlanRow({ rec, familyName, onOpen }: { rec: PlanRecord; familyName: string | null; onOpen: () => void }) {
  const titles = (rec.data.picks ?? []).map((p) => p.title).join(", ");
  return (
    <button type="button" className="browse-item" onClick={onOpen}>
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
    </button>
  );
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

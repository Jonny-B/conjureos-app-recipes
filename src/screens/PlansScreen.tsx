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
import { Icon } from "../icons";

type Scope = "my" | "family";
type Mode = "landing" | "new" | "family";

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
}: {
  pantry: PantryItem[] | null;
  catalogVersion?: number;
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

  useEffect(() => {
    (async () => {
      await loadProfile();
      await importVfsPlansOnce().catch(() => {});
      await loadPlans();
    })();
  }, [loadProfile, loadPlans]);

  // Realtime: (re)subscribe whenever my families change. Any push → debounced
  // refetch (coalesces a burst of edits from another member).
  useEffect(() => {
    rt.current?.close();
    rt.current = null;
    if (!profile?.anonKey || !profile.realtimeUrl || profile.families.length === 0) return;
    rt.current = subscribeFamilyChannels({
      url: profile.realtimeUrl,
      anonKey: profile.anonKey,
      channels: profile.families.map((f) => `family-${f.channelToken}`),
      onMessage: () => {
        if (refetchTimer.current) clearTimeout(refetchTimer.current);
        refetchTimer.current = setTimeout(() => void loadPlans(), 400);
      },
    });
    return () => {
      rt.current?.close();
      rt.current = null;
    };
  }, [profile, loadPlans]);

  const myPlans = useMemo(() => (plans ?? []).filter((p) => !p.familyId).sort(byUpdated), [plans]);
  const familyPlans = useMemo(() => (plans ?? []).filter((p) => p.familyId).sort(byUpdated), [plans]);
  const families = profile?.families ?? [];
  const hasFamilies = families.length > 0;
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
  const patchLocal = (rec: PlanRecord) =>
    setPlans((prev) => (prev ? prev.map((p) => (p.id === rec.id ? rec : p)) : prev));

  const persistNewPlan = async (plan: WeekPlan) => {
    const familyId = scope === "family" && families.length === 1 ? families[0]!.id : null;
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

  const sharePlan = async (rec: PlanRecord, familyId: string | null) => {
    await savePlanRecord({ id: rec.id, plan: rec.data, title: rec.title, familyId }).catch(() => {});
    await loadPlans();
    setScope(familyId ? "family" : "my");
  };
  const removePlan = async (rec: PlanRecord) => {
    setPlans((prev) => (prev ? prev.filter((p) => p.id !== rec.id) : prev));
    await deletePlanRecord(rec.id).catch(() => {});
    await loadPlans();
  };

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
        onChanged={loadProfile}
        onBack={() => {
          setMode("landing");
          void loadProfile();
          void loadPlans();
        }}
      />
    );
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
      <div className="browse-header plans-header">
        <h2>Plans</h2>
        <div className="plans-header-actions">
          <button className="icon-btn" title="Family" aria-label="Family" onClick={() => setMode("family")}>
            <Icon name="user" />
          </button>
          <button className="btn" onClick={() => setMode("new")}>
            <Icon name="plus" /> New plan
          </button>
        </div>
      </div>

      <div className="seg" role="tablist" aria-label="Plan scope">
        <button role="tab" aria-selected={scope === "my"} className={`seg-btn${scope === "my" ? " active" : ""}`} onClick={() => setScope("my")}>
          My plans
        </button>
        <button role="tab" aria-selected={scope === "family"} className={`seg-btn${scope === "family" ? " active" : ""}`} onClick={() => setScope("family")}>
          Family{familyPlans.length ? ` (${familyPlans.length})` : ""}
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
              families={families}
              onToggle={(c) => toggleChecked(current, c)}
              onUncheckAll={() => uncheckAll(current)}
              onShare={(fid) => sharePlan(current, fid)}
              onDelete={() => removePlan(current)}
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
  families,
  onToggle,
  onUncheckAll,
  onShare,
  onDelete,
}: {
  rec: PlanRecord;
  isLatest: boolean;
  familyName: string | null;
  families: AppProfile["families"];
  onToggle: (canonical: string) => void;
  onUncheckAll: () => void;
  onShare: (familyId: string | null) => void;
  onDelete: () => void;
}) {
  const plan = rec.data;
  const byAisle = useMemo(() => {
    const m = new Map<string, typeof plan.shoppingList>();
    for (const item of plan.shoppingList ?? []) {
      const arr = m.get(item.aisle) ?? [];
      arr.push(item);
      m.set(item.aisle, arr);
    }
    return [...m.entries()];
  }, [plan]);

  const checked = useMemo(() => new Set(plan.checked ?? []), [plan]);
  const total = (plan.shoppingList ?? []).length;
  const doneCount = (plan.shoppingList ?? []).filter((i) => checked.has(i.canonical)).length;
  const allDone = total > 0 && doneCount === total;
  const shared = !!rec.familyId;

  return (
    <div className="plan-view">
      <div className="plan-view-head">
        <span className="plan-view-when">
          {isLatest && <span className="plan-latest">Latest</span>}
          {shared && <span className="plan-family-chip"><Icon name="user" /> {familyName}</span>}
          Planned {formatDate(plan.createdAt)}
        </span>
        <span className="muted" style={{ fontSize: 13 }}>
          {(plan.picks ?? []).length} meal{(plan.picks ?? []).length === 1 ? "" : "s"} · {total} to buy
        </span>
      </div>

      {/* Share / privacy + delete */}
      <div className="plan-actions">
        {shared ? (
          <button className="btn ghost" onClick={() => onShare(null)}>
            <Icon name="user" /> Make private
          </button>
        ) : families.length === 1 ? (
          <button className="btn secondary" onClick={() => onShare(families[0]!.id)}>
            <Icon name="user" /> Share with {families[0]!.name}
          </button>
        ) : families.length > 1 ? (
          <select
            className="plan-share-select"
            defaultValue=""
            onChange={(e) => e.target.value && onShare(e.target.value)}
          >
            <option value="" disabled>Share with…</option>
            {families.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        ) : null}
        <div style={{ flex: 1 }} />
        <button className="btn ghost" onClick={onDelete} aria-label="Delete plan">
          <Icon name="trash-can" /> Delete
        </button>
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
        {total === 0 ? (
          <div className="empty-state">
            <Icon name="check" className="empty-icon" />
            <div>Nothing to buy — this week is fully covered by what you have.</div>
          </div>
        ) : (
          byAisle.map(([aisle, items]) => (
            <div key={aisle} className="shopping-group">
              <div className="ing-group-label">{aisle}</div>
              {items.map((item) => {
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
                    <div className="shopping-for">
                      {item.recipes.map((r) => (
                        <span key={r.id} className="pill">{r.title}</span>
                      ))}
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

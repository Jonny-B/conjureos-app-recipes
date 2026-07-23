import { useCallback, useEffect, useMemo, useState } from "react";
import type { PantryItem, WeekPlan } from "../types";
import { listWeekPlans } from "../features/planStorage";
import { PlanWeekScreen } from "./PlanWeekScreen";
import { Icon } from "../icons";

/**
 * The "Plans" tab. Opens the most recent saved plan, lets you flip to any
 * previous one, and start a new plan (the wizard). Plans persist via
 * planStorage (VFS JSON, synced per-user), newest first.
 */
export function PlansScreen({
  pantry,
  catalogVersion = 0,
}: {
  pantry: PantryItem[] | null;
  catalogVersion?: number;
}) {
  const [plans, setPlans] = useState<WeekPlan[] | null>(null);
  const [mode, setMode] = useState<"landing" | "new">("landing");
  // Index into `plans` of the plan currently shown (0 = most recent).
  const [viewing, setViewing] = useState(0);

  const refresh = useCallback(() => {
    listWeekPlans()
      .then((p) => {
        setPlans(p);
        setViewing(0);
      })
      .catch(() => setPlans([]));
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  // The wizard, launched by "New plan" (or from the empty state). On done it
  // returns here and reloads so the new plan is the most recent.
  if (mode === "new") {
    return (
      <PlanWeekScreen
        pantry={pantry}
        catalogVersion={catalogVersion}
        onDone={() => {
          setMode("landing");
          refresh();
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

  // No plans yet → invite the first one.
  if (plans.length === 0) {
    return (
      <div className="browse-screen">
        <div className="browse-header">
          <h2>Plans</h2>
        </div>
        <div className="home-nudge">
          <Icon name="calendar-days" />
          <div>
            <strong>No plans yet.</strong> Plan a week from photos or a craving and get one
            deduped shopping list.
          </div>
          <button className="btn" onClick={() => setMode("new")}>
            <Icon name="calendar-days" /> Plan my week
          </button>
        </div>
      </div>
    );
  }

  const current = plans[viewing] ?? plans[0]!;

  return (
    <div className="browse-screen">
      <div className="browse-header plans-header">
        <h2>Plans</h2>
        <button className="btn" onClick={() => setMode("new")}>
          <Icon name="plus" /> New plan
        </button>
      </div>

      <PlanView plan={current} isLatest={viewing === 0} />

      {plans.length > 1 && (
        <section className="home-section">
          <div className="home-section-head">
            <h3>Previous plans</h3>
          </div>
          <div className="browse-list">
            {plans.map((p, i) =>
              i === viewing ? null : (
                <PlanRow key={p.createdAt + i} plan={p} onOpen={() => setViewing(i)} />
              ),
            )}
          </div>
        </section>
      )}
    </div>
  );
}

// ── one saved plan, read-only ────────────────────────────────────────────

function PlanView({ plan, isLatest }: { plan: WeekPlan; isLatest: boolean }) {
  const byAisle = useMemo(() => {
    const m = new Map<string, typeof plan.shoppingList>();
    for (const item of plan.shoppingList) {
      const arr = m.get(item.aisle) ?? [];
      arr.push(item);
      m.set(item.aisle, arr);
    }
    return [...m.entries()];
  }, [plan]);

  return (
    <div className="plan-view">
      <div className="plan-view-head">
        <span className="plan-view-when">
          {isLatest && <span className="plan-latest">Latest</span>}
          Planned {formatDate(plan.createdAt)}
        </span>
        <span className="muted" style={{ fontSize: 13 }}>
          {plan.picks.length} meal{plan.picks.length === 1 ? "" : "s"} ·{" "}
          {plan.shoppingList.length} to buy
        </span>
      </div>

      <section className="home-section">
        <div className="home-section-head">
          <h3>This week's meals</h3>
        </div>
        <div className="browse-list">
          {plan.picks.map((pick) => (
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
        </div>
        {plan.shoppingList.length === 0 ? (
          <div className="empty-state">
            <Icon name="check" className="empty-icon" />
            <div>Nothing to buy — this week is fully covered by what you have.</div>
          </div>
        ) : (
          byAisle.map(([aisle, items]) => (
            <div key={aisle} className="shopping-group">
              <div className="ing-group-label">{aisle}</div>
              {items.map((item) => (
                <div key={item.canonical} className="shopping-line">
                  <div className="shopping-line-main">
                    <span className="shopping-name">{item.name}</span>
                    {item.quantity && <span className="shopping-qty">{item.quantity}</span>}
                    {item.quantityNote && <span className="serves">{item.quantityNote}</span>}
                  </div>
                  <div className="shopping-for">
                    {item.recipes.map((r) => (
                      <span key={r.id} className="pill">
                        {r.title}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </section>
    </div>
  );
}

// ── a row in the "previous plans" list ───────────────────────────────────

function PlanRow({ plan, onOpen }: { plan: WeekPlan; onOpen: () => void }) {
  const titles = plan.picks.map((p) => p.title).join(", ");
  return (
    <div className="browse-item" onClick={onOpen}>
      <div className="browse-thumb plan-row-icon">
        <Icon name="calendar-days" />
      </div>
      <div className="title-block">
        <div className="title">{formatDate(plan.createdAt)}</div>
        <div className="meta">
          {plan.picks.length} meal{plan.picks.length === 1 ? "" : "s"}
          {titles ? ` · ${titles}` : ""}
        </div>
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

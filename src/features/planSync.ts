/**
 * Serialized, op-based writes for a saved plan (today: shopping-list ticks).
 *
 * The problem this exists to solve: `savePlanRecord` writes the WHOLE WeekPlan
 * blob. Ticking A then B quickly put two requests in flight carrying
 * `checked:[A]` and `checked:[A,B]`; if they landed out of order the stored
 * value ended at `[A]` and B's tick was gone. Even in order, applying the first
 * response — which predates B's tick — momentarily un-ticked B on screen. And
 * two people shopping off the same family list overwrote each other's ticks
 * wholesale, because each was uploading a blob built from what they had read
 * before the other's tap.
 *
 * So a tap is never a snapshot here. It is an OP:
 *
 *   1. Each tap queues `{setChecked, item, value}` — idempotent, per item.
 *   2. Ops for one plan go out ONE request at a time, applied to the last
 *      server state we actually saw. No two blobs are ever in flight.
 *   3. The request carries the `updatedAt` it was built on. The server does a
 *      compare-and-swap and answers `conflict` (with its current row) rather
 *      than overwriting a write we hadn't seen.
 *   4. On conflict we re-apply the still-queued ops onto THAT row and retry.
 *      Because the ops are per-item sets, replaying them onto a co-shopper's
 *      newer list keeps their ticks and adds ours.
 *   5. The screen renders server state with the queue replayed on top
 *      (`overlay`), so a response or a realtime refetch that predates a tap
 *      can't visibly undo it.
 *
 * What this does NOT fix, deliberately:
 *   - Ops live in memory. Closing the app (or switching tabs, which unmounts
 *     the Plans screen) drops anything not yet sent; ticks already sent are
 *     safe. There is no durable outbox.
 *   - `uncheckAll` is a whole-list op by design: replayed onto a co-shopper's
 *     newer list it also clears what they ticked in that window.
 *   - Only the `checked` set merges. Two people editing a plan's meals or
 *     shopping list at once would still be last-write-wins on the whole blob —
 *     nothing in the app edits those after a plan is saved today.
 *   - `expectedUpdatedAt` is optional server-side, so an older client (a family
 *     member who hasn't reloaded the app) still writes blind and can clobber a
 *     concurrent tick. That closes as clients update.
 */

import type { PlanRecord } from "../bridge/recipesApi";
import type { WeekPlan } from "../types";

export type PlanOp =
  | { kind: "setChecked"; canonical: string; value: boolean }
  | { kind: "uncheckAll" };

/** Replay ops onto a plan. Pure; order matters only for repeats of one item. */
export function applyOps(plan: WeekPlan, ops: PlanOp[]): WeekPlan {
  if (ops.length === 0) return plan;
  const checked = new Set(plan.checked ?? []);
  for (const op of ops) {
    if (op.kind === "uncheckAll") checked.clear();
    else if (op.value) checked.add(op.canonical);
    else checked.delete(op.canonical);
  }
  return { ...plan, checked: [...checked] };
}

export interface PlanWriterDeps {
  /** The persistence call. Resolves `conflict` when the CAS was refused. */
  save: (args: {
    id: string;
    plan: WeekPlan;
    expectedUpdatedAt: string;
  }) => Promise<{ plan: PlanRecord; conflict: boolean }>;
  /** Hand the screen a record to render (already overlaid with queued ops). */
  onRecord: (rec: PlanRecord) => void;
  /** A write we gave up on. The screen should reload and say something. */
  onError: (err: unknown, planId: string) => void;
}

/** How many times one batch may lose the CAS before we stop and reload. */
const MAX_CONFLICT_RETRIES = 6;

interface Entry {
  /** Last server state we've seen for this plan. */
  base: PlanRecord;
  /** Ops applied to `base` but not yet acknowledged. */
  queue: PlanOp[];
  running: boolean;
}

export class PlanWriter {
  private entries = new Map<string, Entry>();

  constructor(private deps: PlanWriterDeps) {}

  /** Server state plus everything still queued — what the user should see. */
  overlay(rec: PlanRecord): PlanRecord {
    const e = this.entries.get(rec.id);
    if (!e) return rec;
    if (e.queue.length === 0) {
      // Nothing outstanding, so adopt this as the base: the next tick then
      // writes against what the server actually holds instead of spending a
      // refused round-trip discovering someone else's edit.
      if (!e.running) e.base = rec;
      return rec;
    }
    return { ...rec, data: applyOps(rec.data, e.queue) };
  }

  /** True while any tick for this plan is still unacknowledged. */
  hasPending(planId: string): boolean {
    return (this.entries.get(planId)?.queue.length ?? 0) > 0;
  }

  /** Queue one op against the plan and start (or keep) the write loop going. */
  push(rec: PlanRecord, op: PlanOp): void {
    let e = this.entries.get(rec.id);
    if (!e) {
      e = { base: rec, queue: [], running: false };
      this.entries.set(rec.id, e);
    }
    e.queue.push(op);
    this.deps.onRecord(this.overlay(e.base));
    void this.run(rec.id);
  }

  private async run(planId: string): Promise<void> {
    const e = this.entries.get(planId);
    if (!e || e.running) return;
    e.running = true;
    try {
      while (e.queue.length > 0) {
        // Take a snapshot of the queue but LEAVE it queued: it has to stay in
        // `overlay` until the server has actually accepted it, and it has to be
        // replayable if the CAS is refused.
        const sending = e.queue.slice();
        let attempt = 0;
        for (;;) {
          const res = await this.deps.save({
            id: planId,
            plan: applyOps(e.base.data, sending),
            expectedUpdatedAt: e.base.updatedAt,
          });
          e.base = res.plan; // conflict or not, this is the newest state we know
          if (!res.conflict) break;
          if (++attempt >= MAX_CONFLICT_RETRIES) {
            throw new Error("Couldn't save your shopping list — it kept changing underneath.");
          }
          // Someone else wrote first. Loop: re-apply `sending` onto their row.
        }
        e.queue.splice(0, sending.length);
        this.deps.onRecord(this.overlay(e.base));
      }
    } catch (err) {
      e.queue.length = 0;
      this.deps.onError(err, planId);
    } finally {
      e.running = false;
    }
  }
}

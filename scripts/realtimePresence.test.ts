/**
 * Tests for the presence reducer in src/bridge/realtime.ts.
 *
 * Plain tsx, no framework, same shape as the other script tests.
 *
 * WHY these are unit tests and not an end-to-end one: this code speaks the
 * Phoenix wire protocol to Supabase Realtime over a websocket, and the part
 * most likely to be wrong is the SHAPE handling — metas arrays, phx_ref
 * matching, a leave that empties a key, the same person in two tabs. A socket
 * makes all of that harder to exercise, not easier, so the reducer is a pure
 * function and this drives it directly.
 *
 * The socket plumbing around it (join, track, reconnect) is NOT covered here
 * and has not been run against a live project — see the commit message.
 */
import {
  applyPresenceDiff,
  applyPresenceState,
  presenceMembers,
  type PresenceState,
} from "../src/bridge/realtime";

let failures = 0;
const ok = (cond: boolean, what: string): void => {
  if (cond) return;
  failures++;
  console.error(`  FAIL  ${what}`);
};

const meta = (ref: string, name?: string) => ({ phx_ref: ref, ...(name ? { name } : {}) });
const names = (s: PresenceState, self = "me") => presenceMembers(s, self).map((m) => m.name ?? m.key);

console.log("realtime presence");

// ── presence_state ────────────────────────────────────────────────────────
const state = applyPresenceState({
  me: { metas: [meta("r1", "Jonny")] },
  u2: { metas: [meta("r2", "Sam")] },
});
ok(names(state).length === 1, "the state frame includes us, and we are filtered out");
ok(names(state)[0] === "Sam", `...leaving the other member (got ${names(state)[0]})`);

// Garbage in is an empty room, not a crash: this comes off a socket.
ok(Object.keys(applyPresenceState(null)).length === 0, "a null state frame is an empty room");
ok(Object.keys(applyPresenceState("nope")).length === 0, "a string state frame is an empty room");
ok(Object.keys(applyPresenceState([1, 2])).length === 0, "an array state frame is an empty room");

// ── presence_diff: joins ──────────────────────────────────────────────────
let s = applyPresenceDiff(state, { joins: { u3: { metas: [meta("r3", "Ali")] } }, leaves: {} });
ok(names(s).join(",") === "Sam,Ali", `a join adds a member (got ${names(s).join(",")})`);

// The same person in a second tab is ONE member, not two.
s = applyPresenceDiff(s, { joins: { u2: { metas: [meta("r9", "Sam")] } }, leaves: {} });
ok(names(s).join(",") === "Sam,Ali", "a second tab for someone already here does not duplicate them");
ok(s["u2"]?.metas?.length === 2, "...but both of their metas are tracked");

// A repeated join for a ref we already hold must not double the meta — that
// would make one tab look like two and outlive the real leave.
s = applyPresenceDiff(s, { joins: { u2: { metas: [meta("r9", "Sam")] } }, leaves: {} });
ok(s["u2"]?.metas?.length === 2, "a re-sent join for a known phx_ref is idempotent");

// ── presence_diff: leaves ─────────────────────────────────────────────────
s = applyPresenceDiff(s, { joins: {}, leaves: { u2: { metas: [meta("r9")] } } });
ok(names(s).join(",") === "Sam,Ali", "closing one of two tabs keeps the person here");
s = applyPresenceDiff(s, { joins: {}, leaves: { u2: { metas: [meta("r2")] } } });
ok(names(s).join(",") === "Ali", `closing the last tab removes them (got ${names(s).join(",")})`);
ok(!("u2" in s), "...and the key is dropped, not left as an empty metas array");

// A leave for someone who was never here changes nothing.
const before = JSON.stringify(s);
s = applyPresenceDiff(s, { joins: {}, leaves: { ghost: { metas: [meta("rX")] } } });
ok(JSON.stringify(s) === before, "a leave for an unknown key is a no-op");

// A malformed diff must leave the room as it was rather than emptying it —
// showing "nobody here" because of one bad frame is worse than showing stale.
ok(applyPresenceDiff(s, null) === s, "a null diff returns the same state object");
ok(JSON.stringify(applyPresenceDiff(s, {})) === JSON.stringify(s), "an empty diff changes nothing");

// ── member shape ──────────────────────────────────────────────────────────
const anon = applyPresenceState({ u7: { metas: [meta("r7")] } });
ok(presenceMembers(anon, "me")[0]?.name === null, "a peer with no name reports null, not an empty string");
const blank = applyPresenceState({ u7: { metas: [meta("r7", "   ")] } });
ok(presenceMembers(blank, "me")[0]?.name === null, "a whitespace-only name is treated as none");
const padded = applyPresenceState({ u7: { metas: [meta("r7", "  Sam  ")] } });
ok(presenceMembers(padded, "me")[0]?.name === "Sam", "a name is trimmed");
const noMetas = applyPresenceState({ u7: {} });
ok(presenceMembers(noMetas, "me").length === 1, "a key with no metas is still a member");

// Order is stable, so the row doesn't reshuffle on every heartbeat.
const jumbled = applyPresenceState({
  zed: { metas: [meta("r1", "Zed")] },
  abe: { metas: [meta("r2", "Abe")] },
});
ok(names(jumbled).join(",") === "Abe,Zed", "members come back in a stable key order");

if (failures) {
  console.error(`\n${failures} presence test${failures === 1 ? "" : "s"} failed.`);
  process.exit(1);
}
console.log("All presence tests passed.");

/**
 * Tests for src/features/reroll.ts: swapping one planned meal must leave every
 * other meal exactly where it was (ConjureOS #620). Plain tsx, like
 * theme.test.ts.
 */
import { spliceReroll } from "../src/features/reroll";

let failures = 0;
const eq = (got: unknown, want: unknown, what: string): void => {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  failures++;
  console.error(`  FAIL  ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};
const m = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

// The server honours the pins: keepers first, then the fill.
eq(ids(spliceReroll(m("a", "b", "c"), "b", m("a", "c", "d"))), ["a", "d", "c"], "middle slot swapped in place");
eq(ids(spliceReroll(m("a", "b", "c"), "c", m("a", "b", "d"))), ["a", "b", "d"], "last slot swapped in place");
eq(ids(spliceReroll(m("a", "b", "c"), "a", m("b", "c", "d"))), ["d", "b", "c"], "first slot swapped in place");

// The server ignored the pins and sent a whole new week: only one slot changes.
eq(ids(spliceReroll(m("a", "b", "c"), "c", m("x", "y", "z"))), ["a", "b", "x"], "a whole new week still changes one meal");

// The server dropped a keeper: it stays on screen anyway.
eq(ids(spliceReroll(m("a", "b", "c"), "b", m("a", "d"))), ["a", "d", "c"], "a dropped pin is kept");

// Nothing new came back: the rejected meal goes, the rest stay.
eq(ids(spliceReroll(m("a", "b", "c"), "b", m("a", "c"))), ["a", "c"], "no replacement leaves the keepers");

// The rejected meal is never handed straight back.
eq(ids(spliceReroll(m("a", "b"), "b", m("a", "b"))), ["a"], "the rejected meal does not return");

if (failures > 0) {
  console.error(`reroll: ${failures} failing`);
  process.exit(1);
}
console.log("reroll: 7 cases pass");

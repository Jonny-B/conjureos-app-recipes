/**
 * Tests for scripts/pack-pin.ts — the @conjureos/pack pin guard.
 *
 * Plain tsx, no test framework, matching scripts/theme.test.ts: this repo has
 * no runner and adding one for a third script would cost more than it returns.
 * Run with `npm test`.
 *
 * The cases that matter are the two the guard exists to catch, so both are
 * asserted against the ACTUAL historical bad state (pin `^0.1.1` + lockfile
 * 0.1.1 against CI's `^0.2.0`) rather than a synthetic one — if the guard
 * would not have failed on the state conjureos-app-recipes#76 reported, it is
 * not doing its job. Fixtures are written to a temp dir, so the test never
 * depends on this repo's current (correct) pin to prove a failure.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPECTED_CI_LINE,
  check,
  lineOf,
  lockedVersion,
  parseRange,
  parseVersion,
  satisfies,
} from "./pack-pin";

let failures = 0;
const ok = (cond: boolean, what: string): void => {
  if (cond) return;
  failures++;
  console.error(`  FAIL  ${what}`);
};

/** A throwaway repo root: our package.json + lockfile, and optionally a
 *  ConjureOS checkout at .conjureos/ the way the publish workflow lays it out. */
function fixture(opts: {
  pin: string;
  locked: string | null;
  ciPin?: string;
}): string {
  const root = mkdtempSync(join(tmpdir(), "packpin-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ devDependencies: { "@conjureos/pack": opts.pin } }),
  );
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({
      packages: opts.locked
        ? { "node_modules/@conjureos/pack": { version: opts.locked } }
        : {},
    }),
  );
  if (opts.ciPin) {
    const dir = join(root, ".conjureos", "scripts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { "@conjureos/pack": opts.ciPin } }),
    );
  }
  return root;
}

const roots: string[] = [];
const at = (opts: { pin: string; locked: string | null; ciPin?: string }) => {
  const r = fixture(opts);
  roots.push(r);
  return r;
};

// --- range parsing -------------------------------------------------------
// Caret-on-0.x is the whole reason the skew was invisible, so it is pinned
// down explicitly: npm reads the minor as the major below 1.0.
{
  const r = parseRange("^0.2.0");
  ok(satisfies("0.2.0", r), "^0.2.0 includes its own floor 0.2.0");
  ok(satisfies("0.2.7", r), "^0.2.0 includes 0.2.7 (what CI floats to)");
  ok(!satisfies("0.3.0", r), "^0.2.0 EXCLUDES 0.3.0 — caret on 0.x stops at the minor");
  ok(!satisfies("0.1.9", r), "^0.2.0 excludes anything below its floor");

  const r1 = parseRange("^0.1.1");
  ok(satisfies("0.1.5", r1), "^0.1.1 includes 0.1.5 (what npm install floated to)");
  ok(!satisfies("0.2.0", r1), "^0.1.1 excludes 0.2.0 (what CI built on)");

  // Above 1.0 the caret behaves the ordinary way.
  const r2 = parseRange("^1.2.3");
  ok(satisfies("1.9.9", r2), "^1.2.3 includes 1.9.9");
  ok(!satisfies("2.0.0", r2), "^1.2.3 excludes 2.0.0");

  const tilde = parseRange("~0.2.1");
  ok(satisfies("0.2.9", tilde), "~0.2.1 includes 0.2.9");
  ok(!satisfies("0.3.0", tilde), "~0.2.1 excludes 0.3.0");

  const exact = parseRange("0.2.7");
  ok(satisfies("0.2.7", exact), "exact 0.2.7 includes itself");
  ok(!satisfies("0.2.8", exact), "exact 0.2.7 excludes 0.2.8");

  ok(parseVersion("0.2.7-beta.1")[2] === 7, "a prerelease tail parses to its numbers");
  let threw = false;
  try {
    parseRange(">=0.2.0 <0.3.0");
  } catch {
    threw = true;
  }
  ok(threw, "an unsupported range form throws rather than being guessed at");

  ok(lineOf(parseRange("^0.2.0")) === "0.2", "lineOf ^0.2.0 is 0.2");
  ok(lineOf(parseRange("^1.4.0")) === "1", "lineOf ^1.4.0 is 1");
}

// --- the historical bug, as reported in #76 ------------------------------
{
  const r = check(at({ pin: "^0.1.1", locked: "0.1.1", ciPin: "^0.2.0" }));
  ok(r.errors.length > 0, "the #76 state fails the guard");
  ok(
    r.errors.some((e) => e.includes("OLDER than")),
    "it is named as older than CI can resolve",
  );
  ok(r.ciRange === "^0.2.0", "CI's range is read from the ConjureOS checkout");
  ok(r.ciSource !== null, "and the source file is reported");
}

// --- lockfile disagreeing with the declared range ------------------------
// pin ^0.2.0 + lockfile 0.1.1: `npm ci` installs 0.1.1, `npm install` floats
// to 0.2.x. Same commit, two different bundlers.
{
  const r = check(at({ pin: "^0.2.0", locked: "0.1.1", ciPin: "^0.2.0" }));
  ok(
    r.errors.some((e) => e.includes("does not satisfy the declared range")),
    "a lockfile outside the declared range is caught",
  );
}

// --- newer than CI is also wrong ----------------------------------------
// The tempting "just bump to npm latest" move: 0.5.0 is unreachable from
// CI's ^0.4.0, so it breaks the gate in the opposite direction.
{
  const r = check(at({ pin: "^0.5.0", locked: "0.5.0", ciPin: "^0.4.0" }));
  ok(
    r.errors.some((e) => e.includes("NEWER than")),
    "being ahead of CI fails too, not just being behind",
  );
}

// --- the healthy state passes -------------------------------------------
{
  const r = check(at({ pin: "^0.4.0", locked: "0.4.0", ciPin: "^0.4.0" }));
  ok(r.errors.length === 0, `aligned 0.4.x state passes (got: ${r.errors.join("; ")})`);
}

// --- CI moving on tells you to update the fallback ----------------------
{
  const r = check(at({ pin: "^0.3.0", locked: "0.3.0", ciPin: "^0.3.0" }));
  ok(
    r.errors.some((e) => e.includes("EXPECTED_CI_LINE")),
    "if CI moves to a new line, the stale hardcoded fallback is flagged",
  );
}

// --- offline fallback ----------------------------------------------------
// No ConjureOS checkout: the guard still catches a pin off CI's line, and says
// it ran in the weaker mode.
{
  const r = check(at({ pin: "^0.1.1", locked: "0.1.1" }));
  ok(r.ciSource === null, "no ConjureOS checkout is reported as such");
  ok(
    r.notes.some((n) => n.includes("EXPECTED_CI_LINE")),
    "the fallback mode is stated, not silent",
  );
  ok(
    r.errors.some((e) => e.includes(`${EXPECTED_CI_LINE}.x`)),
    "and an off-line pin still fails without ConjureOS present",
  );

  const good = check(at({ pin: "^0.4.0", locked: "0.4.0" }));
  ok(good.errors.length === 0, "an on-line pin passes in fallback mode");
}

// --- malformed inputs fail loudly ---------------------------------------
{
  let threw = false;
  try {
    check(at({ pin: "^0.2.7", locked: null }));
  } catch (e) {
    threw = (e as Error).message.includes("no top-level entry");
  }
  ok(threw, "a lockfile with no top-level pack entry throws");

  ok(
    lockedVersion(
      { packages: { "node_modules/x/node_modules/@conjureos/pack": { version: "9.9.9" } } },
      "@conjureos/pack",
    ) === null,
    "a nested copy is not mistaken for the top-level install",
  );
}

for (const r of roots) rmSync(r, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\npack-pin.test.ts: ${failures} failure(s)`);
  process.exit(1);
}
console.log("pack-pin.test.ts: all passed");

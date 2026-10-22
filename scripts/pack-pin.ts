/**
 * The @conjureos/pack pin guard.
 *
 * Why this exists: `npm run build` is this repo's publish gate, and it is only
 * evidence about the store build if the bundler it runs is the bundler CI runs.
 * Those are two separate installs of @conjureos/pack — ours (this repo's
 * node_modules) and CI's (ConjureOS `scripts/`) — so nothing structural keeps
 * them equal. It has already drifted twice: this repo sat on 0.1.1 while CI
 * built on 0.2.x, a minor-version bundler gap across the exact boundary the
 * gate is supposed to prove, and the docs that were meant to catch it cited
 * the wrong version. See conjureos-app-recipes#76 and ConjureOS#726.
 *
 * Two distinct failures are checked, because they have different causes:
 *
 *   1. Our lockfile does not satisfy our own declared range. Then `npm ci`
 *      (CI's and a fresh clone's path) and `npm install` (what a developer
 *      runs) install DIFFERENT bundlers, so two people on this repo get
 *      different build behavior from the same commit. This is the one that
 *      actually bit us: pin `^0.1.1`, lockfile 0.1.1, caret permitting 0.1.5.
 *
 *   2. Our locked version is one CI could never resolve. Then a green local
 *      build says nothing about the store build. Note this fires in BOTH
 *      directions — being newer than CI is just as wrong as being older,
 *      which is why "bump to npm latest" is not the fix.
 *
 * When ConjureOS is checked out alongside (the publish workflow puts it at
 * `.conjureos`), CI's range is read from the horse's mouth. Otherwise we fall
 * back to EXPECTED_CI_LINE below — a hardcoded expectation is exactly the
 * thing that rotted last time, so it is checked against the real file whenever
 * one is reachable, and the CLI says which mode it ran in.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** ConjureOS `scripts/package.json` declares `^0.4.0`. Used only when that
 *  file is not reachable; bump it in the same commit that bumps the pin. */
export const EXPECTED_CI_LINE = "0.4";

export const PACK = "@conjureos/pack";

export interface Range {
  raw: string;
  min: [number, number, number];
  /** Exclusive upper bound. */
  max: [number, number, number];
}

export function parseVersion(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) throw new Error(`unparseable version: ${JSON.stringify(v)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Parse the range forms that actually appear in these package.json files:
 * `^x.y.z`, `~x.y.z` and an exact `x.y.z`. Deliberately not a full semver
 * implementation — an unrecognized form throws rather than being guessed at,
 * because silently mis-parsing a range is how this check would lie.
 *
 * Caret on 0.x is the subtle one and the case we live on: npm treats `^0.1.1`
 * as >=0.1.1 <0.2.0 (the minor acts as the major below 1.0), NOT <1.0.0. That
 * is why `^0.2.0` cannot reach 0.3.0.
 */
export function parseRange(raw: string): Range {
  const spec = raw.trim();
  const op = spec[0] === "^" || spec[0] === "~" ? spec[0] : "";
  const [maj, min, pat] = parseVersion(op ? spec.slice(1) : spec);
  if (!op) return { raw: spec, min: [maj, min, pat], max: [maj, min, pat + 1] };
  if (op === "~") return { raw: spec, min: [maj, min, pat], max: [maj, min + 1, 0] };
  const max: [number, number, number] =
    maj === 0 ? [0, min + 1, 0] : [maj + 1, 0, 0];
  return { raw: spec, min: [maj, min, pat], max };
}

const cmp = (a: [number, number, number], b: [number, number, number]): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

export function satisfies(version: string, range: Range): boolean {
  const v = parseVersion(version);
  return cmp(v, range.min) >= 0 && cmp(v, range.max) < 0;
}

/** The `0.2` style line a range sits on, for the fallback comparison. */
export function lineOf(range: Range): string {
  const [maj, min] = range.min;
  return maj === 0 ? `0.${min}` : `${maj}`;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function depRange(pkg: Record<string, unknown>, name: string): string | null {
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = pkg[field] as Record<string, string> | undefined;
    if (deps && typeof deps[name] === "string") return deps[name];
  }
  return null;
}

/** The version `npm ci` will install, straight out of our lockfile. */
export function lockedVersion(lock: Record<string, unknown>, name: string): string | null {
  const packages = lock.packages as Record<string, { version?: string }> | undefined;
  if (!packages) return null;
  // Only the top-level install counts; a nested copy under another dep is a
  // different resolution and must not be mistaken for ours.
  const entry = packages[`node_modules/${name}`];
  return entry?.version ?? null;
}

/** Where ConjureOS's publish CLI may be found, best source first. */
export function ciPackageCandidates(root: string): string[] {
  return [
    // The publish workflow checks ConjureOS out here.
    join(root, ".conjureos", "scripts", "package.json"),
    // A developer with the repos side by side, as they are on this account.
    join(root, "..", "ConjureOS", "scripts", "package.json"),
  ];
}

export interface CheckResult {
  errors: string[];
  notes: string[];
  ourRange: string;
  locked: string;
  ciRange: string | null;
  ciSource: string | null;
}

export function check(root: string): CheckResult {
  const errors: string[] = [];
  const notes: string[] = [];

  const ourRaw = depRange(readJson(join(root, "package.json")), PACK);
  if (!ourRaw) throw new Error(`${PACK} is not a dependency of this repo`);
  const ours = parseRange(ourRaw);

  const locked = lockedVersion(readJson(join(root, "package-lock.json")), PACK);
  if (!locked) throw new Error(`${PACK} has no top-level entry in package-lock.json`);

  // Failure 1 — `npm ci` and `npm install` would disagree.
  if (!satisfies(locked, ours)) {
    errors.push(
      `package-lock.json resolves ${PACK}@${locked}, which does not satisfy the ` +
        `declared range "${ourRaw}". \`npm ci\` would install ${locked} while ` +
        `\`npm install\` floats elsewhere, so two developers on this commit get ` +
        `different bundler behavior. Fix: npm install ${PACK}@"${ourRaw}" and ` +
        `commit the lockfile.`,
    );
  }

  const ciPath = ciPackageCandidates(root).find((p) => existsSync(p)) ?? null;
  let ciRange: string | null = null;

  if (ciPath) {
    ciRange = depRange(readJson(ciPath), PACK);
    if (!ciRange) {
      errors.push(`${ciPath} no longer declares ${PACK}; this guard needs updating.`);
    } else {
      notes.push(`CI range read from ${ciPath}: "${ciRange}"`);
      const ci = parseRange(ciRange);
      // Failure 2 — a local build CI could not reproduce, in either direction.
      if (!satisfies(locked, ci)) {
        const direction =
          cmp(parseVersion(locked), ci.min) < 0 ? "OLDER than" : "NEWER than";
        errors.push(
          `${PACK}@${locked} (our lockfile) is ${direction} anything CI can ` +
            `resolve from "${ciRange}". A passing \`npm run build\` is then not ` +
            `evidence about the store build. Align this repo with the ${lineOf(ci)}.x ` +
            `line, or bump ConjureOS scripts/package.json first.`,
        );
      }
      if (lineOf(ci) !== EXPECTED_CI_LINE) {
        errors.push(
          `CI has moved to the ${lineOf(ci)}.x line but EXPECTED_CI_LINE in ` +
            `scripts/pack-pin.ts still says ${EXPECTED_CI_LINE}. Update it (and the ` +
            `docs that cite the line) so the offline fallback stays true.`,
        );
      }
    }
  } else {
    notes.push(
      `ConjureOS scripts/package.json not reachable; falling back to ` +
        `EXPECTED_CI_LINE=${EXPECTED_CI_LINE}. This is the weaker check — the ` +
        `authoritative one runs in the publish workflow, where ConjureOS is ` +
        `checked out at .conjureos/.`,
    );
    if (lineOf(ours) !== EXPECTED_CI_LINE) {
      errors.push(
        `${PACK} is pinned "${ourRaw}" (the ${lineOf(ours)}.x line) but CI builds ` +
          `anchor apps on ${EXPECTED_CI_LINE}.x. Do not bump to npm \`latest\`: CI ` +
          `cannot reach it, so that recreates the skew in the opposite direction.`,
      );
    }
  }

  return { errors, notes, ourRange: ourRaw, locked, ciRange, ciSource: ciPath };
}

function main(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const r = check(root);
  for (const n of r.notes) console.log(`[pack-pin] ${n}`);
  console.log(`[pack-pin] declared "${r.ourRange}", lockfile ${r.locked}`);
  if (r.errors.length === 0) {
    console.log("[pack-pin] OK");
    return;
  }
  for (const e of r.errors) console.error(`[pack-pin] FAIL  ${e}`);
  process.exit(1);
}

// Run only when invoked directly, so the test can import the logic.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

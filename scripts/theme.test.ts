/**
 * Tests for src/theme.ts — Recipes' one remaining appearance lever: light or
 * dark. The palette is asserted constant throughout, because that is exactly
 * the thing a regression here would silently undo.
 *
 * Plain tsx, no test framework. The repo has no runner and the only other
 * script here already runs under `npx -y tsx`, so adding vitest for one file
 * would cost more than it returns. Run with `npm test`.
 *
 * `createAppearance(win)` takes the window it should drive, so each case gets
 * a fake one: a documentElement that records attributes, a localStorage, and a
 * message listener. Assertions are written against what lands on <html>,
 * because that is the whole contract — everything else is bookkeeping.
 */
import { readFileSync } from "node:fs";
import { createAppearance, type Appearance } from "../src/theme";

let failures = 0;
const ok = (cond: boolean, what: string): void => {
  if (cond) return;
  failures++;
  console.error(`  FAIL  ${what}`);
};

interface Env {
  win: Window & typeof globalThis;
  attrs: Record<string, string>;
  store: Record<string, string>;
  /** Pretend ConjureOS injected an appearance before the app booted. Takes a
   *  theme too, exactly like the real shim does — theme.ts must ignore it. */
  inject(theme: string | null, flavor: string | null): void;
  /** Push an appearance the way the shell's broadcast does. */
  fromShell(theme: string | null, flavor: string | null): void;
  /** The same message from a page that is not the embedder. */
  fromElsewhere(theme: string | null, flavor: string | null): void;
  /** Another tab writing this app's stored choice — real localStorage is
   *  shared, so the write lands in `store` too, then the `storage` event
   *  fires here exactly as it would in a second real tab. */
  fromOtherTab(flavor: string | null): void;
  /** The raw `storage` event a write or `removeItem` elsewhere causes here.
   *  Lower-level than fromOtherTab, for the cases it does not cover: a
   *  different key, and a removal (`newValue: null`). */
  fireStorage(key: string, newValue: string | null): void;
  posted: unknown[];
}

function makeEnv({ embedded = true }: { embedded?: boolean } = {}): Env {
  const attrs: Record<string, string> = {};
  const store: Record<string, string> = {};
  const posted: unknown[] = [];
  let onMessage: ((ev: MessageEvent) => void) | null = null;
  let onStorage: ((ev: StorageEvent) => void) | null = null;

  const parent = { postMessage: (m: unknown) => posted.push(m) };
  const win = {
    document: {
      documentElement: {
        setAttribute: (k: string, v: string) => {
          attrs[k] = v;
        },
        removeAttribute: (k: string) => {
          delete attrs[k];
        },
      },
    },
    localStorage: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    },
    addEventListener: (type: string, fn: (ev: unknown) => void) => {
      if (type === "message") onMessage = fn;
      if (type === "storage") onStorage = fn;
    },
  } as unknown as Window & typeof globalThis;
  // Standalone is modelled as parent === self, which is what a top-level page
  // actually looks like.
  (win as unknown as { parent: unknown }).parent = embedded ? parent : win;

  const fire = (source: unknown, theme: string | null, flavor: string | null) =>
    onMessage?.({ data: { type: "conjureos:theme", theme, flavor }, source } as MessageEvent);

  const fireStorage = (key: string, newValue: string | null) =>
    onStorage?.({ key, newValue } as StorageEvent);

  return {
    win,
    attrs,
    store,
    posted,
    inject: (theme, flavor) => {
      (win as unknown as { __conjureos: unknown }).__conjureos = { appearance: { theme, flavor } };
    },
    fromShell: (theme, flavor) => fire(parent, theme, flavor),
    fromElsewhere: (theme, flavor) => fire({}, theme, flavor),
    fromOtherTab: (flavor) => {
      // Real localStorage is shared storage: another tab's write lands here
      // too, which is exactly what makes a plain re-read the right fix.
      store[STORAGE_KEY] = JSON.stringify({ flavor });
      fireStorage(STORAGE_KEY, store[STORAGE_KEY]!);
    },
    fireStorage,
  };
}

const STORAGE_KEY = "conjureos.recipes.appearance";
const stored = (e: Env): { flavor?: unknown } | null =>
  e.store[STORAGE_KEY] ? JSON.parse(e.store[STORAGE_KEY]!) : null;

const tests: Record<string, () => void> = {
  "the palette is always spr, with nothing else set"() {
    const e = makeEnv();
    createAppearance(e.win).init();
    ok(e.attrs["data-theme"] === "spr", "spr written even with no OS and no stored choice");
    ok(!("data-flavor" in e.attrs), "no flavor attribute: the browser's own preference decides");
  },

  "the palette stays spr even when ConjureOS injects a different one"() {
    // theme.ts must ignore the theme field of the shim entirely, not merely
    // let the user's axis outrank it — there is no axis for it any more.
    const e = makeEnv();
    e.inject("win", "light");
    const a = createAppearance(e.win).init();
    ok(e.attrs["data-theme"] === "spr", "spr, not the injected win");
    ok(e.attrs["data-flavor"] === "light", "flavor from the shim still applies");
    ok(a.theme === "spr", "and the resolved value agrees");
  },

  "the palette stays spr even when ConjureOS pushes a theme change"() {
    const e = makeEnv();
    e.inject("win", "light");
    createAppearance(e.win).init();
    e.fromShell("hal", "dark");
    ok(e.attrs["data-theme"] === "spr", "still spr after a push claiming hal");
    ok(e.attrs["data-flavor"] === "dark", "the flavor half of the same push still lands");
  },

  "a flavor change in ConjureOS reaches a running app that has not chosen yet"() {
    const e = makeEnv();
    e.inject("win", "light");
    createAppearance(e.win).init();
    e.fromShell("win", "dark");
    ok(e.attrs["data-flavor"] === "dark", "pushed flavor applied while following");
  },

  "a message from anything but the embedder is refused"() {
    const e = makeEnv();
    e.inject("win", "light");
    createAppearance(e.win).init();
    e.fromElsewhere("hal", "dark");
    ok(e.attrs["data-flavor"] === "light", "some other page cannot restyle Recipes");
  },

  "standalone, a message claiming to be ConjureOS is refused"() {
    // The bug this guards: `win.parent && win.parent !== win && ev.source
    // !== win.parent` short-circuits to false the moment win.parent === win
    // (standalone), so the early return never fires and a message from ANY
    // sender gets applied. makeEnv({embedded:false}) + fromElsewhere compose
    // to reproduce exactly that: no embedder at all, plus a sender that is
    // not one either.
    const e = makeEnv({ embedded: false });
    const t = createAppearance(e.win);
    t.init();
    e.fromElsewhere("hal", "dark");
    ok(!("data-flavor" in e.attrs), "no flavor applied with no embedder to vouch for the sender");
    ok(e.attrs["data-theme"] === "spr", "palette is unaffected either way — it was never on the table");
  },

  "the app subscribes on boot, in case the shell booted first"() {
    const e = makeEnv();
    createAppearance(e.win).init();
    ok(
      JSON.stringify(e.posted) === JSON.stringify([{ type: "conjureos:theme:subscribe" }]),
      `subscribe posted once, got ${JSON.stringify(e.posted)}`,
    );
  },

  "standalone, there is no OS layer and no subscribe"() {
    const e = makeEnv({ embedded: false });
    const a = createAppearance(e.win).init();
    ok(e.posted.length === 0, "nothing posted to ourselves");
    ok(a.following, "following is still the default state");
    ok(a.theme === "spr", "and the palette is spr regardless");
  },

  "the app's own flavor choice outranks ConjureOS"() {
    const e = makeEnv();
    e.inject("win", "light");
    const t = createAppearance(e.win);
    t.init();
    const a = t.setFlavor("dark");
    ok(e.attrs["data-flavor"] === "dark", "Recipes' own flavor wins");
    ok(a.osFlavor === "light", "what the OS is wearing is still readable");
    ok(!a.following, "the switch reads off");
  },

  "once chosen, a later OS push no longer moves the flavor"() {
    const e = makeEnv();
    e.inject("win", "dark");
    const t = createAppearance(e.win);
    t.init();
    t.setFlavor("dark");
    e.fromShell("win", "light");
    ok(e.attrs["data-flavor"] === "dark", "the user's choice still wins after a later push");
    ok(t.resolve().osFlavor === "light", "the OS value keeps updating underneath, just unused");
  },

  "a choice survives a reload"() {
    const e = makeEnv();
    const t = createAppearance(e.win);
    t.init();
    t.setFlavor("light");
    const reloaded = createAppearance(e.win);
    const a = reloaded.init();
    ok(e.attrs["data-flavor"] === "light", "flavor read back");
    ok(e.attrs["data-theme"] === "spr", "palette unaffected, as always");
    ok(!a.following, "and it is still a choice, not a follow");
  },

  "a corrupt stored value is ignored rather than thrown on"() {
    const e = makeEnv();
    e.store[STORAGE_KEY] = "{not json";
    const a = createAppearance(e.win).init();
    ok(a.following, "treated as no stored choice");
  },

  "a stored flavor that is not dark or light is dropped"() {
    const e = makeEnv();
    e.store[STORAGE_KEY] = JSON.stringify({ flavor: "neon" });
    const a = createAppearance(e.win).init();
    ok(!("data-flavor" in e.attrs), "unknown flavor not written through");
    ok(a.following, "treated as no stored choice");
  },

  "a value stored by the old theme-and-flavor sheet still reads its flavor"() {
    // Before this reversal, this same key held {theme, flavor}. An upgrade
    // must not treat that as corrupt — it should read the flavor back and
    // simply never look at the stale theme.
    const e = makeEnv();
    e.store[STORAGE_KEY] = JSON.stringify({ theme: "cnd", flavor: "light" });
    const a = createAppearance(e.win).init();
    ok(a.userFlavor === "light", "the old record's flavor still reads back");
    ok(e.attrs["data-theme"] === "spr", "and the old record's theme is simply never consulted");
  },

  "a tab that never reloaded still hears another tab's write"() {
    // Two tabs share one localStorage key. Without a storage listener, this
    // tab's next write would re-serialize its own stale snapshot and
    // silently clobber what the other tab just saved.
    const e = makeEnv();
    const t = createAppearance(e.win);
    t.init();
    e.fromOtherTab("light");
    ok(e.attrs["data-flavor"] === "light", "the other tab's flavor is applied here");
    ok(
      t.resolve().userFlavor === "light",
      "this tab's own state now matches, so its next write will not clobber the other tab's",
    );
  },

  "another tab clearing the stored choice is picked up here too"() {
    // event.newValue is null when the key is removed elsewhere — this must
    // reset the choice, not leave the stale in-memory value in place.
    const e = makeEnv();
    const t = createAppearance(e.win);
    t.init();
    t.setFlavor("light");
    ok(e.attrs["data-flavor"] === "light", "sanity: this tab's own choice applied first");
    delete e.store[STORAGE_KEY];
    e.fireStorage(STORAGE_KEY, null);
    ok(!("data-flavor" in e.attrs), "cleared once another tab removes the stored choice");
    ok(t.resolve().following, "back to following ConjureOS");
  },

  "a storage event for a different key is ignored"() {
    // event.key must be checked against this app's own key — an unrelated
    // key changing (another app on the same origin, say) must not re-apply.
    const e = makeEnv();
    const t = createAppearance(e.win);
    t.init();
    const seen: Appearance[] = [];
    t.subscribe((a) => seen.push(a));
    e.fireStorage("some.other.app.key", JSON.stringify({ flavor: "light" }));
    ok(seen.length === 0, "an unrelated key must not re-apply this app's appearance");
  },

  "subscribers hear OS pushes, not just their own writes"() {
    const e = makeEnv();
    e.inject("win", null);
    const t = createAppearance(e.win);
    t.init();
    let last: Appearance | null = null;
    t.subscribe((a) => {
      last = a;
    });
    e.fromShell("win", "dark");
    ok(last !== null, "listener fired");
    ok((last as unknown as Appearance)?.flavor === "dark", "with the new value");
  },

  "the vendored @conjureos/ui stylesheet still carries all nine palettes and the flavor switch"() {
    // Every other case in this file exercises theme.ts's own logic and never
    // reads a stylesheet at all, so a re-sync that lands an older,
    // single-palette build (see CLAUDE.md's Appearance section) would pass
    // the whole suite in silence. Recipes only ever sets data-theme="spr",
    // but that block and the light/dark resolution selectors both have to
    // exist in a genuine 1.x build for the one lever this app has left —
    // light or dark — to do anything at all. This is the one case that
    // actually reads src/conjureos-ui.css, which is what the header comment
    // at the top of that file claims happens - read it from disk rather than
    // importing it, since CSS has no exports to check against.
    const css = readFileSync(new URL("../src/conjureos-ui.css", import.meta.url), "utf8");
    const palettes = ["cnj", "hal", "fal", "win", "spr", "sum", "xms", "est", "cnd"];
    const missing = palettes.filter((p) => !css.includes(`[data-theme="${p}"]`));
    ok(missing.length === 0, `vendored stylesheet is missing palette(s): ${missing.join(", ")}`);
    ok(css.includes('[data-flavor="dark"]'), "vendored stylesheet is missing the dark flavor selector");
    ok(css.includes('[data-flavor="light"]'), "vendored stylesheet is missing the light flavor selector");
  },
};

for (const [name, fn] of Object.entries(tests)) {
  const before = failures;
  fn();
  console.log(`${failures === before ? "ok  " : "FAIL"}  ${name}`);
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${Object.keys(tests).length} appearance tests passed.`);

/**
 * Tests for src/theme.ts — the appearance ladder behind the Appearance sheet.
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
  /** Pretend ConjureOS injected an appearance before the app booted. */
  inject(theme: string | null, flavor: string | null): void;
  /** Push a theme the way the shell's broadcast does. */
  fromShell(theme: string | null, flavor: string | null): void;
  /** The same message from a page that is not the embedder. */
  fromElsewhere(theme: string | null, flavor: string | null): void;
  posted: unknown[];
}

function makeEnv({ embedded = true }: { embedded?: boolean } = {}): Env {
  const attrs: Record<string, string> = {};
  const store: Record<string, string> = {};
  const posted: unknown[] = [];
  let onMessage: ((ev: MessageEvent) => void) | null = null;

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
    addEventListener: (type: string, fn: (ev: MessageEvent) => void) => {
      if (type === "message") onMessage = fn;
    },
  } as unknown as Window & typeof globalThis;
  // Standalone is modelled as parent === self, which is what a top-level page
  // actually looks like.
  (win as unknown as { parent: unknown }).parent = embedded ? parent : win;

  const fire = (source: unknown, theme: string | null, flavor: string | null) =>
    onMessage?.({ data: { type: "conjureos:theme", theme, flavor }, source } as MessageEvent);

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
  };
}

const STORAGE_KEY = "conjureos.recipes.appearance";
const stored = (e: Env): { theme: unknown; flavor: unknown } | null =>
  e.store[STORAGE_KEY] ? JSON.parse(e.store[STORAGE_KEY]!) : null;

const tests: Record<string, () => void> = {
  "with nothing set, nothing is written"() {
    // No data-theme means the Conjure palette; no data-flavor means the
    // browser's own light/dark preference. Writing either would be a choice
    // the user never made.
    const e = makeEnv();
    createAppearance(e.win).init();
    ok(!("data-theme" in e.attrs), "no theme attribute");
    ok(!("data-flavor" in e.attrs), "no flavor attribute");
  },

  "the appearance ConjureOS injected is applied at boot"() {
    // Before any message arrives — this is what stops the launch flash.
    const e = makeEnv();
    e.inject("win", "light");
    const a = createAppearance(e.win).init();
    ok(e.attrs["data-theme"] === "win", "theme from the shim");
    ok(e.attrs["data-flavor"] === "light", "flavor from the shim");
    ok(a.inConjureOS, "and we know we are inside the shell");
  },

  "a theme change in ConjureOS reaches a running app"() {
    const e = makeEnv();
    e.inject("win", "light");
    createAppearance(e.win).init();
    e.fromShell("hal", "dark");
    ok(e.attrs["data-theme"] === "hal", "pushed theme applied");
    ok(e.attrs["data-flavor"] === "dark", "pushed flavor applied");
  },

  "a message from anything but the embedder is refused"() {
    const e = makeEnv();
    e.inject("win", "light");
    createAppearance(e.win).init();
    e.fromElsewhere("hal", "dark");
    ok(e.attrs["data-theme"] === "win", "some other page cannot restyle Recipes");
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
    ok(!a.inConjureOS, "inConjureOS is false");
    ok(e.posted.length === 0, "nothing posted to ourselves");
    ok(a.following, "following is still the default state");
  },

  "the app's own choice outranks ConjureOS"() {
    const e = makeEnv();
    e.inject("win", "light");
    const t = createAppearance(e.win);
    t.init();
    t.setTheme("cnd");
    ok(e.attrs["data-theme"] === "cnd", "Recipes' own palette wins");
    ok(e.attrs["data-flavor"] === "light", "the axis not overridden still follows the OS");
    ok(t.resolve().osTheme === "win", "what the OS is wearing is still readable");
  },

  "an override survives a reload"() {
    const e = makeEnv();
    const t = createAppearance(e.win);
    t.init();
    t.setTheme("hal");
    t.setFlavor("dark");
    const reloaded = createAppearance(e.win);
    const a = reloaded.init();
    ok(e.attrs["data-theme"] === "hal", "theme read back");
    ok(e.attrs["data-flavor"] === "dark", "flavor read back");
    ok(!a.following, "and it is still an override, not a follow");
  },

  "turning the switch OFF does not change how the app looks"() {
    // The whole reason overrideConjureOS seeds from the resolved value: taking
    // control should hand you the controls set to what you were already
    // looking at, not restyle the app as a side effect of a toggle.
    const e = makeEnv();
    e.inject("xms", "light");
    const t = createAppearance(e.win);
    t.init();
    const a = t.overrideConjureOS();
    ok(e.attrs["data-theme"] === "xms", "same palette after taking over");
    ok(e.attrs["data-flavor"] === "light", "same flavor after taking over");
    ok(a.userTheme === "xms" && a.userFlavor === "light", "both axes are now the app's");
    ok(!a.following, "the switch reads off");
  },

  "taking over with nothing to inherit lands somewhere usable"() {
    // Standalone there is no OS value, and leaving both axes null would show
    // the user a picker with no selection while the switch says "off".
    const e = makeEnv({ embedded: false });
    const t = createAppearance(e.win);
    t.init();
    const a = t.overrideConjureOS();
    ok(a.userTheme === "cnj", "falls back to Conjure");
    ok(a.userFlavor === "dark", "and to dark");
  },

  "turning the switch back ON gives both axes up in one write"() {
    // One write, not two: a pair of writes leaves a frame where the palette
    // follows the OS and the flavor has not caught up.
    const e = makeEnv();
    e.inject("win", "light");
    const t = createAppearance(e.win);
    t.init();
    t.overrideConjureOS();
    t.setTheme("hal");
    t.setFlavor("dark");

    const seen: Appearance[] = [];
    t.subscribe((a) => seen.push(a));
    const a = t.followConjureOS();

    ok(seen.length === 1, `one notification, got ${seen.length}`);
    ok(a.following, "following again");
    ok(e.attrs["data-theme"] === "win", "back to the OS palette");
    ok(e.attrs["data-flavor"] === "light", "and the OS flavor");
    ok(stored(e)?.theme === null && stored(e)?.flavor === null, "both overrides cleared on disk");
  },

  "while following, a later OS change still lands"() {
    const e = makeEnv();
    e.inject("win", "light");
    const t = createAppearance(e.win);
    t.init();
    t.overrideConjureOS();
    t.followConjureOS();
    e.fromShell("est", "dark");
    ok(e.attrs["data-theme"] === "est", "the app is genuinely following again");
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
    e.fromShell("sum", "dark");
    ok(last !== null, "listener fired");
    ok((last as unknown as Appearance)?.theme === "sum", "with the new value");
  },

  "a corrupt stored value is ignored rather than thrown on"() {
    const e = makeEnv();
    e.store[STORAGE_KEY] = "{not json";
    const a = createAppearance(e.win).init();
    ok(a.following, "treated as no stored choice");
  },

  "a stored palette that no longer exists is dropped"() {
    // A palette could be retired between releases; the app must not write
    // data-theme="brg" and render against a palette that is not there.
    const e = makeEnv();
    e.store[STORAGE_KEY] = JSON.stringify({ theme: "brg", flavor: "neon" });
    createAppearance(e.win).init();
    ok(!("data-theme" in e.attrs), "unknown palette not written through");
    ok(!("data-flavor" in e.attrs), "unknown flavor not written through");
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

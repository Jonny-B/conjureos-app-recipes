/**
 * Appearance for the Recipes app: follow ConjureOS, or don't.
 *
 * This is the app half of the ConjureOS theme handshake, which
 * `@conjureos/ui` also ships as `theme.js`. We do NOT load that file: it is a
 * browser global installed by a `<script src>` tag, and ConjureOS `@bundle`
 * generates its own HTML shell (which is why `main.tsx` has to add the
 * `cui-ui` body class at runtime too), so there is no tag for us to put it in.
 * A typed module we import is also the only version that survives a
 * typecheck. It implements the same contract, and `theme.test.ts` pins it
 * against the same rules.
 *
 * Precedence, highest first:
 *   1. what the user chose in Recipes' own settings   (localStorage)
 *   2. what ConjureOS is wearing                      (shim value, then messages)
 *   3. nothing — meaning the Conjure palette and the browser's light/dark
 *
 * "Use ConjureOS appearance" in the settings sheet is level 1 being empty.
 * That is a real, selectable state and not merely the absence of a choice: a
 * user who tries Halloween needs a way back to following the OS, and a picker
 * that only lists nine palettes has no way back.
 *
 * Outside ConjureOS — `npm run dev`, or the standalone `dist/recipes.html`
 * smoke test — level 2 is simply empty and the app behaves like any other
 * site that remembers a theme choice.
 */

export interface ThemeOption {
  id: ThemeId;
  label: string;
}

export type ThemeId =
  | "cnj"
  | "hal"
  | "fal"
  | "win"
  | "spr"
  | "sum"
  | "xms"
  | "est"
  | "cnd";
export type Flavor = "dark" | "light";

/** The nine palettes, in the order ConjureOS lists them. */
export const THEMES: readonly ThemeOption[] = [
  { id: "cnj", label: "Conjure" },
  { id: "hal", label: "Halloween" },
  { id: "fal", label: "Fall" },
  { id: "win", label: "Winter" },
  { id: "spr", label: "Spring" },
  { id: "sum", label: "Summer" },
  { id: "xms", label: "Christmas" },
  { id: "est", label: "Easter" },
  { id: "cnd", label: "Candyland" },
];

export const FLAVORS: readonly Flavor[] = ["dark", "light"];

/** Where Recipes remembers its own override. Namespaced so it cannot collide
 *  with another app that happens to share this origin. */
const STORAGE_KEY = "conjureos.recipes.appearance";
/** The message type both halves of the ConjureOS handshake agree on. */
const MSG = "conjureos:theme";

const THEME_IDS: readonly string[] = THEMES.map((t) => t.id);

const asTheme = (v: unknown): ThemeId | null =>
  typeof v === "string" && THEME_IDS.includes(v) ? (v as ThemeId) : null;

const asFlavor = (v: unknown): Flavor | null =>
  v === "dark" || v === "light" ? v : null;

/** What the app resolved to, and enough of the layers to drive a picker. */
export interface Appearance {
  /** Applied palette. null means the Conjure default. */
  theme: ThemeId | null;
  /** Applied flavor. null means follow the browser's preference. */
  flavor: Flavor | null;
  /** This app's own override, null on an axis that is following ConjureOS. */
  userTheme: ThemeId | null;
  userFlavor: Flavor | null;
  /** True while BOTH axes follow ConjureOS — what the System switch shows. */
  following: boolean;
  /** What ConjureOS is wearing, whether or not it won. */
  osTheme: ThemeId | null;
  osFlavor: Flavor | null;
  /** False outside ConjureOS, where following the OS is not an option. */
  inConjureOS: boolean;
}

interface HostBridge {
  appearance?: { theme?: unknown; flavor?: unknown };
}

/**
 * Everything below is built by a factory rather than living at module scope,
 * mirroring `@conjureos/ui`'s own resolver. The app uses the single instance
 * exported at the bottom; the factory is what lets `scripts/theme.test.ts`
 * start from a clean slate per case instead of fighting a shared singleton.
 */
export interface AppearanceController {
  init(): Appearance;
  resolve(): Appearance;
  setTheme(theme: ThemeId | null): Appearance;
  setFlavor(flavor: Flavor | null): Appearance;
  followConjureOS(): Appearance;
  overrideConjureOS(): Appearance;
  subscribe(fn: (a: Appearance) => void): () => void;
}

export function createAppearance(
  win: Window & typeof globalThis = window,
): AppearanceController {
  const state = {
    userTheme: null as ThemeId | null,
    userFlavor: null as Flavor | null,
    osTheme: null as ThemeId | null,
    osFlavor: null as Flavor | null,
    inConjureOS: false,
    started: false,
  };

  const listeners = new Set<(a: Appearance) => void>();

  const readStore = (): void => {
    try {
      const raw = win.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { theme?: unknown; flavor?: unknown };
      state.userTheme = asTheme(saved.theme);
      state.userFlavor = asFlavor(saved.flavor);
    } catch {
      /* private mode, or a corrupt value. Both mean "no stored choice". */
    }
  };

  const writeStore = (): void => {
    try {
      win.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ theme: state.userTheme, flavor: state.userFlavor }),
      );
    } catch {
      /* storage blocked. The choice still applies for this session. */
    }
  };

  /**
   * The OS layer as it stands at boot.
   *
   * ConjureOS injects `window.__conjureos.appearance` into the page before any
   * app code runs, precisely so an app that follows the OS does not paint one
   * frame in the wrong palette while the subscribe round-trip completes.
   */
  const readBoot = (): void => {
    try {
      const injected = (win as unknown as { __conjureos?: HostBridge })
        .__conjureos?.appearance;
      if (!injected) return;
      // Presence of the bridge is what tells us we are inside the shell —
      // NOT whether a theme was set. A user who never opened Settings sends
      // two nulls, and that is still ConjureOS talking.
      state.inConjureOS = true;
      state.osTheme = asTheme(injected.theme);
      state.osFlavor = asFlavor(injected.flavor);
    } catch {
      /* no host bridge: we are standalone, and level 2 stays empty */
    }
  };

  const resolve = (): Appearance => ({
    theme: state.userTheme ?? state.osTheme,
    flavor: state.userFlavor ?? state.osFlavor,
    userTheme: state.userTheme,
    userFlavor: state.userFlavor,
    following: state.userTheme === null && state.userFlavor === null,
    osTheme: state.osTheme,
    osFlavor: state.osFlavor,
    inConjureOS: state.inConjureOS,
  });

  /**
   * Write the two attributes onto <html>.
   *
   * Absence is meaningful, so an unset axis REMOVES its attribute rather than
   * writing an empty string: no `data-theme` means the Conjure palette, and no
   * `data-flavor` means the browser's own light/dark preference decides.
   */
  const apply = (): Appearance => {
    const next = resolve();
    const el = win.document.documentElement;
    if (next.theme) el.setAttribute("data-theme", next.theme);
    else el.removeAttribute("data-theme");
    if (next.flavor) el.setAttribute("data-flavor", next.flavor);
    else el.removeAttribute("data-flavor");

    for (const fn of listeners) {
      try {
        fn(next);
      } catch {
        /* one bad listener must not stop the rest */
      }
    }
    return next;
  };

  const onMessage = (ev: MessageEvent): void => {
    const data = ev.data as {
      type?: unknown;
      theme?: unknown;
      flavor?: unknown;
    } | null;
    if (!data || data.type !== MSG) return;
    // Only the embedder drives the OS layer. A message from anywhere else is
    // some other page trying to restyle an app it does not own.
    if (win.parent && win.parent !== win && ev.source !== win.parent) return;
    const theme = asTheme(data.theme);
    const flavor = asFlavor(data.flavor);
    state.inConjureOS = true;
    if (theme === state.osTheme && flavor === state.osFlavor) return;
    state.osTheme = theme;
    state.osFlavor = flavor;
    apply();
  };

  /**
   * Resolve, apply, and start following ConjureOS. Call once, as early as
   * possible — before React mounts — so the attributes are on <html> for the
   * first paint.
   */
  const init = (): Appearance => {
    if (!state.started) {
      state.started = true;
      readStore();
      readBoot();
      win.addEventListener("message", onMessage);
      // Announce ourselves, for the case where the shell booted before we did
      // and has no reason to broadcast again. Nothing listening means we simply
      // keep whatever the shim gave us.
      try {
        if (win.parent && win.parent !== win) {
          win.parent.postMessage({ type: `${MSG}:subscribe` }, "*");
        }
      } catch {
        /* a cross-origin parent that refuses. Not fatal. */
      }
    }
    return apply();
  };

  /** null means "follow ConjureOS on this axis". */
  const setTheme = (theme: ThemeId | null): Appearance => {
    state.userTheme = theme;
    writeStore();
    return apply();
  };

  /** null means "follow ConjureOS", which off-shell means the browser. */
  const setFlavor = (flavor: Flavor | null): Appearance => {
    state.userFlavor = flavor;
    writeStore();
    return apply();
  };

  /**
   * Hand both axes back to ConjureOS at once — the System switch going on.
   *
   * One write rather than `setTheme(null)` then `setFlavor(null)`, so listeners
   * see a single consistent change instead of a frame where the palette follows
   * the OS but the flavor has not caught up yet.
   */
  const followConjureOS = (): Appearance => {
    state.userTheme = null;
    state.userFlavor = null;
    writeStore();
    return apply();
  };

  /**
   * Take both axes over, seeded with whatever is on screen right now — the
   * System switch going off.
   *
   * Seeding matters: switching off must not change how the app looks. It hands
   * the user the controls set to what they were already looking at, and the
   * next change is theirs. Falls back to Conjure + dark off-shell, where there
   * is nothing to inherit and an unset axis would leave the pickers blank.
   */
  const overrideConjureOS = (): Appearance => {
    const current = resolve();
    state.userTheme = current.theme ?? "cnj";
    state.userFlavor = current.flavor ?? "dark";
    writeStore();
    return apply();
  };

  /** Subscribe to appearance changes, including ones ConjureOS pushed. */
  const subscribe = (fn: (a: Appearance) => void): (() => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };

  return {
    init,
    resolve,
    setTheme,
    setFlavor,
    followConjureOS,
    overrideConjureOS,
    subscribe,
  };
}

/**
 * The app's one instance. Screens import the bound helpers below.
 *
 * Built on first use rather than at import time: the module is imported by
 * `scripts/theme.test.ts` under plain Node, where touching `window` at module
 * scope would throw before a single test ran.
 */
let instance: AppearanceController | null = null;
const appearance = (): AppearanceController => (instance ??= createAppearance());

export const initAppearance = (): Appearance => appearance().init();
export const resolve = (): Appearance => appearance().resolve();
export const setTheme = (theme: ThemeId | null): Appearance =>
  appearance().setTheme(theme);
export const setFlavor = (flavor: Flavor | null): Appearance =>
  appearance().setFlavor(flavor);
export const followConjureOS = (): Appearance => appearance().followConjureOS();
export const overrideConjureOS = (): Appearance =>
  appearance().overrideConjureOS();
export const subscribeAppearance = (
  fn: (a: Appearance) => void,
): (() => void) => appearance().subscribe(fn);

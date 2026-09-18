/**
 * Appearance for Conjure Pantry: the palette is locked to Spring, and light
 * or dark is the one thing left to choose.
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
 * Two things this app wears, only one of them negotiable:
 *
 *   theme   always "spr" (Spring). ConjureOS still broadcasts its own
 *           palette on the same channel everything else arrives on —
 *           Recipes receives the message and ignores that field. There is
 *           no picker for it because there is nothing to pick.
 *   flavor  light or dark. Precedence, highest first:
 *             1. what the user chose in Recipes' own settings  (localStorage)
 *             2. what ConjureOS is wearing                     (shim, then messages)
 *             3. nothing — the browser's own light/dark preference decides
 *           Step 1 is a one-way door: once the user taps Light or Dark in
 *           the appearance sheet, this app's own choice wins from then on
 *           and step 2 stops being consulted. There is no control that hands
 *           it back; clearing site data is the only way to resume following.
 *
 * Outside ConjureOS — `npm run dev`, or the standalone `dist/recipes.html`
 * smoke test — step 2 is simply empty and flavor falls straight to step 3.
 */

export type Flavor = "dark" | "light";

/** In display order in the appearance sheet. */
export const FLAVORS: readonly Flavor[] = ["dark", "light"];

/** Recipes' one and only palette. Fixed at build time, not a setting. */
export const PALETTE = "spr";

/** Where Recipes remembers its own flavor choice. Namespaced so it cannot
 *  collide with another app that happens to share this origin. Unchanged
 *  from when this key also carried a theme override, so upgrading from an
 *  older version reads the flavor back rather than starting blank; a stale
 *  `theme` field, if present, is simply never read. */
const STORAGE_KEY = "conjureos.recipes.appearance";
/** The message type both halves of the ConjureOS handshake agree on. */
const MSG = "conjureos:theme";

const asFlavor = (v: unknown): Flavor | null =>
  v === "dark" || v === "light" ? v : null;

/** What the app resolved to, and enough of the layers to drive the sheet. */
export interface Appearance {
  /** Always "spr" — never a user or OS choice. */
  theme: "spr";
  /** Applied flavor: userFlavor if set, else osFlavor, else null — which
   *  leaves data-flavor unset and the browser's own preference decides. */
  flavor: Flavor | null;
  /** This app's own stored choice. null means still following ConjureOS. */
  userFlavor: Flavor | null;
  /** What ConjureOS is wearing, whether or not userFlavor is winning over it. */
  osFlavor: Flavor | null;
  /** True while userFlavor is null — the state before the user's first tap. */
  following: boolean;
}

interface HostBridge {
  appearance?: { flavor?: unknown };
}

/**
 * Built by a factory rather than living at module scope, mirroring
 * `@conjureos/ui`'s own resolver. The app uses the single instance exported
 * at the bottom; the factory is what lets `scripts/theme.test.ts` start from
 * a clean slate per case instead of fighting a shared singleton.
 */
export interface AppearanceController {
  init(): Appearance;
  resolve(): Appearance;
  setFlavor(flavor: Flavor): Appearance;
  subscribe(fn: (a: Appearance) => void): () => void;
}

export function createAppearance(
  win: Window & typeof globalThis = window,
): AppearanceController {
  const state = {
    userFlavor: null as Flavor | null,
    osFlavor: null as Flavor | null,
    started: false,
  };

  const listeners = new Set<(a: Appearance) => void>();

  const readStore = (): void => {
    try {
      const raw = win.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        state.userFlavor = null;
        return;
      }
      const saved = JSON.parse(raw) as { flavor?: unknown };
      state.userFlavor = asFlavor(saved.flavor);
    } catch {
      // Private mode, or a corrupt value. Both mean "no stored choice" — and
      // because another tab's `storage` event calls this a second time, it
      // must actively clear rather than leave a stale value from before.
      state.userFlavor = null;
    }
  };

  const writeStore = (): void => {
    try {
      win.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ flavor: state.userFlavor }),
      );
    } catch {
      /* storage blocked. The choice still applies for this session. */
    }
  };

  /**
   * The OS flavor as it stands at boot.
   *
   * ConjureOS injects `window.__conjureos.appearance` into the page before
   * any app code runs, precisely so a load that ends up following the OS
   * does not paint one frame in the wrong flavor while the subscribe
   * round-trip completes.
   */
  const readBoot = (): void => {
    try {
      const injected = (win as unknown as { __conjureos?: HostBridge })
        .__conjureos?.appearance;
      if (!injected) return;
      state.osFlavor = asFlavor(injected.flavor);
    } catch {
      /* no host bridge: we are standalone, and the OS layer stays empty */
    }
  };

  const resolve = (): Appearance => ({
    theme: PALETTE,
    flavor: state.userFlavor ?? state.osFlavor,
    userFlavor: state.userFlavor,
    osFlavor: state.osFlavor,
    following: state.userFlavor === null,
  });

  /**
   * Write the palette and, if resolved, the flavor onto <html>.
   *
   * data-theme is always written: the palette is fixed, not merely
   * defaulted. data-flavor is written only when resolved — absence is
   * meaningful, so an unset axis REMOVES the attribute rather than writing
   * an empty string, and the browser's own light/dark preference decides.
   */
  const apply = (): Appearance => {
    const next = resolve();
    const el = win.document.documentElement;
    el.setAttribute("data-theme", next.theme);
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
    const data = ev.data as { type?: unknown; flavor?: unknown } | null;
    if (!data || data.type !== MSG) return;
    // Only the embedder can speak for ConjureOS. With no embedder at all —
    // this window is its own parent — there is no ConjureOS to speak for it,
    // so we reject before even checking who sent the message. Security, not
    // theming: this shape does not change no matter how many axes are above
    // it.
    const embedded = win.parent && win.parent !== win;
    if (!embedded) return;
    if (ev.source !== win.parent) return;
    const flavor = asFlavor(data.flavor);
    if (flavor === state.osFlavor) return;
    state.osFlavor = flavor;
    apply();
  };

  /**
   * Two tabs of the app share one localStorage key. `storage` fires only in
   * OTHER tabs than the one that wrote — never this one — which is exactly
   * the case that matters: a tab left open since before another tab's write
   * has to notice, or its own next write re-serializes a stale snapshot and
   * silently clobbers what the other tab just saved.
   */
  const onStorage = (ev: StorageEvent): void => {
    if (ev.key !== STORAGE_KEY) return;
    readStore();
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
      win.addEventListener("storage", onStorage);
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

  /**
   * The user's one choice, made from the appearance sheet. A one-way door:
   * there is no control that hands it back to ConjureOS, so unlike the old
   * two-axis ladder this never takes null.
   */
  const setFlavor = (flavor: Flavor): Appearance => {
    state.userFlavor = flavor;
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

  return { init, resolve, setFlavor, subscribe };
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
export const setFlavor = (flavor: Flavor): Appearance =>
  appearance().setFlavor(flavor);
export const subscribeAppearance = (
  fn: (a: Appearance) => void,
): (() => void) => appearance().subscribe(fn);

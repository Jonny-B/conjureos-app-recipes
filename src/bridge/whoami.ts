/**
 * whoami: thin wrapper around `window.__conjureos.auth.whoami()` (the Phase-30g
 * identity subset) so the app can reveal the chef-only Studio.
 *
 * The result is display-only, NEVER a security boundary: the recipes-db backend
 * re-verifies the chef role from the minted identity token before it will write
 * a promoted recipe. A dev-mode mock keeps the Studio iterable via `npm run dev`.
 */

export interface Whoami {
  signedIn: boolean;
  email?: string;
  persona?: string;
  isAdmin?: boolean;
  /** Scoped chef role (Chef Payson) — gates the Studio tab. */
  isChef?: boolean;
}

declare global {
  // Augments the shared bridge interface (declared in ai.ts) with the auth op.
  interface ConjureosBridge {
    auth?: { whoami: () => Promise<Whoami> };
  }
}

const whoamiFn = () => window.__conjureos?.auth?.whoami;

/** True when the real host auth bridge is present (we're inside ConjureOS). */
export function isAuthBridgeAvailable(): boolean {
  return typeof whoamiFn() === "function";
}

export async function getWhoami(): Promise<Whoami> {
  const fn = whoamiFn();
  if (fn) {
    try {
      return await fn();
    } catch {
      return { signedIn: false };
    }
  }
  // Dev mock: pose as the chef so the Studio is iterable under `npm run dev`
  // (and in the standalone dist smoke test). The real host returns real data.
  return { signedIn: true, email: "chef@dev.local", isChef: true, isAdmin: false };
}

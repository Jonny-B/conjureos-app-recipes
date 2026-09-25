import { useEffect, useState } from "react";
import { getMyRole, type AppRole } from "../bridge/recipesApi";
import { setAcceptedTermsVersion } from "../features/terms";

export interface RoleState {
  role: AppRole;
  email: string | null;
  loading: boolean;
  err: string | null;
  /** Banned from Recipes by an admin: the app shows a notice instead of itself. */
  banned: boolean;
}

/**
 * Loads the caller's app role from recipes-db (server-authoritative, derived
 * from the minted identity token). Drives which surfaces the app reveals:
 * 'chef' → Studio, 'admin' → Admin console. Defaults to 'user' until resolved.
 * Also hands the accepted terms version to features/terms.ts.
 */
export function useRole(): RoleState {
  const [state, setState] = useState<RoleState>({ role: "user", email: null, loading: true, err: null, banned: false });
  useEffect(() => {
    let live = true;
    getMyRole()
      .then((r) => {
        if (!live) return;
        if (!r.err) setAcceptedTermsVersion(r.termsVersion);
        setState({ role: r.role, email: r.email, loading: false, err: r.err, banned: r.banned });
      })
      .catch(
        (e) =>
          live &&
          setState({ role: "user", email: null, loading: false, err: e instanceof Error ? e.message : String(e), banned: false }),
      );
    return () => {
      live = false;
    };
  }, []);
  return state;
}

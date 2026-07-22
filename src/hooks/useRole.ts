import { useEffect, useState } from "react";
import { getMyRole, type AppRole } from "../bridge/recipesApi";

export interface RoleState {
  role: AppRole;
  email: string | null;
  loading: boolean;
  err: string | null;
}

/**
 * Loads the caller's app role from recipes-db (server-authoritative, derived
 * from the minted identity token). Drives which surfaces the app reveals:
 * 'chef' → Studio, 'admin' → Admin console. Defaults to 'user' until resolved.
 */
export function useRole(): RoleState {
  const [state, setState] = useState<RoleState>({ role: "user", email: null, loading: true, err: null });
  useEffect(() => {
    let live = true;
    getMyRole()
      .then((r) => live && setState({ role: r.role, email: r.email, loading: false, err: r.err }))
      .catch((e) => live && setState({ role: "user", email: null, loading: false, err: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, []);
  return state;
}

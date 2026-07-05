import { useEffect, useState } from "react";
import { getWhoami, type Whoami } from "../bridge/whoami";

/** Loads the host identity once. Returns null until resolved. */
export function useWhoami(): Whoami | null {
  const [who, setWho] = useState<Whoami | null>(null);
  useEffect(() => {
    let live = true;
    getWhoami()
      .then((w) => live && setWho(w))
      .catch(() => live && setWho({ signedIn: false }));
    return () => {
      live = false;
    };
  }, []);
  return who;
}

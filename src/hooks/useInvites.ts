import { useCallback, useEffect, useRef, useState } from "react";
import { getMyProfile, myInvites, type AppProfile, type FamilyInvite } from "../bridge/recipesApi";
import { subscribeFamilyChannels, type RealtimeHandle } from "../bridge/realtime";

/**
 * App-level pending-invite state + a live subscription to the user's OWN
 * realtime channel (`user-<id>`). A pending invitee isn't on any family channel
 * yet, so this is how an invite reaches them live — the recipes-db `invite`
 * action broadcasts to `user-<inviteeId>`, and we refetch on the push. Drives
 * the Home banner so an invite can't get lost on the Family screen.
 */
export function useInvites(): { invites: FamilyInvite[]; reload: () => void } {
  const [invites, setInvites] = useState<FamilyInvite[]>([]);
  const [profile, setProfile] = useState<AppProfile | null>(null);
  const rt = useRef<RealtimeHandle | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(() => {
    myInvites().then(setInvites).catch(() => {});
  }, []);

  useEffect(() => {
    getMyProfile().then(setProfile).catch(() => {});
    reload();
  }, [reload]);

  useEffect(() => {
    rt.current?.close();
    rt.current = null;
    if (!profile?.userId || !profile.anonKey || !profile.realtimeUrl) return;
    rt.current = subscribeFamilyChannels({
      url: profile.realtimeUrl,
      anonKey: profile.anonKey,
      channels: [`user-${profile.userId}`],
      onMessage: () => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(reload, 300);
      },
    });
    return () => {
      rt.current?.close();
      rt.current = null;
    };
  }, [profile, reload]);

  return { invites, reload };
}

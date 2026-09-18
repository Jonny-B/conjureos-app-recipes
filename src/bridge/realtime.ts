/**
 * Minimal Supabase Realtime BROADCAST + PRESENCE client — no dependencies.
 *
 * The sandboxed app has only the public anon key (no Supabase session), so it
 * can't use postgres_changes. Instead it subscribes to a family's unguessable
 * broadcast channel (`family-<channelToken>`, the token handed only to verified
 * members) and receives the pushes the `recipes-db` Edge Function emits on every
 * family-plan write. This speaks the Phoenix-channels wire protocol directly
 * (vsn 1.0.0, object frames) over a single websocket, joins N channels,
 * heartbeats, and reconnects with backoff. Browser `WebSocket` (also present in
 * modern Node for testing).
 *
 * See FAMILY_PLANS_DESIGN.md.
 */

export interface RealtimeHandle {
  /** Replace the set of subscribed channels (e.g. after joining a family). */
  setChannels: (channels: string[]) => void;
  close: () => void;
}

type OnMessage = (channel: string, event: string, payload: unknown) => void;
/** Who else is on a channel right now, excluding us. Empty is normal. */
type OnPresence = (channel: string, who: PresenceMember[]) => void;

export interface PresenceMember {
  /** Stable per-user key — the app sends its user id. */
  key: string;
  /** Display name, when the peer sent one. */
  name: string | null;
}

/** What we announce about ourselves on every channel we join. */
export interface PresenceSelf {
  key: string;
  name: string | null;
}

interface Opts {
  /** Project URL, e.g. https://<ref>.supabase.co (http(s) or ws(s)). */
  url: string;
  anonKey: string;
  channels: string[];
  onMessage: OnMessage;
  onStatus?: (s: string) => void;
  /**
   * Announce ourselves and report who else is here. Omit and the socket
   * behaves exactly as it did before presence existed: no track, no state
   * handling, nothing announced.
   */
  presence?: PresenceSelf;
  onPresence?: OnPresence;
}

/**
 * Phoenix presence state, reduced to "who is on this channel".
 *
 * Extracted as a pure function on purpose: the wire shapes here are the part
 * most likely to be wrong, and they are the part a websocket makes hardest to
 * test. `scripts/realtimePresence.test.ts` drives this directly.
 *
 * The wire carries `{ <key>: { metas: [ {phx_ref, ...ourFields}, … ] } }`,
 * one meta per open tab, so the same person on a phone and a laptop is ONE
 * member here. A diff carries `joins` and `leaves` in the same shape, and a
 * leave that empties a key drops the member entirely.
 */
export type PresenceState = Record<string, { metas?: Array<Record<string, unknown>> }>;

export function applyPresenceState(raw: unknown): PresenceState {
  return isRecord(raw) ? (raw as PresenceState) : {};
}

export function applyPresenceDiff(current: PresenceState, raw: unknown): PresenceState {
  if (!isRecord(raw)) return current;
  const diff = raw as { joins?: unknown; leaves?: unknown };
  const next: PresenceState = { ...current };
  if (isRecord(diff.joins)) {
    for (const [key, val] of Object.entries(diff.joins as PresenceState)) {
      const metas = [...(next[key]?.metas ?? []), ...(val?.metas ?? [])];
      // Dedupe on phx_ref: a re-sent join for a tab already tracked would
      // otherwise double it, and two metas is indistinguishable from two tabs.
      const seen = new Set<unknown>();
      next[key] = {
        metas: metas.filter((m) => {
          const ref = m?.["phx_ref"];
          if (ref === undefined) return true;
          if (seen.has(ref)) return false;
          seen.add(ref);
          return true;
        }),
      };
    }
  }
  if (isRecord(diff.leaves)) {
    for (const [key, val] of Object.entries(diff.leaves as PresenceState)) {
      const goneRefs = new Set((val?.metas ?? []).map((m) => m?.["phx_ref"]));
      const left = (next[key]?.metas ?? []).filter((m) => !goneRefs.has(m?.["phx_ref"]));
      if (left.length === 0) delete next[key];
      else next[key] = { metas: left };
    }
  }
  return next;
}

/** The state as a member list, with ourselves removed. */
export function presenceMembers(state: PresenceState, selfKey: string): PresenceMember[] {
  const out: PresenceMember[] = [];
  for (const [key, val] of Object.entries(state)) {
    if (key === selfKey) continue;
    const meta = (val?.metas ?? [])[0];
    const name = meta && typeof meta["name"] === "string" ? (meta["name"] as string) : null;
    out.push({ key, name: name && name.trim() ? name.trim() : null });
  }
  // Stable order so the row doesn't reshuffle on every heartbeat.
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

const HEARTBEAT_MS = 25_000;

export function subscribeFamilyChannels(opts: Opts): RealtimeHandle {
  const WS: typeof WebSocket | undefined = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  let channels = [...new Set(opts.channels)];
  let ws: WebSocket | null = null;
  let ref = 0;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  let closed = false;

  const nextRef = () => String(++ref);
  const wsUrl = () => {
    const base = opts.url.replace(/^http/, "ws").replace(/\/+$/, "");
    return `${base}/realtime/v1/websocket?apikey=${encodeURIComponent(opts.anonKey)}&vsn=1.0.0`;
  };

  /** join_ref per joined channel, so we can phx_leave it later. */
  const joinRefs = new Map<string, string>();
  /** Presence state per channel, so a diff has something to apply to. */
  const presenceState = new Map<string, PresenceState>();
  const self = opts.presence;

  const joinChannel = (name: string) => {
    if (!ws || ws.readyState !== 1) return;
    // ONE ref, used for both fields. Phoenix treats the join's `ref` as that
    // channel instance's join_ref; sending two different values (nextRef()
    // twice) made join_ref always ref+1, which correlates to no channel.
    const r = nextRef();
    joinRefs.set(name, r);
    presenceState.set(name, {});
    ws.send(
      JSON.stringify({
        topic: `realtime:${name}`,
        event: "phx_join",
        // `self: false` on broadcast only — we don't want our own plan pushes
        // echoed back. Presence is different: the state frame legitimately
        // includes us, and presenceMembers() filters us out by key.
        payload: {
          config: {
            broadcast: { ack: false, self: false },
            presence: { key: self?.key ?? "" },
            private: false,
          },
          access_token: opts.anonKey,
        },
        ref: r,
        join_ref: r,
      }),
    );
    if (self) trackPresence(name);
  };

  /**
   * Announce ourselves on a channel.
   *
   * Sent immediately after phx_join rather than waiting for phx_reply: the
   * server queues messages for a joining channel, and waiting on a reply we
   * otherwise ignore would mean threading reply-correlation through the whole
   * socket for no benefit. If the join fails, the track is dropped with it.
   */
  const trackPresence = (name: string) => {
    const joinRef = joinRefs.get(name);
    if (!ws || ws.readyState !== 1 || !joinRef || !self) return;
    ws.send(
      JSON.stringify({
        topic: `realtime:${name}`,
        event: "presence",
        payload: { type: "presence", event: "TRACK", payload: { name: self.name } },
        ref: nextRef(),
        join_ref: joinRef,
      }),
    );
  };

  const leaveChannel = (name: string) => {
    const joinRef = joinRefs.get(name);
    joinRefs.delete(name);
    presenceState.delete(name);
    // Tell the screen the room is empty NOW rather than leaving a stale
    // "2 others here" behind on a channel we no longer listen to.
    if (self) opts.onPresence?.(name, []);
    if (!ws || ws.readyState !== 1 || !joinRef) return;
    ws.send(
      JSON.stringify({ topic: `realtime:${name}`, event: "phx_leave", payload: {}, ref: nextRef(), join_ref: joinRef }),
    );
  };

  const connect = () => {
    if (closed || !WS) return;
    try {
      ws = new WS(wsUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      attempts = 0;
      joinRefs.clear(); // refs are per-socket; a reconnect re-joins from scratch
      presenceState.clear(); // and so is presence — the server re-sends state
      opts.onStatus?.("open");
      channels.forEach(joinChannel);
      heartbeat = setInterval(() => {
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: nextRef() }));
        }
      }, HEARTBEAT_MS);
    };
    ws.onmessage = (e: MessageEvent) => {
      let msg: { topic?: string; event?: string; payload?: { event?: string; payload?: unknown } };
      try {
        msg = JSON.parse(typeof e.data === "string" ? e.data : "");
      } catch {
        return;
      }
      if (typeof msg.topic !== "string") return;
      const name = msg.topic.replace(/^realtime:/, "");
      if (msg.event === "broadcast") {
        opts.onMessage(name, msg.payload?.event ?? "", msg.payload?.payload);
        return;
      }
      if (!self || !opts.onPresence) return;
      if (msg.event === "presence_state") {
        presenceState.set(name, applyPresenceState(msg.payload));
      } else if (msg.event === "presence_diff") {
        presenceState.set(name, applyPresenceDiff(presenceState.get(name) ?? {}, msg.payload));
      } else {
        return;
      }
      opts.onPresence(name, presenceMembers(presenceState.get(name) ?? {}, self.key));
    };
    ws.onclose = () => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      opts.onStatus?.("closed");
      scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5));
    attempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  connect();

  return {
    setChannels(next: string[]) {
      const uniq = [...new Set(next)];
      const added = uniq.filter((c) => !channels.includes(c));
      const removed = channels.filter((c) => !uniq.includes(c));
      channels = uniq;
      // Reconcile BOTH ways. Only joining meant a dropped channel (leaving a
      // family) kept streaming that family's plan pushes over the live socket
      // until the next reconnect.
      removed.forEach(leaveChannel);
      added.forEach(joinChannel);
    },
    close() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    },
  };
}

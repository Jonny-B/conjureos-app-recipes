/**
 * Minimal Supabase Realtime BROADCAST client — no dependencies.
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

interface Opts {
  /** Project URL, e.g. https://<ref>.supabase.co (http(s) or ws(s)). */
  url: string;
  anonKey: string;
  channels: string[];
  onMessage: OnMessage;
  onStatus?: (s: string) => void;
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

  const joinChannel = (name: string) => {
    if (!ws || ws.readyState !== 1) return;
    ws.send(
      JSON.stringify({
        topic: `realtime:${name}`,
        event: "phx_join",
        // Broadcast-only: no presence, receive others' messages (self:false).
        payload: { config: { broadcast: { ack: false, self: false }, presence: { key: "" }, private: false }, access_token: opts.anonKey },
        ref: nextRef(),
        join_ref: nextRef(),
      }),
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
      if (msg.event === "broadcast" && typeof msg.topic === "string") {
        const name = msg.topic.replace(/^realtime:/, "");
        opts.onMessage(name, msg.payload?.event ?? "", msg.payload?.payload);
      }
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
      channels = uniq;
      // Join any newly-added channels on the live socket; dropped channels are
      // simply ignored (a full re-list on reconnect reflects the new set).
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

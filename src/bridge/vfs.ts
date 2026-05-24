/**
 * Thin wrapper around `window.__vfs` with a dev-mode in-memory mock so
 * the UI works outside ConjureOS via `npm run dev`. The host VFS is
 * gated on the `vfs.read` / `vfs.write` permissions declared in
 * package.json's `conjureos.permissions`.
 *
 * Recipe app writes to `/home/Documents/Recipes/<slug>.md` — the
 * typed-home convention shipped in ConjureOS 0.3.10. The user can
 * browse + share these in the Files app or any markdown editor.
 */

interface VFSBridge {
  read: (path: string) => Promise<string>;
  write: (path: string, content: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
  ls: (path: string) => Promise<string[]>;
  mkdir: (path: string) => Promise<void>;
  rm: (path: string) => Promise<void>;
}

declare global {
  interface Window {
    __vfs?: VFSBridge;
  }
}

const real = (): VFSBridge | undefined => window.__vfs;

export function isVfsAvailable(): boolean {
  return real() !== undefined;
}

const memStore: Map<string, string> = new Map();

export const vfs: VFSBridge = {
  async read(path) {
    const r = real();
    if (r) return r.read(path);
    const v = memStore.get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  },
  async write(path, content) {
    const r = real();
    if (r) return r.write(path, content);
    memStore.set(path, content);
  },
  async exists(path) {
    const r = real();
    if (r) return r.exists(path);
    if (memStore.has(path)) return true;
    // Directory semantics: a path "exists" if anything is stored beneath
    // it. Without this the mock reports the Recipes dir as missing (mkdir
    // is a no-op here), so the Saved tab stays empty in `npm run dev`.
    const prefix = path.endsWith("/") ? path : path + "/";
    for (const key of memStore.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  },
  async ls(path) {
    const r = real();
    if (r) return r.ls(path);
    const prefix = path.endsWith("/") ? path : path + "/";
    const out = new Set<string>();
    for (const key of memStore.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      out.add(slash === -1 ? rest : rest.slice(0, slash));
    }
    return [...out];
  },
  async mkdir(path) {
    const r = real();
    if (r) return r.mkdir(path);
  },
  async rm(path) {
    const r = real();
    if (r) return r.rm(path);
    memStore.delete(path);
  },
};

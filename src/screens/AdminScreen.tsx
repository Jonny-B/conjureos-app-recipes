import { useCallback, useEffect, useRef, useState } from "react";
import { adminListUsers, adminSetRole, type AppRole, type AppUser } from "../bridge/recipesApi";
import { Dropdown, type DropdownOption } from "../components/Dropdown";
import { Icon } from "../icons";

const ROLE_OPTIONS: DropdownOption<AppRole>[] = [
  { value: "user", label: "User" },
  { value: "chef", label: "Chef" },
  { value: "admin", label: "Admin" },
];

/**
 * Admin console (only mounted when the caller's role is 'admin'). Search the
 * user directory and change roles. Every user who has opened the app — i.e.
 * every account whose minted token reached recipes-db — appears here.
 */
export function AdminScreen({ myEmail }: { myEmail: string | null }) {
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<AppUser[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // userId mid-update
  const seq = useRef(0);

  const load = useCallback(async (q: string) => {
    const mine = ++seq.current;
    try {
      const { users, total } = await adminListUsers(q, 100, 0);
      if (mine === seq.current) {
        setUsers(users);
        setTotal(total);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Debounced search.
  useEffect(() => {
    const t = setTimeout(() => load(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query, load]);

  const changeRole = async (u: AppUser, role: AppRole) => {
    if (role === u.role) return;
    setBusy(u.userId);
    setError(null);
    try {
      const updated = await adminSetRole(u.userId, role);
      setUsers((prev) => (prev ? prev.map((x) => (x.userId === u.userId ? updated : x)) : prev));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="admin-screen">
      <div className="home-greeting">
        <h2 style={{ margin: 0 }}>Admin</h2>
        <div className="muted" style={{ marginTop: 4 }}>
          {total} {total === 1 ? "person has" : "people have"} used Recipes. Search and set roles.
        </div>
      </div>

      <div className="browse-filter">
        <Icon name="magnifying-glass" />
        <input
          type="text"
          placeholder="Search by email or name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {error && (
        <div className="status-banner error">
          <Icon name="triangle-exclamation" />
          <span>{error}</span>
        </div>
      )}

      {users === null ? (
        <div className="center-spinner"><div className="spinner" /></div>
      ) : users.length === 0 ? (
        <div className="empty-state">
          <Icon name="magnifying-glass" className="empty-icon" />
          <div>No users match that search.</div>
        </div>
      ) : (
        <div className="admin-list">
          {users.map((u) => {
            const isMe = !!myEmail && u.email?.toLowerCase() === myEmail.toLowerCase();
            return (
              <div key={u.userId} className={`admin-row${busy === u.userId ? " busy" : ""}`}>
                <div className="admin-id">
                  <div className="admin-name">
                    {u.displayName || u.email || u.userId.slice(0, 8)}
                    {isMe && <span className="admin-you">you</span>}
                  </div>
                  {u.email && u.displayName && <div className="admin-email">{u.email}</div>}
                  <div className="admin-seen">last seen {fmtDate(u.lastSeenAt)}</div>
                </div>
                <div className="admin-role">
                  <Dropdown
                    options={ROLE_OPTIONS}
                    value={u.role}
                    onChange={(role) => changeRole(u, role)}
                    ariaLabel={`Role for ${u.email ?? u.userId}`}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

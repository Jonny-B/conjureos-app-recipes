import { useCallback, useEffect, useRef, useState } from "react";
import {
  adminBanUser,
  adminDeleteRecipe,
  adminListRecipes,
  adminListUsers,
  adminPurgeUserContent,
  adminRemoveRecipeImage,
  adminSetRecipeImage,
  adminSetRole,
  adminUnbanUser,
  type AppRole,
  type AppUser,
  type ModRecipe,
} from "../bridge/recipesApi";
import { Dropdown, type DropdownOption } from "../components/Dropdown";
import { generateRecipePhoto, isAiPhotoAvailable } from "../features/aiPhoto";
import { RECIPE_PHOTOS_ENABLED } from "../features/flags";
import { Icon } from "../icons";

const ROLE_OPTIONS: DropdownOption<AppRole>[] = [
  { value: "user", label: "User" },
  { value: "chef", label: "Chef" },
  { value: "admin", label: "Admin" },
];

const PAGE = 50;
type View = "users" | "recipes";

/**
 * Admin console (only mounted when the caller's role is 'admin'; recipes-db
 * re-checks the role on every call).
 *
 *   Users   — every account that has opened Recipes, searchable and paged.
 *             Set roles; ban from Recipes (Recipes only, never the ConjureOS
 *             account), optionally deleting their recipes and/or images;
 *             unban; or delete their recipes/images without a ban.
 *   Recipes — moderation: every recipe people have added (not the catalog),
 *             private ones included, searchable and paged. Delete a recipe,
 *             take its photo off, or give it an AI photo.
 */
export function AdminScreen({ myEmail }: { myEmail: string | null }) {
  const [view, setView] = useState<View>("users");
  /** Set when "View recipes" is picked on a user: the Recipes view filters to them. */
  const [userFilter, setUserFilter] = useState<AppUser | null>(null);

  return (
    <div className="admin-screen">
      <div className="home-greeting">
        <h2 style={{ margin: 0 }}>Admin</h2>
      </div>
      <div className="seg" role="tablist" aria-label="Admin">
        <button
          role="tab"
          aria-selected={view === "users"}
          className={`seg-btn${view === "users" ? " active" : ""}`}
          onClick={() => setView("users")}
        >
          Users
        </button>
        <button
          role="tab"
          aria-selected={view === "recipes"}
          className={`seg-btn${view === "recipes" ? " active" : ""}`}
          onClick={() => setView("recipes")}
        >
          Recipes
        </button>
      </div>
      {view === "users" ? (
        <UsersView
          myEmail={myEmail}
          onViewRecipes={(u) => {
            setUserFilter(u);
            setView("recipes");
          }}
        />
      ) : (
        <RecipesView userFilter={userFilter} onClearUser={() => setUserFilter(null)} />
      )}
    </div>
  );
}

// ── Users ───────────────────────────────────────────────────────────────

function UsersView({ myEmail, onViewRecipes }: { myEmail: string | null; onViewRecipes: (u: AppUser) => void }) {
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<AppUser[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // userId mid-update
  const [open, setOpen] = useState<string | null>(null); // userId whose manage panel is open
  const seq = useRef(0);

  const load = useCallback(async (q: string, offset = 0) => {
    const mine = ++seq.current;
    try {
      const r = await adminListUsers(q, PAGE, offset);
      if (mine !== seq.current) return;
      setUsers((prev) => (offset === 0 || !prev ? r.users : [...prev, ...r.users]));
      setTotal(r.total);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Debounced search.
  useEffect(() => {
    const t = setTimeout(() => load(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query, load]);

  const replace = (u: AppUser) => setUsers((prev) => (prev ? prev.map((x) => (x.userId === u.userId ? u : x)) : prev));

  /**
   * Dropped role changes that still need a yes: `{userId, role}`.
   *
   * The dropdown fires on selection, so demoting yourself out of admin was a
   * single tap with no confirmation and no way back — the Admin tab unmounts
   * and the control that would restore you is inside it. Only a change to
   * your OWN row is gated, so ordinary role management stays one tap.
   */
  const [confirmRole, setConfirmRole] = useState<{ userId: string; role: AppRole } | null>(null);

  const run = async (u: AppUser, fn: () => Promise<void>) => {
    setBusy(u.userId);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const changeRole = (u: AppUser, role: AppRole, confirmed = false) => {
    if (role === u.role) return;
    const isMe = !!myEmail && !!u.email && u.email.toLowerCase() === myEmail.toLowerCase();
    if (isMe && role !== "admin" && !confirmed) {
      setConfirmRole({ userId: u.userId, role });
      return;
    }
    setConfirmRole(null);
    void run(u, async () => replace(await adminSetRole(u.userId, role)));
  };

  return (
    <>
      <div className="muted">
        {total} {total === 1 ? "person has" : "people have"} used Recipes.
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
      {notice && (
        <div className="status-banner">
          <Icon name="check" />
          <span>{notice}</span>
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
                    {u.bannedAt && <span className="pill hard admin-banned">banned</span>}
                  </div>
                  {u.email && u.displayName && <div className="admin-email">{u.email}</div>}
                  <div className="admin-seen">
                    last seen {fmtDate(u.lastSeenAt)}
                    {u.bannedAt && ` · banned ${fmtDate(u.bannedAt)}${u.banReason ? ` — ${u.banReason}` : ""}`}
                  </div>
                </div>
                <div className="admin-role">
                  <Dropdown
                    options={ROLE_OPTIONS}
                    value={confirmRole?.userId === u.userId ? confirmRole.role : u.role}
                    onChange={(role) => changeRole(u, role)}
                    ariaLabel={`Role for ${u.email ?? u.userId}`}
                  />
                  <button
                    className={`icon-btn${open === u.userId ? " active" : ""}`}
                    type="button"
                    aria-label={`Manage ${u.email ?? u.userId}`}
                    title="Manage"
                    onClick={() => setOpen((v) => (v === u.userId ? null : u.userId))}
                  >
                    <Icon name="ellipsis" />
                  </button>
                </div>
                {confirmRole?.userId === u.userId && (
                  <div className="admin-confirm">
                    <Icon name="triangle-exclamation" />
                    <span>
                      This is your own account. Setting yourself to <strong>{confirmRole.role}</strong> closes the
                      Admin tab, and you won't be able to reopen it — another admin would have to restore you.
                    </span>
                    <button className="btn secondary" type="button" onClick={() => setConfirmRole(null)}>
                      Keep admin
                    </button>
                    <button className="btn danger" type="button" onClick={() => changeRole(u, confirmRole.role, true)}>
                      Step down
                    </button>
                  </div>
                )}
                {open === u.userId && (
                  <ManagePanel
                    user={u}
                    isMe={isMe}
                    busy={busy === u.userId}
                    onViewRecipes={() => onViewRecipes(u)}
                    onBan={(opts) =>
                      run(u, async () => {
                        const r = await adminBanUser(u.userId, opts);
                        replace(r.user);
                        setNotice(
                          `Banned ${u.email ?? "user"} from Recipes` +
                            (opts.deleteRecipes || opts.deleteImages
                              ? ` — ${r.recipesDeleted} recipe(s) and ${r.imagesRemoved} image file(s) deleted.`
                              : "."),
                        );
                        setOpen(null);
                      })
                    }
                    onUnban={() =>
                      run(u, async () => {
                        replace(await adminUnbanUser(u.userId));
                        setNotice(`${u.email ?? "User"} can use Recipes again.`);
                      })
                    }
                    onPurge={(what) =>
                      run(u, async () => {
                        const r = await adminPurgeUserContent(u.userId, what);
                        setNotice(`Deleted ${r.recipesDeleted} recipe(s) and ${r.imagesRemoved} image file(s).`);
                        setOpen(null);
                      })
                    }
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
      {users && users.length < total && (
        <div style={{ textAlign: "center" }}>
          <button className="btn ghost" onClick={() => void load(query.trim(), users.length)}>
            Show more ({total - users.length} left)
          </button>
        </div>
      )}
    </>
  );
}

/**
 * The per-user actions, behind a ••• so a slip of the finger can't ban
 * anyone: every destructive step is two clicks and says what it deletes.
 */
function ManagePanel({
  user,
  isMe,
  busy,
  onViewRecipes,
  onBan,
  onUnban,
  onPurge,
}: {
  user: AppUser;
  isMe: boolean;
  busy: boolean;
  onViewRecipes: () => void;
  onBan: (opts: { reason?: string; deleteRecipes: boolean; deleteImages: boolean }) => void;
  onUnban: () => void;
  onPurge: (what: { recipes: boolean; images: boolean }) => void;
}) {
  const [mode, setMode] = useState<null | "ban" | "purge">(null);
  const [reason, setReason] = useState("");
  const [delRecipes, setDelRecipes] = useState(false);
  const [delImages, setDelImages] = useState(false);
  // An admin can't be banned (demote first), and nobody bans themselves —
  // the server refuses both too.
  const canBan = !isMe && user.role !== "admin" && !user.bannedAt;

  const checks = (
    <div className="admin-checks">
      <label>
        <input type="checkbox" checked={delRecipes} onChange={(e) => setDelRecipes(e.target.checked)} /> Delete all
        their recipes (and those recipes' photos)
      </label>
      <label>
        <input
          type="checkbox"
          checked={delImages || delRecipes}
          disabled={delRecipes}
          onChange={(e) => setDelImages(e.target.checked)}
        />{" "}
        Delete all their images (photos come off their recipes)
      </label>
    </div>
  );

  return (
    <div className="admin-manage">
      {mode === null && (
        <div className="admin-manage-actions">
          <button className="btn secondary" type="button" onClick={onViewRecipes}>
            <Icon name="utensils" /> View their recipes
          </button>
          <button className="btn secondary" type="button" onClick={() => setMode("purge")} disabled={busy}>
            <Icon name="trash-can" /> Delete recipes / images…
          </button>
          {user.bannedAt ? (
            <button className="btn secondary" type="button" onClick={onUnban} disabled={busy}>
              <Icon name="check" /> Unban
            </button>
          ) : (
            canBan && (
              <button className="btn danger" type="button" onClick={() => setMode("ban")} disabled={busy}>
                <Icon name="xmark" /> Ban from Recipes…
              </button>
            )
          )}
        </div>
      )}

      {mode === "ban" && (
        <div className="admin-confirm">
          <span>
            Ban <strong>{user.email ?? "this user"}</strong> from Recipes. They keep their ConjureOS account and every
            other app; Recipes will tell them their access was removed.
          </span>
          <input
            className="admin-reason"
            type="text"
            placeholder="Reason (shown to admins only)"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
          {checks}
          <button className="btn ghost" type="button" onClick={() => setMode(null)}>
            Cancel
          </button>
          <button
            className="btn danger"
            type="button"
            disabled={busy}
            onClick={() => onBan({ reason: reason.trim() || undefined, deleteRecipes: delRecipes, deleteImages: delImages })}
          >
            Ban{delRecipes || delImages ? " and delete" : ""}
          </button>
        </div>
      )}

      {mode === "purge" && (
        <div className="admin-confirm">
          <span>
            Delete content from <strong>{user.email ?? "this user"}</strong> without banning them. This can't be
            undone.
          </span>
          {checks}
          <button className="btn ghost" type="button" onClick={() => setMode(null)}>
            Cancel
          </button>
          <button
            className="btn danger"
            type="button"
            disabled={busy || (!delRecipes && !delImages)}
            onClick={() => onPurge({ recipes: delRecipes, images: delImages || delRecipes })}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

// ── Recipes (moderation) ────────────────────────────────────────────────

function RecipesView({ userFilter, onClearUser }: { userFilter: AppUser | null; onClearUser: () => void }) {
  const [query, setQuery] = useState("");
  const [onlyAi, setOnlyAi] = useState(false);
  const [rows, setRows] = useState<ModRecipe[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const seq = useRef(0);
  const canAi = RECIPE_PHOTOS_ENABLED && isAiPhotoAvailable();

  const load = useCallback(
    async (offset = 0) => {
      const mine = ++seq.current;
      try {
        const r = await adminListRecipes({
          query: query.trim(),
          userId: userFilter?.userId,
          onlyAi,
          limit: PAGE,
          offset,
        });
        if (mine !== seq.current) return;
        setRows((prev) => (offset === 0 || !prev ? r.recipes : [...prev, ...r.recipes]));
        setTotal(r.total);
        setError(null);
      } catch (e) {
        if (mine === seq.current) setError(e instanceof Error ? e.message : String(e));
      }
    },
    [query, userFilter, onlyAi],
  );

  useEffect(() => {
    const t = setTimeout(() => void load(0), 250);
    return () => clearTimeout(t);
  }, [load]);

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const patch = (id: string, p: Partial<ModRecipe>) =>
    setRows((prev) => (prev ? prev.map((r) => (r.id === id ? { ...r, ...p } : r)) : prev));

  return (
    <>
      <div className="muted">
        Every recipe people have added — private ones too. The USDA catalog isn't listed; open a catalog recipe to
        change its photo.
      </div>
      <div className="lib-header">
        <div className="browse-filter">
          <Icon name="magnifying-glass" />
          <input type="text" placeholder="Search by title…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>
      <div className="cat-rail">
        <button type="button" aria-pressed={onlyAi} className={`cat-chip${onlyAi ? " active" : ""}`} onClick={() => setOnlyAi((v) => !v)}>
          <Icon name="wand" /> AI images only
        </button>
        {userFilter && (
          <button type="button" className="cat-chip active" onClick={onClearUser} title="Show everyone's recipes">
            <Icon name="user" /> {userFilter.email ?? userFilter.userId.slice(0, 8)} <Icon name="xmark" />
          </button>
        )}
      </div>

      {error && (
        <div className="status-banner error">
          <Icon name="triangle-exclamation" />
          <span>{error}</span>
        </div>
      )}

      {rows === null ? (
        <div className="center-spinner"><div className="spinner" /></div>
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <Icon name="bowl-food" className="empty-icon" />
          <div>No recipes match.</div>
        </div>
      ) : (
        <div className="admin-list">
          <div className="muted">{total} recipe{total === 1 ? "" : "s"}</div>
          {rows.map((r) => (
            <div key={r.id} className={`admin-row mod-row${busy === r.id ? " busy" : ""}`}>
              <div className="mod-thumb">
                {r.imageUrl ? <img src={r.imageUrl} alt="" loading="lazy" /> : <Icon name="utensils" />}
              </div>
              <div className="admin-id">
                <div className="admin-name">{r.title}</div>
                <div className="admin-email">
                  {r.creatorEmail ?? r.creatorId.slice(0, 8)} · {fmtDate(r.createdAt)}
                </div>
                <div className="mod-pills">
                  <span className="pill">{r.visibility}</span>
                  {r.chefFeatured && <span className="pill cat">chef post</span>}
                  {r.imageAi && <span className="pill ai">AI image</span>}
                </div>
              </div>
              <div className="mod-actions">
                {canAi && (
                  <button
                    className="btn secondary"
                    type="button"
                    disabled={!!busy}
                    onClick={() =>
                      run(r.id, async () => {
                        const { url } = await generateRecipePhoto({ title: r.title, ingredients: r.ingredients }, r.category);
                        await adminSetRecipeImage(r.id, url);
                        patch(r.id, { imageUrl: url, imageAi: true });
                      })
                    }
                  >
                    <Icon name="wand" /> {busy === r.id ? "Working…" : "AI photo"}
                  </button>
                )}
                {r.imageUrl && (
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={!!busy}
                    onClick={() =>
                      run(r.id, async () => {
                        await adminRemoveRecipeImage(r.id);
                        patch(r.id, { imageUrl: null, imageAi: false });
                      })
                    }
                  >
                    <Icon name="xmark" /> Remove photo
                  </button>
                )}
                {confirmDelete === r.id ? (
                  <>
                    <button className="btn ghost" type="button" onClick={() => setConfirmDelete(null)}>
                      Keep
                    </button>
                    <button
                      className="btn danger"
                      type="button"
                      disabled={!!busy}
                      onClick={() =>
                        run(r.id, async () => {
                          await adminDeleteRecipe(r.id);
                          setRows((prev) => (prev ? prev.filter((x) => x.id !== r.id) : prev));
                          setTotal((t) => Math.max(0, t - 1));
                          setConfirmDelete(null);
                        })
                      }
                    >
                      Delete recipe
                    </button>
                  </>
                ) : (
                  <button className="btn ghost" type="button" disabled={!!busy} onClick={() => setConfirmDelete(r.id)}>
                    <Icon name="trash-can" /> Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {rows && rows.length < total && (
        <div style={{ textAlign: "center" }}>
          <button className="btn ghost" onClick={() => void load(rows.length)}>
            Show more ({total - rows.length} left)
          </button>
        </div>
      )}
    </>
  );
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

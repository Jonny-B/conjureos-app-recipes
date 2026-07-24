import { useCallback, useEffect, useState } from "react";
import {
  acceptInvite,
  createFamily,
  declineInvite,
  getFamilyInfo,
  inviteFamilyMember,
  joinFamily,
  myInvites,
  setUsername,
  type AppFamily,
  type AppProfile,
  type FamilyInvite,
  type FamilyMember,
} from "../bridge/recipesApi";
import { Icon } from "../icons";

/**
 * Family management: claim a username, create or join a family (invite code),
 * see members, add someone by @username, and share the invite code. Reached
 * from the Plans tab. On any change it calls onChanged so the parent reloads
 * the profile (families drive the realtime subscription + the Family plans
 * view).
 */
export function FamilyScreen({
  profile,
  onChanged,
  onBack,
}: {
  profile: AppProfile | null;
  onChanged: () => Promise<AppProfile | null>;
  onBack: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null); // expanded family id
  const [invites, setInvites] = useState<FamilyInvite[]>([]);

  const loadInvites = useCallback(() => {
    myInvites()
      .then(setInvites)
      .catch(() => setInvites([]));
  }, []);
  useEffect(() => loadInvites(), [loadInvites]);

  return (
    <div className="browse-screen">
      <div className="detail-actions">
        <button className="btn ghost" onClick={onBack}>
          <Icon name="chevron-down" className="back-caret" /> Plans
        </button>
      </div>
      <div className="browse-header">
        <h2>Family</h2>
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        Share plans and shopping lists with your household. Family plans sync to
        everyone in the family live.
      </p>

      <UsernameBlock profile={profile} onChanged={onChanged} />

      {invites.length > 0 && (
        <section className="home-section">
          <div className="home-section-head">
            <h3>Invitations</h3>
          </div>
          <div className="fam-list">
            {invites.map((inv) => (
              <InviteCard
                key={inv.familyId}
                invite={inv}
                onAccept={async () => {
                  await acceptInvite(inv.familyId).catch(() => {});
                  await onChanged();
                  loadInvites();
                }}
                onDecline={async () => {
                  await declineInvite(inv.familyId).catch(() => {});
                  loadInvites();
                }}
              />
            ))}
          </div>
        </section>
      )}

      <section className="home-section">
        <div className="home-section-head">
          <h3>Your families</h3>
        </div>
        {profile && profile.families.length > 0 ? (
          <div className="fam-list">
            {profile.families.map((f) => (
              <FamilyCard
                key={f.id}
                family={f}
                expanded={open === f.id}
                onToggle={() => setOpen(open === f.id ? null : f.id)}
              />
            ))}
          </div>
        ) : (
          <div className="muted" style={{ fontSize: 13 }}>You're not in a family yet.</div>
        )}
      </section>

      <CreateJoin onChanged={onChanged} />
    </div>
  );
}

function UsernameBlock({ profile, onChanged }: { profile: AppProfile | null; onChanged: () => Promise<AppProfile | null> }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (profile?.username) {
    return (
      <div className="username-claimed">
        <Icon name="check" /> You are <strong>@{profile.username}</strong>
      </div>
    );
  }
  const save = async () => {
    const u = value.trim().toLowerCase().replace(/^@/, "");
    if (!/^[a-z0-9_]{3,20}$/.test(u)) {
      setError("3–20 chars: letters, numbers, underscore.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await setUsername(u);
      await onChanged();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/taken/i.test(msg) ? "That username is taken." : msg);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fam-card">
      <h4 style={{ margin: "0 0 4px" }}>Pick a username</h4>
      <p className="muted" style={{ fontSize: 13, margin: "0 0 8px" }}>
        So family members can add you by @name.
      </p>
      <div className="add-ing-form">
        <input
          type="text"
          placeholder="@username"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={20}
          autoCapitalize="none"
          autoCorrect="off"
        />
        <button className="btn" type="button" disabled={busy || !value.trim()} onClick={save}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {error && <div className="fam-error">{error}</div>}
    </div>
  );
}

function InviteCard({
  invite,
  onAccept,
  onDecline,
}: {
  invite: FamilyInvite;
  onAccept: () => Promise<void>;
  onDecline: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fam-card invite-card">
      <div>
        <div className="fam-name">{invite.name}</div>
        <div className="muted" style={{ fontSize: 13 }}>
          {invite.invitedBy ? `@${invite.invitedBy} invited you` : "You've been invited"}
        </div>
      </div>
      <div className="invite-actions">
        <button className="btn" type="button" disabled={busy} onClick={run(onAccept)}>
          Accept
        </button>
        <button className="btn ghost" type="button" disabled={busy} onClick={run(onDecline)}>
          Decline
        </button>
      </div>
    </div>
  );
}

function FamilyCard({
  family,
  expanded,
  onToggle,
}: {
  family: AppFamily;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [members, setMembers] = useState<FamilyMember[] | null>(null);
  const [addValue, setAddValue] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    getFamilyInfo(family.id)
      .then((r) => setMembers(r.members))
      .catch(() => setMembers([]));
  }, [expanded, family.id]);

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(family.inviteCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the code is shown regardless */
    }
  };

  const add = async () => {
    const u = addValue.trim().toLowerCase().replace(/^@/, "");
    if (!/^[a-z0-9_]{3,20}$/.test(u)) {
      setMsg("Enter a valid @username.");
      return;
    }
    setAddBusy(true);
    setMsg(null);
    try {
      const status = await inviteFamilyMember(family.id, u);
      setAddValue("");
      setMsg(
        status === "already_member"
          ? `@${u} is already in the family.`
          : status === "already_invited"
            ? `@${u} has already been invited.`
            : `Invited @${u} — they'll need to accept.`,
      );
      const r = await getFamilyInfo(family.id);
      setMembers(r.members);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setMsg(/user_not_found/i.test(m) ? "No one with that username." : /invite_self/i.test(m) ? "That's you!" : m);
    } finally {
      setAddBusy(false);
    }
  };

  return (
    <div className="fam-card">
      <button className="fam-card-head" onClick={onToggle}>
        <div>
          <div className="fam-name">{family.name}</div>
          <div className="muted" style={{ fontSize: 12 }}>{family.role}</div>
        </div>
        <Icon name={expanded ? "chevron-up" : "chevron-down"} />
      </button>

      {expanded && (
        <div className="fam-card-body">
          <div className="fam-invite">
            <span className="muted" style={{ fontSize: 12 }}>Invite code</span>
            <code className="fam-code">{family.inviteCode}</code>
            <button className="btn secondary" type="button" onClick={copyInvite}>
              <Icon name={copied ? "check" : "copy"} /> {copied ? "Copied" : "Copy"}
            </button>
          </div>

          <div className="ing-group-label">Members</div>
          {members === null ? (
            <div className="muted" style={{ fontSize: 13 }}>Loading…</div>
          ) : (
            <div className="fam-members">
              {members.map((m) => (
                <div key={m.userId} className="fam-member">
                  <Icon name="user" />
                  <span>{m.username ? `@${m.username}` : m.displayName || m.email || "member"}</span>
                  {m.role === "owner" && <span className="fam-owner-tag">owner</span>}
                  {m.status === "pending" && <span className="fam-pending-tag">pending</span>}
                </div>
              ))}
            </div>
          )}

          <div className="add-ing-form" style={{ marginTop: 8 }}>
            <input
              type="text"
              placeholder="Invite by @username"
              value={addValue}
              onChange={(e) => setAddValue(e.target.value)}
              maxLength={20}
              autoCapitalize="none"
              autoCorrect="off"
            />
            <button className="btn secondary" type="button" disabled={addBusy || !addValue.trim()} onClick={add}>
              <Icon name="plus" /> Invite
            </button>
          </div>
          {msg && <div className="fam-note">{msg}</div>}
        </div>
      )}
    </div>
  );
}

function CreateJoin({ onChanged }: { onChanged: () => Promise<AppProfile | null> }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<null | "create" | "join">(null);
  const [error, setError] = useState<string | null>(null);

  const doCreate = async () => {
    setBusy("create");
    setError(null);
    try {
      await createFamily(name.trim() || "My family");
      setName("");
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const doJoin = async () => {
    setBusy("join");
    setError(null);
    try {
      await joinFamily(code.trim());
      setCode("");
      await onChanged();
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setError(/not_found/i.test(m) ? "No family with that code." : m);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="home-section">
      <div className="home-section-head">
        <h3>Start or join</h3>
      </div>
      <div className="fam-card">
        <h4 style={{ margin: "0 0 6px" }}>Create a family</h4>
        <div className="add-ing-form">
          <input type="text" placeholder="Family name (e.g. The Smiths)" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          <button className="btn" type="button" disabled={busy !== null} onClick={doCreate}>
            {busy === "create" ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
      <div className="fam-card">
        <h4 style={{ margin: "0 0 6px" }}>Join with a code</h4>
        <div className="add-ing-form">
          <input type="text" placeholder="Invite code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={20} autoCapitalize="characters" autoCorrect="off" />
          <button className="btn secondary" type="button" disabled={busy !== null || !code.trim()} onClick={doJoin}>
            {busy === "join" ? "Joining…" : "Join"}
          </button>
        </div>
      </div>
      {error && <div className="fam-error">{error}</div>}
    </section>
  );
}

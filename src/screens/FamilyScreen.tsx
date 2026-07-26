import { useEffect, useState } from "react";
import {
  createFamily,
  getFamilyInfo,
  joinFamily,
  renameFamily,
  type AppFamily,
  type AppProfile,
  type FamilyMember,
} from "../bridge/recipesApi";
import { familyInviteLink, parseInvite } from "../features/familyLink";
import { Icon } from "../icons";

const FAMILY_LIMIT = 3;

/**
 * Family management: create a family (name it → get a shareable invite link),
 * join one by pasting an invite link/code, and see members. Family plans + their
 * history are a shared, all-can-edit view (in the Plans tab). Username comes from
 * the ConjureOS account (via the minted token) — there's nothing to pick here.
 * A user can be in at most three families.
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
  const families = profile?.families ?? [];
  const atLimit = families.length >= FAMILY_LIMIT;

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
        Share plans and shopping lists — everything syncs live to everyone.
        {profile?.username && <> Signed in as <strong>@{profile.username}</strong>.</>}
      </p>

      <section className="home-section">
        <div className="home-section-head">
          <h3>Your families</h3>
          <span className="muted" style={{ fontSize: 12 }}>{families.length} of {FAMILY_LIMIT}</span>
        </div>
        {families.length > 0 ? (
          <div className="fam-list">
            {families.map((f) => (
              <FamilyCard key={f.id} family={f} expanded={open === f.id} onToggle={() => setOpen(open === f.id ? null : f.id)} onChanged={onChanged} />
            ))}
          </div>
        ) : (
          <div className="muted" style={{ fontSize: 13 }}>You're not in a family yet.</div>
        )}
      </section>

      <JoinBox atLimit={atLimit} onChanged={onChanged} />
      <CreateBox atLimit={atLimit} onChanged={onChanged} />
    </div>
  );
}

function FamilyCard({
  family,
  expanded,
  onToggle,
  onChanged,
}: {
  family: AppFamily;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => Promise<AppProfile | null>;
}) {
  const [members, setMembers] = useState<FamilyMember[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [rename, setRename] = useState(family.name);
  const [savingName, setSavingName] = useState(false);
  const link = familyInviteLink(family.inviteCode);
  const isOwner = family.role === "owner";

  useEffect(() => {
    setRename(family.name);
  }, [family.name]);

  const saveName = async () => {
    const next = rename.trim();
    if (!next || next === family.name) return;
    setSavingName(true);
    try {
      await renameFamily(family.id, next);
      await onChanged();
    } catch {
      setRename(family.name);
    } finally {
      setSavingName(false);
    }
  };

  useEffect(() => {
    if (!expanded) return;
    getFamilyInfo(family.id).then((r) => setMembers(r.members)).catch(() => setMembers([]));
  }, [expanded, family.id]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — the link is shown to copy by hand */
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
          {isOwner && (
            <>
              <div className="ing-group-label">Family name</div>
              <div className="add-ing-form" style={{ marginBottom: 10 }}>
                <input
                  type="text"
                  value={rename}
                  onChange={(e) => setRename(e.target.value)}
                  maxLength={60}
                  aria-label="Family name"
                />
                <button
                  className="btn secondary"
                  type="button"
                  disabled={savingName || !rename.trim() || rename.trim() === family.name}
                  onClick={saveName}
                >
                  <Icon name="pen" /> {savingName ? "Saving…" : "Rename"}
                </button>
              </div>
            </>
          )}
          <div className="ing-group-label">Invite link</div>
          <p className="muted" style={{ fontSize: 12, margin: "0 0 6px" }}>
            Share this link — opening it drops them straight into this family.
          </p>
          <div className="fam-invite">
            <code className="fam-link">{link}</code>
            <button className="btn secondary" type="button" onClick={copy}>
              <Icon name={copied ? "check" : "copy"} /> {copied ? "Copied" : "Copy link"}
            </button>
          </div>

          <div className="ing-group-label" style={{ marginTop: 10 }}>Members</div>
          {members === null ? (
            <div className="muted" style={{ fontSize: 13 }}>Loading…</div>
          ) : (
            <div className="fam-members">
              {members.map((m) => (
                <div key={m.userId} className="fam-member">
                  <Icon name="user" />
                  <span>{m.username ? `@${m.username}` : m.displayName || m.email || "member"}</span>
                  {m.role === "owner" && <span className="fam-owner-tag">owner</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function JoinBox({ atLimit, onChanged }: { atLimit: boolean; onChanged: () => Promise<AppProfile | null> }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const join = async () => {
    const code = parseInvite(value);
    if (!code) {
      setMsg("Paste an invite link or code.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await joinFamily(code);
      setValue("");
      await onChanged();
      setMsg("Joined!");
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setMsg(
        /family_limit/i.test(m)
          ? `You're already in ${FAMILY_LIMIT} families.`
          : /not_found/i.test(m)
            ? "That invite link isn't valid."
            : m,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="home-section">
      <div className="home-section-head">
        <h3>Join a family</h3>
      </div>
      <div className="fam-card">
        <div className="add-ing-form">
          <input
            type="text"
            placeholder="Paste invite link or code"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
          />
          <button className="btn" type="button" disabled={busy || !value.trim() || atLimit} onClick={join}>
            {busy ? "Joining…" : "Join"}
          </button>
        </div>
        {atLimit && <div className="fam-note">You're in {FAMILY_LIMIT} families already — the max.</div>}
        {msg && <div className={/Joined/.test(msg) ? "fam-note" : "fam-error"}>{msg}</div>}
      </div>
    </section>
  );
}

function CreateBox({ atLimit, onChanged }: { atLimit: boolean; onChanged: () => Promise<AppProfile | null> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await createFamily(name.trim() || "My family");
      setName("");
      await onChanged();
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setError(/family_limit/i.test(m) ? `You're in ${FAMILY_LIMIT} families already — the max.` : m);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="home-section">
      <div className="home-section-head">
        <h3>Create a family</h3>
      </div>
      <div className="fam-card">
        <div className="add-ing-form">
          <input
            type="text"
            placeholder="Family name (e.g. The Smiths)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            disabled={atLimit}
          />
          <button className="btn" type="button" disabled={busy || atLimit} onClick={create}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
        {atLimit && <div className="fam-note">You're in {FAMILY_LIMIT} families already — the max.</div>}
        {error && <div className="fam-error">{error}</div>}
      </div>
    </section>
  );
}

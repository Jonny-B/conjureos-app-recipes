# Family Plans + Realtime — design

Status: **Phase 1 in progress.** Owner-approved 2026-07-24.

Shared week-plans + shopping lists for a "family," synced in near-real-time
across members. Doubles as a test of how far a sandboxed ConjureOS app can push
its own minted-token backend — including **real websocket sync**.

## Decisions (owner)

- **Sync = real Supabase Realtime websockets**, not polling. Explicitly chosen to
  test that a sandboxed app can have a fully-developed backend of its own.
- **All plans move to the DB** (`recipe_plans`), personal and family. `family_id`
  null = a personal ("My") plan; set = shared with that family. Existing local
  (VFS) plans are imported once.
- **Join a family two ways:** a shareable **invite code/link** (works for people
  not yet on Conjure) **and add by @username** (for people already on it).
- **Usernames** are added to the user directory as the human-facing handle.

## Realtime — the proven mechanism

The recipes app is sandboxed: it has **no Supabase session/JWT**, only the public
**anon key** and its minted-token → `recipes-db` action channel. Supabase
`postgres_changes` needs a per-user JWT + RLS, which the app can't provide. So we
use **Realtime Broadcast** instead:

1. Each family has an **unguessable `channel_token`** (high-entropy secret),
   handed only to verified members via a minted-token action.
2. The app opens a Realtime websocket with the **anon key** and subscribes to the
   broadcast channel `family-<channel_token>`. (App-origin CSP is `connect-src *`,
   so `wss://<ref>.supabase.co` is allowed.)
3. On **any family-plan write**, the `recipes-db` edge function (service role)
   emits a broadcast via `POST /realtime/v1/api/broadcast` to that channel with a
   small `plan_changed` payload. Every subscribed member gets it in ~instant time
   and refetches/patches.

Security: the anon key is public by design; access is gated by the **secrecy of
`channel_token`**, which only members receive — the same unguessable-secret
tradeoff already accepted for image URLs / share tokens (see DECISIONS). A later
hardening can move to RLS-authorized channels once a minted→Supabase-JWT bridge
exists.

**Spike result (2026-07-24, dev):** anon client `SUBSCRIBED`; server REST
broadcast returned `202`; client received the payload. Feasible. ✅

## Data model (recipes-db, migration 104)

- `recipe_app_users.username text` — unique (case-insensitive), claimed once.
- `recipe_families (id, name, invite_code unique, channel_token unique, created_by, created_at)`
- `recipe_family_members (family_id, user_id, role owner|member, joined_at, pk(family_id,user_id))`
- `recipe_plans (id, owner_id, family_id null, title, data jsonb, created_at, updated_at)`
  - `data` = `{ picks, shoppingList, constraints, checked, createdAt }` (the WeekPlan).
  - `family_id` null → personal; set → shared with that family.

All service-role only (RLS on, no policies/grants); `recipes-db` derives the
caller from the verified minted token and enforces membership in-process — same
model as the roles tables.

## Edge actions (recipes-db)

Auth (minted token) required for all of these:

- `setUsername(username)` — validate + claim (unique, `[a-z0-9_]{3,20}`).
- `myProfile()` — `{ role, email, username, anonKey, realtimeUrl, families:[{id,name,role,channelToken,inviteCode}] }`.
- `createFamily(name)` — new family + owner membership; returns it.
- `joinFamily(inviteCode)` — add membership; returns family.
- `familyInfo(familyId)` — members (with usernames) + tokens; member-gated.
- `addFamilyMember(familyId, username)` — member adds an existing user by handle.
- `listPlans()` — my personal plans + all plans for my families.
- `savePlan({id?, familyId?, plan})` — upsert; `family_id` must be null or a
  family I'm in; **broadcasts `plan_changed`** to that family's channel on write.
- `deletePlan(id)` — owner (personal) or any member (family); broadcasts.

## Client (recipes app)

- Plan storage moves from `planStorage` (VFS) to `recipesApi` (DB). One-time
  import of existing VFS plans into personal `recipe_plans`.
- **Plans tab** gains a **My / Family** switch. Family view lists plans across the
  families you're in.
- **Realtime**: on load, `myProfile` → subscribe (anon key) to each family's
  `family-<channelToken>` channel; on `plan_changed`, refetch that plan/list.
  Local writes are optimistic, then reconciled.
- **Family UI**: claim a username; create a family (shows invite code/link); join
  by code; add by @username; member list.

## Phasing

- **1a (now):** schema + edge actions + realtime broadcast on write (backend),
  proven on dev.
- **1b:** client — move plans to DB, My/Family switch, realtime subscription,
  username claim, create/join/invite/add-by-username.
- **2 (later):** recipe seeding for a new member on join; family roles
  (owner/remove/leave); RLS-authorized channels; presence.

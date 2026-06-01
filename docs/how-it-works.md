# How It Works — the keystone doc

This is the end-to-end explanation of the Recipes app: what it does, how it's
structured, why those structures exist, and the rules we follow to change and
ship it. Read it top to bottom once; reference it forever.

Status labels (`[Implemented]`, `[Convention]`, `[Planned]`) are defined in
[index.md](./index.md). Unlabelled statements describe code that exists on
`dev` today.

## Contents

1. [What the app is](#1-what-the-app-is)
2. [The layers, and why they exist](#2-the-layers-and-why-they-exist)
3. [The "backend"](#3-the-backend)
4. [Auth & permissions](#4-auth--permissions)
5. [Mocks](#5-mocks)
6. [The manifest & the orchestrator](#6-the-manifest--the-orchestrator)
7. [How PRs work](#7-how-prs-work)
8. [How deployments work](#8-how-deployments-work)

---

## 1. What the app is

Recipes is a single-page app that runs **inside ConjureOS**, in a sandboxed
iframe. The user points a phone camera at the inside of their fridge; the app
returns three recipes they can cook tonight, and can save them to the user's
file space.

It is a **client-only app**. There is no server we own (see
[§3](#3-the-backend)). It is also a **first-class ConjureOS citizen**: it
talks to the host for AI and storage, and it exposes a small API other
installed apps can call (a calorie tracker, a meal planner, a shopping list).

The core user journey — the "build flow" — is a five-step state machine driven
by `src/App.tsx`:

```
capture ──▶ identifying ──▶ ingredients ──▶ generating ──▶ recipes
 (photos)     (AI vision)    (user confirms)   (AI text)     (save)
```

A second top-level tab, **Saved**, browses recipes already written to disk.
The `Screen` union in `src/types.ts` enumerates every state; `App.tsx` is the
only place that transitions between them.

---

## 2. The layers, and why they exist

The source is four layers. Dependencies point in **one direction only**:

```
  screens/   UI: React components + local view state
     │       (CaptureScreen, IngredientsScreen, RecipesScreen, BrowseScreen)
     ▼
  features/  Domain logic: no React, no host globals
     │       (capture, vision, recipes, nutrition, scaling, storage)
     ▼
  bridge/    The ONLY code allowed to touch the host (window.__conjureos / __vfs)
             (ai, vfs, actions) — each ships a dev mock
```

`src/App.tsx` sits above `screens/` and owns the build-flow state machine.
`src/types.ts` is shared by every layer and depends on nothing.

**The load-bearing rule:** only files in `src/bridge/` may reference
`window.__conjureos` or `window.__vfs`. Everything else imports the typed
wrapper (`complete()` from `bridge/ai`, `vfs` from `bridge/vfs`). `features/`
may call the network directly for genuinely external services (e.g. the USDA
fetch in `nutrition.ts`) but never the host.

Why this shape:

- **The bridge isolates the host.** ConjureOS is the one thing we can't run
  locally. Confining it to three small wrappers means (a) the entire host
  surface is auditable in one place, (b) the app is fully runnable outside
  ConjureOS via mocks ([§5](#5-mocks)), and (c) when the host API changes, one
  layer changes.
- **`features/` is where correctness lives.** Quantity parsing, recipe
  scaling, nutrition aggregation, markdown (de)serialization — pure functions
  over plain data. No React, no `window`. This is the layer most worth testing
  and the layer least likely to need changing when the UI is restyled.
- **`screens/` is replaceable.** The Modern-Whimsy restyle touched only CSS and
  markup precisely because presentation is quarantined from logic. A screen
  holds view state (what's being edited, what's expanded) and calls features.

If you find yourself importing `window.__*` outside `bridge/`, or putting a
parsing/scaling rule inside a component, you're fighting the architecture —
stop and move it.

---

## 3. The "backend"

There is no backend server in this repository and none that we operate. What
looks like a backend is three distinct things behind the bridge:

| Capability | Reached via | Provided by | Notes |
|---|---|---|---|
| AI (vision + text) | `bridge/ai.ts` → `window.__conjureos.ai.complete` | ConjureOS host | Host routes to the user's key or the hosted proxy ([§4](#4-auth--permissions)). |
| Persistence | `bridge/vfs.ts` → `window.__vfs` | ConjureOS host | Files, not a database (see below). |
| Cross-app calls | `bridge/actions.ts` → `window.__conjureos.actions` | ConjureOS host | We *register* handlers here; other apps invoke them ([§6](#6-the-manifest--the-orchestrator)). |
| Nutrition macros | `fetch()` in `features/nutrition.ts` | USDA FoodData Central | The one genuinely external HTTP API. |

**Persistence is markdown files, not a DB.** Saved recipes are written to
`/home/Documents/Recipes/<slug>.md` as Markdown with YAML frontmatter
(`src/features/storage.ts`). This is deliberate: the user can open, edit, and
share them in the Files app or any markdown editor, and they sync wherever the
user's file space syncs. The trade-off is that *anything* can edit those files,
so the parser is defensive — size caps, line caps, field-length caps, and
silent skip-on-malformed so one bad file never breaks the Saved list.

**The nutrition cache** is a second VFS file (`nutrition-cache.json`) in the
app's own folder. USDA lookups are cached forever — including misses (cached as
`null` so we don't re-query an ingredient USDA doesn't know). Most users stop
hitting the network after their first handful of cooks because recipes share
core ingredients.

**USDA specifics** live in `features/nutrition.ts`: `Foundation` + `SR Legacy`
datasets, bounded concurrency (3 in flight), and a **session-wide rate-limit
short-circuit** — the first `429` sets a one-hour gate so a batch of recipes
doesn't burn a fresh 429 on every ingredient. Per-serving accuracy is ~±25-40%;
the strip renders `rough` instead of `est.` below 70% ingredient coverage.

---

## 4. Auth & permissions

There is **no user login in this app**. We never see a password, a token, or
the user's identity. Two things commonly mistaken for "auth" are both the
host's job:

- **Model access.** ConjureOS routes `ai.complete` to the user's
  bring-your-own-key (Sonnet at the `capable` tier) or, when they have no key,
  to a hosted free-tier proxy (Haiku). The key never reaches our iframe. We ask
  for a tier; the host decides the model.
- **Capability grants.** Access is **capability-based**, declared in the
  manifest and enforced by the host.

There are two permission surfaces:

**(a) Host capabilities we consume** — declared in `package.json` under
`conjureos.permissions`:

| Permission | Why we need it |
|---|---|
| `ai.complete` | Vision identification + recipe generation |
| `vfs.read` | List saved recipes; read the nutrition cache |
| `vfs.write` | Save recipes; write the nutrition cache |

If a permission isn't declared, the host denies the bridge call. The wrappers
fail soft where they can (a missing host bridge falls through to a mock in dev;
in production a denied call surfaces as an error the UI shows).

**(b) Actions we expose to other apps** — each action in
`conjureos.actions` carries its own `permission`:

- **Reads** (`actions.read`: `listRecipes`, `getRecipe`) are side-effect-free
  and **never prompt**.
- **Writes** (`actions.write`: `addRecipe`, `markCooked`) trigger the host's
  **one-time grant dialog**: the user picks *Allow once / Always / Block*, per
  **calling app**, per **action**. A meal planner that's been granted
  `addRecipe` cannot silently call `markCooked`.

Because callers are **other apps, not us**, every action validates its params
field-by-field before the handler runs — type checks, length caps, allowlist
regexes, slug normalization, control-character stripping (`src/bridge/actions.ts`).
We trust the host; we do not trust callers.

> `[Planned]` Any future notion of per-user accounts, sharing recipes between
> users, or server-side sync would be a new design — it does not exist and
> isn't implied by anything above.

---

## 5. Mocks

**Rule:** every bridge wrapper must run without the host. Each one detects host
absence and falls back to a deterministic local mock, so `npm run dev` boots
the *entire* UI with zero ConjureOS present. This is non-negotiable — it's what
makes the app iterable.

- `bridge/ai.ts` → `mockComplete()` returns canned-but-realistic JSON: a fixed
  ingredient list for image calls, three fixed recipes for text calls, after a
  short delay to mimic latency.
- `bridge/vfs.ts` → an in-memory `Map`. Reads/writes/lists/deletes hit the map.
  It implements **directory semantics** (a path "exists" if anything is stored
  beneath it) so the Saved tab actually populates in dev — without that,
  `listSavedRecipes()` reported the Recipes dir as missing and the tab was
  always empty.

What mocks are **not**: a substitute for testing inside ConjureOS. Real model
output varies, real VFS persists across sessions, real grant dialogs appear.
Mocks prove the UI and the logic wiring; the host proves the integration. The
mock data also doubles as the fixture our end-to-end browser checks drive
against.

> `[Convention]` Add a new bridge capability ⇒ add its mock in the same file,
> in the same PR. A bridge method with no mock breaks `npm run dev` for
> everyone.

---

## 6. The manifest & the orchestrator

**The manifest** is the `conjureos` block in `package.json`. It is the contract
between this app and the host — the authoritative version of much of this doc.
Its fields and who consumes them:

| Field | Consumed by the host to… |
|---|---|
| `displayName`, `icon` | Render the launcher entry. |
| `permissions` | Gate the host capabilities we may call ([§4](#4-auth--permissions)). |
| `actions.<name>.permission` | Decide read-vs-write grant behavior for each cross-app action. |
| `actions.<name>.description` | Tell the orchestrator/assistant **what each action does and when to call it** — these read like tool descriptions for an LLM on purpose. |
| `promptSuggestions` | Seed the assistant with example asks (e.g. "What did I cook this week?"). |

`author` / `repository` (top-level `package.json`) surface on the installed
app's manifest after import.

**The orchestrator** is the ConjureOS kernel/shell. Our app's role in the loop:

1. On boot, `App.tsx` calls `registerActions()` (`bridge/actions.ts`), which
   hands our four handlers to `window.__conjureos.actions.register`. Failure is
   non-fatal — the app stays usable, only cross-app integration is lost.
2. The orchestrator now knows our actions exist and what they're for (from the
   manifest `description`s). When the user (or another app) expresses an intent
   it can satisfy — "log what I cooked", "what's in my recipe library" — it
   invokes the matching action with params.
3. Params arrive at our validated handlers, which read/write through
   `features/storage.ts`.

This is why the action contract matters so much for coherence: the
`description` is the orchestrator's only signal for routing, and the returned
shape is the only thing a consumer (e.g. a calorie tracker) gets. Concretely —
nutrition is stored **per serving**, and `listRecipes` returns both `servings`
and `lastMadeAt`, so a calorie tracker can compute a meal's total
(`perServing × servings`) and answer "what did I cook this week?" without an
extra call per recipe. When you change an action's shape, update the manifest
description **and** this doc in the same PR.

---

## 7. How PRs work

`[Convention]` unless noted. CI enforcement of these gates is `[Planned]`.

**Branching**
- Long-lived integration branch: **`dev`**.
- Work happens on short-lived branches off `dev`; merge back via PR.
- Never push directly to a protected/integration branch when a PR is the norm
  for that change. Never force-push a shared branch.

**Commits**
- One logical change per commit. Imperative subject (≤ ~70 chars); body explains
  the **why**, not a restatement of the diff.
- Don't commit secrets (`.env`, keys) or build output (`dist/`).

**Before you open a PR — the gates (all must pass):**
```bash
npm run typecheck        # tsc, no emit
npm run build            # separate-files build (the ZIP-bundler target)
npm run build:inline     # single-file build (the embedded target)
```
Both builds matter: a change can pass one and break the other (see
[§8](#8-how-deployments-work)).

**Verification — earn the "it works".**
- Logic changes: prove it. We drive the real UI headless (the dev mock is the
  fixture) and assert on observable behavior, not just that it compiles. The
  double-scaling fix, for example, was verified by scaling a recipe, saving it,
  and reading it back through the Saved tab.
- UI changes: actually render it. Type-checking proves code is valid, not that
  a screen looks right. If you can't render it, say so explicitly in the PR.

**PR description** contains:
- **Summary** — what changed and why (1–3 bullets).
- **Test plan** — the gates you ran + the verification you did.
- For cross-app contract changes, call out the shape change explicitly so
  consumer apps' owners see it.

**Review** — use `/review` for a focused diff review, or `/ultrareview` for a
multi-agent pass on the branch/PR. Address findings or explain why they don't
apply.

---

## 8. How deployments work

A "deployment" is getting the built app **into ConjureOS**. There are two build
outputs from one source, selected by a Vite mode flag (`vite.config.ts`):

| Command | Output | Target |
|---|---|---|
| `npm run build` | `dist/` with HTML + separate JS/CSS, sourcemaps on | The **Phase 8 bundler** ingests this when the app is imported as a ZIP. |
| `npm run build:inline` | `dist/index.html`, fully self-contained (JS+CSS inlined), no sourcemaps | What ConjureOS embeds as a **`DEFAULT_APPS`** entry — the kernel's `srcdoc` iframe needs one HTML string with everything inside. |

Both target `es2022` (ConjureOS's floor).

**The two ways to ship**
1. **ZIP import** (per-user / iterative): `npm run build`, zip `dist/`, then in
   ConjureOS: *launcher → Import project… → drop the ZIP*. The bundler handles
   ingest; `author`/`repository` surface on the installed manifest.
2. **Default app** (baked into the OS): `npm run build:inline`, and the single
   HTML string is embedded as a `DEFAULT_APPS` constant in the kernel build.

**Build-time configuration**
- `VITE_USDA_API_KEY` is **baked in at build time** (`.env` at project root).
  No key ⇒ ships with USDA `DEMO_KEY` (30 req/hr/IP). There is no runtime
  config; rebuild to change it.

**The self-contained constraint — the rule deployment imposes back on the code.**
The inline build runs from a `srcdoc` iframe with no guaranteed network and no
external asset loading. So:

- **No runtime dependency on an external asset may be load-bearing.** The
  Modern-Whimsy fonts are loaded from a CDN *as progressive enhancement* and the
  CSS falls back to a rounded system stack (`ui-rounded` → SF Pro Rounded →
  system) so the app looks right with the CDN blocked. If a future asset can't
  degrade gracefully, it must be inlined into the bundle, not fetched.
- Anything that *must* reach the network at runtime (today: the USDA API, via
  the user's environment) has to tolerate being blocked — exactly why the
  nutrition strip is supplementary and the app is fully usable without it.

> `[Planned]` Automated release/versioning and a CI pipeline that produces both
> artifacts on merge to `dev` are not built yet. Until then, builds are produced
> locally and imported by hand as above.

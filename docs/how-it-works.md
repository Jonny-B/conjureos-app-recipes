# How It Works — the keystone doc

This is the end-to-end explanation of Recipes: what it does, how it's
structured, why those structures exist, and the rules we follow to change and
ship it. Read it top to bottom once; reference it forever.

Status labels (`[Implemented]`, `[Convention]`, `[Planned]`) are defined in
[index.md](./index.md). Unlabelled statements describe code that exists on
`main` today (0.60.4).

## Contents

1. [What the app is](#1-what-the-app-is)
2. [The layers, and why they exist](#2-the-layers-and-why-they-exist)
3. [The "backend"](#3-the-backend)
4. [Auth & permissions](#4-auth--permissions)
5. [Running outside ConjureOS](#5-running-outside-conjureos)
6. [The manifest & the orchestrator](#6-the-manifest--the-orchestrator)
7. [How PRs work](#7-how-prs-work)
8. [How deployments work](#8-how-deployments-work)

---

## 1. What the app is

Recipes is a single-page app that runs **inside ConjureOS**, in a sandboxed
iframe served from its own per-app origin (`<slug>.conjureos.app`). It is a
recipe library, full stop: you add recipes (write one, photograph one off a
card or a cookbook page, or describe a dish and have three written), browse
them, and cook them step by step. The pantry, week planner, shopping list and
families that once lived here are Conjure Pantry's now, in its own repo and
store slug; the two apps share nothing. `README.md` has the user-level tour.

The code in this repo is **client-only**: there is no server in it. What it
reads and writes lives behind it, in the ConjureOS repo's `recipes-db` Edge
Function (see [§3](#3-the-backend)). It is also a **first-class ConjureOS
citizen**: it talks to the host for AI, storage and identity, and it exposes
eighteen actions other installed apps can call (Conjure Pantry discovers it
through them).

The core journey is driven by `src/App.tsx` and `screens/RecipesBrowseScreen.tsx`:

```
splash ─▶ library: All · My recipes · Favorites ─▶ open recipe ─▶ guided cook
(catalog   search · category rail · Tonight's pick                 (an overlay)
 loads)         │
                └─ "+" ─▶ write it │ snap a photo │ describe a dish
                              └─▶ editable preview ─▶ save
```

State lives in two places. `App.tsx` holds the `Tab` (`recipes`, `studio`,
`admin`; the tab bar is only drawn for a chef or an admin, so everyone else
sees the library alone), the All / My recipes / Favorites choice, and the
`cookTarget`. `RecipesBrowseScreen` holds its `mode` (`list`, `write`, `snap`,
`describe`) and the open recipe. The guided cook is an **overlay**, not a
screen: the one underneath stays mounted, hidden, so Back lands on exactly what
you were looking at.

---

## 2. The layers, and why they exist

The source is four layers. Dependencies point in **one direction only**:

```
  screens/  components/  hooks/   UI: React components + local view state
     │      (RecipesBrowseScreen, RecipeDetail, GuidedCook, Snap/Create/DescribeScreen,
     │       StudioScreen, AdminScreen, ChefChat; RecipeEditor, RecipePlate, …)
     ▼
  features/  Domain logic: no React, no host globals (mostly, see below)
     │       (catalog, storage, favorites, blocked, nutrition, scaling, recommend,
     │        customRecipe, recipes, aiPhoto, terms, cookSession, capture)
     ▼
  bridge/    The code that touches the host
             (ai, vfs, whoami, recipesApi, actions)
```

`src/App.tsx` sits above `screens/` and owns the tab and the cook overlay.
`src/types.ts` is shared by every layer and depends on nothing. `src/theme.ts`
(light or dark) is its own small module, wired in from `main.tsx`.

**The load-bearing rule:** the host is reached through `src/bridge/`. Screens
and features import the typed wrappers (`complete()` from `bridge/ai`, `vfs`
from `bridge/vfs`, the functions in `bridge/recipesApi`), not `window.__*`.
Three things read a host global directly, each for something with no wrapper:
`theme.ts` (the appearance ConjureOS injects), `features/aiPhoto.ts`
(`ai.image.generate` / `ai.image.edit`) and `features/nutrition.ts`
(`env.usdaProxyUrl`). Add no more without a reason.

Why this shape:

- **The bridge isolates the host.** ConjureOS is the one thing we can't run
  locally. Keeping the host surface in a few small wrappers means it is
  auditable in one place, the app still renders without the host
  ([§5](#5-running-outside-conjureos)), and when the host API changes, one
  layer changes.
- **`features/` is where correctness lives.** Quantity parsing, recipe scaling,
  nutrition aggregation, the recommendation score, the JSON-document guard:
  pure functions over plain data. No React. (Two files draw on a canvas, to
  downscale a photo and to stamp an AI mark; that is the only DOM they touch.)
  This is the layer most worth testing and the layer least likely to need
  changing when the UI is restyled.
- **`screens/` is replaceable.** The squared-off visual language and the
  cookbook layer touched CSS and markup precisely because presentation is
  quarantined from logic. A screen holds view state (what's open, what's
  expanded) and calls features.

If you find yourself reaching for `window.__*` in a screen, or putting a
parsing/scaling rule inside a component, you're fighting the architecture —
stop and move it.

---

## 3. The "backend"

There is no backend server in this repository. What looks like a backend is a
handful of things behind the bridge:

| Capability | Reached via | Provided by | Notes |
|---|---|---|---|
| AI (vision + text) | `bridge/ai.ts` → `window.__conjureos.ai.complete` | ConjureOS host | Every call asks for the `capable` tier; the host picks the model and bills the person ([§4](#4-auth--permissions)). |
| AI images | `features/aiPhoto.ts` → `ai.image.generate` / `ai.image.edit` | ConjureOS host | Desktop only; the buttons hide where the bridge is absent. |
| Saved recipes, roles, moderation, uploads | `bridge/recipesApi.ts` → the `recipesDb` remote action | `recipes-db` Edge Function (ConjureOS repo) | The kernel mints an identity token and POSTs to the manifest's URL; the backend derives the owner from it. |
| The catalog | `bridge/recipesApi.ts` → `fetch` to `env.recipesApiUrl` | `recipes-db` | Public reads, no auth. Falls back to the dev project when the host injects no URL. |
| Indices and caches | `bridge/vfs.ts` → `window.__vfs` | ConjureOS host | Files, not a database (see below). |
| Cross-app calls | `bridge/actions.ts` → `window.__conjureos.actions` | ConjureOS host | We *register* handlers here; other apps invoke them ([§6](#6-the-manifest--the-orchestrator)). |
| Nutrition macros | `fetch()` in `features/nutrition.ts` | `usda-proxy` Edge Function → USDA FoodData Central | The proxy holds the API key; the app never does. |

**Saved recipes are database rows**, not files. A saved recipe's `path` is
`db:<id>` (`recipeIdFromPath` recovers the id). Older versions wrote Markdown
with YAML frontmatter to `/home/Documents/Recipes/<slug>.md`; the first time
the app lists the library against the backend it lifts those files into the
database once, skips titles already there, drops a `.migrated-to-db` flag, and
leaves the files in place as a backup (`migrateLegacyRecipes` in
`features/storage.ts`). That is the only place the Markdown parser still runs,
which is why it still carries its size and line caps.

**The catalog is fetched, never bundled and never persisted.** It loads from
`recipes-db` at startup, 500 rows a page until a short page comes back, all or
nothing: a page that fails three times throws, and the app keeps what it had
rather than presenting the top of the alphabet as the whole thing. Rows are
slim (no ingredients or steps); a recipe's body is fetched when it is opened.
After a failure the implicit "make sure it's loaded" calls wait 15 seconds
before trying again.

**What the VFS holds** (`/home/Documents/Recipes/`): `.favorites.json` (the ids
of favourited *catalog* recipes; a saved recipe's favourite is a column on its
row) and `.blocked.json` (ids the user thumbed down, which only affects
recommendations), both read through `features/jsonDoc.ts`, which refuses to
write over a file it could not read; and, in the app's own folder,
`nutrition-cache.json`. A cook in progress is **not** in the VFS: it is
`localStorage` (`recipes.cookSession.v1`, one slot, 12 hours), because every
tick would otherwise be a write and a sync. The appearance choice is
`localStorage` too.

**The nutrition cache** is the `nutrition-cache.json` file. USDA lookups are
cached forever, including misses (cached as `null` so we don't re-query an
ingredient USDA doesn't know); rate limits and transient errors are not cached.
Most people stop hitting the network after their first handful of cooks
because recipes share core ingredients.

**USDA specifics** live in `features/nutrition.ts`: `Foundation` + `SR Legacy`
datasets, bounded concurrency (3 in flight), and a **session-wide rate-limit
short-circuit** — the first `429` sets a one-hour gate so a batch of recipes
doesn't burn a fresh 429 on every ingredient. Per-serving accuracy is ~±25-40%;
the strip renders `rough` instead of `est.` below 70% ingredient coverage.

---

## 4. Auth & permissions

There is **no login in this app**. We never see a password or a session token.
Three things commonly mistaken for "auth" are the host's job:

- **Identity.** Per-user calls go through the `recipesDb` remote action; the
  kernel mints a short-lived identity token and attaches it, and `recipes-db`
  derives the user from it. `bridge/whoami.ts` (`auth.whoami`) is display-only
  and never a security boundary.
- **Model access.** ConjureOS routes `ai.complete` and bills it to the person
  (their credits, or their own key if they added one). We ask for a tier; the
  host decides the model. Image generation and editing are billed to whoever
  asks, an admin's own credits for an admin's action.
- **Capability grants.** Access is **capability-based**, declared in the
  manifest and enforced by the host.

Roles, bans and terms are the one piece of access control this app has a say
in, and the server is the authority on all of it. `recipes-db` returns the
caller's role (`user`, `chef`, `admin`), whether they are banned from Recipes,
and which version of the terms they accepted (`myRole`); the app only reveals
Studio to a chef or admin and Admin to an admin, and every write is re-checked
server-side. A ban is Recipes-only and the app shows a notice instead of
itself. `recipes-db` refuses `add`, `update`, `chefUpsert` and `uploadImage`
until the terms are accepted (`features/terms.ts`, `TERMS_VERSION`); the app
asks first.

There are two permission surfaces:

**(a) Host capabilities we consume** — declared in `package.json` under
`conjureos.permissions`:

| Permission | Why we need it |
|---|---|
| `ai.complete` | Reading a recipe off a photo, structuring typed text, writing three recipes from a description, the proofread pass, Ask the chef |
| `ai.image` | A recipe photo: generated from scratch or a real photo retouched |
| `vfs.read` | The favourites index, the blocked list, the nutrition cache, the one-time legacy import, the image ConjureOS just generated |
| `vfs.write` | The favourites index, the blocked list, the nutrition cache, the import's done-flag |

If a permission isn't declared, the host denies the bridge call. The wrappers
degrade where they can (a missing host falls back to the in-app stand-ins in
[§5](#5-running-outside-conjureos); in production a denied call surfaces as an
error the UI shows).

**(b) Actions we expose to other apps** — each action in `conjureos.actions`
carries its own `permission`:

- **Reads** (`actions.read`: `listRecipes`, `getRecipe`, `searchRecipes`,
  `listCategories`, `getBlocked`, `scaleSavedRecipe`, `getCatalogRecipe`,
  `getSharedRecipe`, `listChefPicks`, `parseIngredients`, `estimateNutrition`,
  `scaleRecipe`) are side-effect-free, so they change nothing, but they are
  gated like writes: a caller that is not the orchestrator is asked too
  (ConjureOS `actionRegistry.ts`, Phase 30b: without it any installed app could
  silently read your whole library).
- **Writes** (`actions.write`: `addRecipe`, `importRecipeFromImage`,
  `markCooked`, `unmarkCooked`, `setFavorite`, `setBlocked`) are gated the same
  way. Both kinds trigger the host's **one-time grant dialog**, which says which
  kind it is: the user answers Don't allow / Allow once / Always allow, per
  **calling app**, per **action**. A meal planner that's been granted
  `addRecipe` cannot silently call `markCooked`.

The orchestrator (Chat) is trusted shell code and is never prompted, so the
actions left out on purpose (deleting a recipe, publishing one, every admin
function) are left out because no unattended caller should do them, not
because "the user will be asked".

Because callers are **other apps, not us**, every action validates its params
field-by-field before the handler runs — type checks, length caps, slug and id
checks that reject rather than repair, control-character stripping
(`src/bridge/actions.ts`). We trust the host; we do not trust callers.

> `[Planned]` Anything beyond this — a sharing model other than a recipe's
> `private` / `unlisted` / `public` visibility, offline use of the library —
> would be a new design. It does not exist and isn't implied by anything above.

---

## 5. Running outside ConjureOS

`npm run dev` (`conj-pack dev`) is an esbuild dev server and **nothing more**:
it injects no bridge, so `ai.complete`, `actions.*`, `auth.whoami`, `notify`
and the VFS are absent (ConjureOS #722).

**The app's own convention:** its bridge wrappers detect host absence and fall
back to an in-app stand-in, so the UI renders without ConjureOS:

- `bridge/ai.ts` → `mockComplete()` returns canned JSON keyed on the system
  prompt: a tidied recipe for the formatter and reviewer, a transcribed recipe
  for Snap-a-recipe, three recipes for Describe. (It still carries replies for
  the retired fridge-scan, planner and store-aisle prompts; nothing calls them.)
- `bridge/vfs.ts` → an in-memory `Map` with **directory semantics** (a path
  "exists" if anything is stored beneath it).
- `bridge/whoami.ts` poses as a chef; `getMyRole()` poses as an admin; the
  admin user list is three fake users; `uploadRecipeImage` echoes a data URL.
- `isBackendAvailable()` is false, so the library lists empty and
  `registerActions()` does nothing. The public catalog is the exception: it is
  a plain `fetch` to the dev project's `recipes-db`, so it really loads.

What these are **not**: a substitute for testing inside ConjureOS. Real model
output varies, real grant dialogs appear, and none of the stand-ins say how the
real bridge behaves. They prove the UI and the wiring; the host proves the
integration. The gate for a change is the store build ([§7](#7-how-prs-work)).

> `[Convention]` A new bridge capability gets a host-absent path in the same
> file, in the same PR, so `npm run dev` keeps rendering.

---

## 6. The manifest & the orchestrator

**The manifest** is the `conjureos` block in `package.json`. It is the contract
between this app and the host — the authoritative version of much of this doc.
Its fields and who consumes them:

| Field | Consumed by the host to… |
|---|---|
| `displayName`, `icon` | Render the launcher entry (`Recipes`, `fa:utensils`). |
| `permissions` | Gate the host capabilities we may call ([§4](#4-auth--permissions)). |
| `actions.<name>.permission` | Decide read-vs-write grant behavior for each cross-app action. |
| `actions.<name>.description` | Tell the orchestrator/assistant **what each action does and when to call it** — these read like tool descriptions for an LLM on purpose. |
| `actions.<name>.params` / `returns` | Validate callers' params before the handler runs, let Chat offer the action at all, and let other apps discover this one **by shape**. |
| `remoteActions.recipesDb` | The `recipes-db` URL the kernel POSTs to with a minted token. The committed URL is prod; the publish workflow stamps the target project's. |
| `promptSuggestions` | Seed the assistant with example asks (e.g. "What did I cook this week?"). |
| `appType`, `editable` | `"sealed"` and `false` (ConjureOS Phase 62): the AI changes nothing in this app. Never drop either; `scripts/app-type.test.ts` holds them. |

`author` / `repository` (top-level `package.json`) surface on the installed
app's manifest after install.

**The orchestrator** is the ConjureOS kernel/shell. Our app's role in the loop:

1. On boot, `App.tsx` calls `registerActions()` (`bridge/actions.ts`), which
   hands our eighteen handlers to `window.__conjureos.actions.register`.
   Failure is non-fatal — the app stays usable, only cross-app integration is
   lost.
2. The orchestrator now knows our actions exist and what they're for (from the
   manifest `description`s). When the user (or another app) expresses an intent
   it can satisfy — "save this recipe", "what's in my recipe library", "find me
   a chilli" — it invokes the matching action with params. A photo attached in
   Chat arrives as `params.images`, which `importRecipeFromImage` takes.
3. Params arrive at our validated handlers, which read and write through
   `features/storage.ts` and `features/catalog.ts`.

This is why the action contract matters so much for coherence: the
`description` is the orchestrator's only signal for routing, and the returned
shape is the only thing a consumer (e.g. a calorie tracker) gets. Concretely —
nutrition is stored **per serving**, and `listRecipes` returns both `servings`
and `lastMadeAt`, so a calorie tracker can compute a meal's total
(`perServing × servings`) and answer "what did I cook this week?" without an
extra call per recipe. When you change an action's shape, update the manifest
description **and** this doc in the same PR.

**Conjure Pantry reads three of the `returns` schemas by shape.** `listRecipes`
and `searchRecipes` satisfy its `recipeSearch` need, `getRecipe` (and
`getCatalogRecipe`, `getSharedRecipe`) its `recipe` need. The kernel's matcher
fails closed, so dropping a `required` field or narrowing a type disconnects
Pantry with no error anywhere. Before touching those schemas run
`conjureos-pantry/scripts/needs.test.ts`.

---

## 7. How PRs work

`[Convention]` unless noted. CI enforcement of these gates is `[Planned]`
except where a step is named.

**Branching**
- `main` is the branch releases are cut from (the prod publish is a GitHub
  Release on it). Recent work reached it by PR from a short-lived branch.
  `dev` has fallen behind `main` and carries a few commits `main` lacks, so
  check `git log main..dev` before basing anything on it.
- Never push directly to a protected/integration branch when a PR is the norm
  for that change. Never force-push a shared branch.

**Commits**
- One logical change per commit. Imperative subject (≤ ~70 chars); body explains
  the **why**, not a restatement of the diff.
- Don't commit secrets (`.env`, keys) or build output (`dist/`).

**Before you open a PR — the gates (all must pass):**
```bash
npm run typecheck        # tsc -b --noEmit
npm test                 # theme, catalog paging, pack pin, app type
npm run build            # the store bundle -> dist/recipes.html
```
`npm run build` is the gate that matters: it runs `@conjureos/pack`'s
`bundle()`, the bundler CI uses, and throws on a real build error. Code can pass
in `npm run dev` and still break here. Keep `@conjureos/pack` on the `0.4.x`
line CI uses (`npm run check:pack-pin`; `[Implemented]` as a step in the
publish workflow). Bump `version` in **both** `package.json` and
`src/version.ts`; the publish fails if they differ.

**Verification — earn the "it works".**
- Logic changes: prove it. Run the thing and assert on observable behavior, not
  just that it compiles.
- UI changes: actually render it. Type-checking proves code is valid, not that
  a screen looks right. Serve `dist/` and open `dist/recipes.html` for a
  render-and-console check (the bridge is absent there too); if you can't
  render it, say so explicitly in the PR.
- Anything that touches the catalog, photos, terms or moderation also has a
  half in the ConjureOS repo (`recipes-db`, migrations 157 and 190); a change
  that needs a new backend action ships there first.

**PR description** contains:
- **Summary** — what changed and why (1–3 bullets).
- **Test plan** — the gates you ran + the verification you did.
- For cross-app contract changes, call out the shape change explicitly so
  consumer apps' owners see it (Conjure Pantry is the one that reads us).

**Review** — use `/review` for a focused diff review, or `/ultrareview` for a
multi-agent pass on the branch/PR. Address findings or explain why they don't
apply.

---

## 8. How deployments work

A "deployment" is getting the built app **into the ConjureOS App Store**, and
it happens in CI. There is no ZIP import step and no second build target.

| Command / trigger | Output | Target |
|---|---|---|
| `npm run build` | `dist/recipes.html`, one self-contained HTML file | What you inspect locally; the same `bundle()` CI runs. |
| Actions → "Publish to ConjureOS App Store" → Run workflow (`workflow_dispatch`) | A new store version, slug `recipes` | The **dev** project (`dev.conjureos.pages.dev`). |
| Publish a GitHub Release | A new store version, slug `recipes`; the release notes become the changelog | The **prod** project. Ships to real users. |

The workflow (`.github/workflows/publish-store.yml`) checks ConjureOS out
alongside, verifies the `@conjureos/pack` pin against ConjureOS's own range,
stamps the target project's `recipes-db` URL into the manifest's
`remoteActions.recipesDb`, and hands the source to ConjureOS's shared
`publish-anchor-app` action, which builds it with `@bundle` — the same pipeline
a user-published app goes through. Installed copies see the new version as an
update. Mechanics, secrets and the one-time bootstrap are in ConjureOS's
`ANCHOR_APP_CI_SETUP.md`.

**Build-time configuration:** none. There is no `.env` and no `VITE_*` value:
the USDA key lives on the server (`usda-proxy`), and the backend URLs arrive at
runtime from the host (`env.recipesApiUrl`, `env.usdaProxyUrl`) or the
manifest.

**The constraints deployment imposes back on the code.**

- **Relative imports are extensionless** (the bundler can't resolve `.js` on a
  TypeScript import), and an extension missing from the bundler's loader map
  (`.scss`, `.md`, `.yaml`, …) silently becomes a string.
- **Bare imports are loaded from a CDN** by the store bundle, which can't serve
  a CSS-only package. That is why `src/conjureos-ui.css` is a *vendored* copy of
  `@conjureos/ui` (1.x), imported by relative path.
- **Images inline only up to 256 KB** and anything bigger is silently dropped
  from the single-HTML publish. The splash art is a ~115 KB WebP for that reason.
- **No runtime dependency on an external asset may be load-bearing.** The type
  is a system stack (`--font-display` is a serif stack, no web fonts); anything
  that must reach the network at runtime (the catalog, the USDA proxy, saved
  recipes) has to tolerate being unreachable, which is why the library says
  "couldn't reach" instead of "you have no recipes", and why the nutrition strip
  is supplementary.

# Recipes — Internals (technical + decisions)

Working draft for the in-app **ConjureOS Internals** documentation app. Every
`##` block below is one entry in that app's `SECTIONS` array: the `id` and
`title` on the first two lines are the literal `{ id, title }` values, and
everything after the `---` rule is the `body`. Ids are stable — rename a title
if you must, never an id.

Verified against `conjureos-app-recipes` at **`0.31.4`** (`package.json:3`,
`src/version.ts:1`) on 2026-08-21. Where a claim could not be verified from
source, it says so out loud rather than guessing.

> **Two older docs in this folder are stale.** `docs/how-it-works.md` describes
> a Vite build, markdown-file recipe storage, and "no user login" — all three
> were replaced (see `recipes-de-vite-migration`, `recipes-all-in-db-decision`,
> `recipes-identity-and-roles`). Read this file instead; treat `how-it-works.md`
> as history until it is rewritten.

---

## recipes-overview

id: `recipes-overview`
title: Recipes: what it is and where it runs

---

Recipes is the first **Phase 12a anchor app**: a first-party ConjureOS app that
lives in its own repo (`Jonny-B/conjureos-app-recipes`), is built by the *same*
pipeline a user-published store app goes through, and is installed from the App
Store like any other app. It is live in **both the dev and prod App Stores**.

It runs as a sandboxed app inside the ConjureOS shell (desktop/web) and inside
the `conjureos-mobile` WebView. It has no privileged access: everything it can
do is either declared in its manifest (`ai.complete`, `vfs.read`, `vfs.write`)
or brokered through its own backend (`recipes-db`) using a minted identity
token. It never sees the user's Supabase JWT.

What it does today (`src/App.tsx:24`, `src/App.tsx:53`):

- **Home** — greeting, "Tonight's pick" scored against the pantry, stats,
  favorites, jump-in cards, and the two cooking doorways.
- **Recipes** — browse the server catalog + the user's own saved recipes, with
  a source switch (`all` / `favorites` / …) and pantry-aware ranking; also the
  entry point for "Write your own" and "Snap a recipe".
- **Plans** — Plan My Week, family plans, shopping lists, grocery-store layouts.
- **Cook** — not a bottom-bar tab any more; a routable screen reached by tapping
  a recipe (guided cook) or by the Home doorways ("from my kitchen" =
  `PantryScreen`, "describe a dish" = `DescribePane`).
- **Studio** (role `chef` or `admin`) — author promoted "Chef's Favorites"
  posts with a long-form blog.
- **Admin** (role `admin`) — in-app user directory + role management.

Roles are revealed client-side but **enforced server-side**: `useRole()` reads
`myRole` from `recipes-db`, which derives the caller from a verified minted
token (`src/App.tsx:63`, `supabase/functions/recipes-db/index.ts:114`).

---

## recipes-architecture

id: `recipes-architecture`
title: Architecture: pure React + TypeScript, no Vite

---

The repo is **plain source** — React 18 + TypeScript, no bundler config, no
Vite, no `index.html` build step of its own. Dependencies are just
`react` / `react-dom`; devDependencies are `@conjureos/pack`, `@conjureos/ui`,
types, and `typescript` (`package.json`).

Three commands (`package.json` `scripts`):

| Command | What it runs | What it is for |
|---|---|---|
| `npm run dev` | `conj-pack dev` | esbuild dev server with live reload and **mocked bridges**. Not the store pipeline. |
| `npm run build` | `npx -y tsx scripts/build-bundle.mjs` | The **real** store bundle → `dist/recipes.html`. |
| `npm run typecheck` | `tsc -b --noEmit` | Type gate. |

Source layers, dependencies pointing one way only:

```
screens/ + components/   React UI and view state
        ↓
features/                domain logic — no React, no host globals
        ↓
bridge/                  the ONLY code allowed to touch window.__conjureos / window.__vfs
```

`src/App.tsx` sits above `screens/` and owns tab routing and the guided-cook
target. `src/types.ts` is shared by every layer and imports nothing.

**The load-bearing rule:** only `src/bridge/*` may reference `window.__conjureos`
or `window.__vfs`. Everything else imports the typed wrapper. Two deliberate
exceptions, both genuinely-external HTTP rather than host access:

- `src/features/nutrition.ts` `fetch`es the USDA proxy directly.
- `src/bridge/recipesApi.ts` `fetch`es the public `recipes-db` actions directly
  (it is a bridge file, so it is inside the rule).

Every bridge wrapper ships a **dev mock** so the whole UI boots with zero
ConjureOS present (`src/bridge/ai.ts:73`, `src/bridge/vfs.ts:33`,
`src/bridge/whoami.ts:42`, and the `isBackendAvailable()` branches throughout
`src/bridge/recipesApi.ts`). Adding a bridge capability without its mock breaks
`npm run dev` for everyone.

---

## recipes-screens-and-flow

id: `recipes-screens-and-flow`
title: Screens, routing, and the data flow through them

---

There is no router library. `src/App.tsx` holds a `Tab` union
(`"home" | "recipes" | "cook" | "plan" | "studio" | "admin"`, `src/App.tsx:24`)
and renders one screen per tab. `studio` and `admin` are appended to the tab
list only for the matching role (`src/App.tsx:69-71`).

Screen graph (who renders whom):

- `HomeScreen` → `RecipeDetail`
- `RecipesBrowseScreen` → `RecipeDetail`, and `CreateScreen` / `SnapRecipeScreen`
  for the "new recipe" modes (`src/screens/RecipesBrowseScreen.tsx:170`)
- `CookTab` (`src/App.tsx:369`) → `PantryScreen` (mode `kitchen`) or
  `DescribePane` (mode `describe`)
- `PantryScreen` → `CaptureScreen` (fridge scan) and `RecipesScreen` (matches)
- `PlansScreen` → `PlanWeekScreen`, `FamilyScreen`, `StoreEditor`
- `PlanWeekScreen` → `CaptureScreen` (scan pantry into the plan)
- `GuidedCook` → `ChefChat`
- `StudioScreen` → `CreateScreen` / `SnapRecipeScreen` in `chefMode`
- `CreateScreen`, `SnapRecipeScreen`, `StudioScreen` all → the shared
  `components/RecipeEditor.tsx` → `components/ImagePicker.tsx`

Two flows worth tracing end to end:

**Fridge scan → recipes.** `CaptureScreen` downsizes each photo to ≤1280px JPEG
(`src/features/capture.ts:10`) → `features/vision.identifyIngredients()` (one
vision `ai.complete`) → the user **confirms/edits** the ingredient list →
`features/recipes.generateRecipes()` (a second text `ai.complete`) → three
recipes (easy/medium/hard) → guided cook or save.

**Snap a recipe → saved recipe.** Same `CaptureScreen` → `features/customRecipe
.extractRecipeFromPhotos()` (vision, "recipe transcriber" prompt) →
`RecipeEditor` for human correction → `saveRecipe()` → `recipes-db`.

The guided cook stays mounted-but-hidden under `CookTab` so a "pick → cook →
back → pick another" detour does not lose the generated results
(`src/App.tsx:190`).

---

## recipes-bridges

id: `recipes-bridges`
title: The bridge layer: every host surface the app touches

---

`src/bridge/` is the complete inventory of host contact points.

| File | Host surface | Notes |
|---|---|---|
| `ai.ts` | `window.__conjureos.ai.complete` | Gated on the `ai.complete` permission. Accepts `system`, `messages` (with `images`), `maxTokens`, `tier`. The image attachment shape was added to the iframe AI bridge in ConjureOS `0.5.29` **specifically for this app** (`src/bridge/ai.ts:12`). |
| `vfs.ts` | `window.__vfs` | `read/write/exists/ls/mkdir/rm`, gated on `vfs.read` / `vfs.write`. |
| `actions.ts` | `window.__conjureos.actions.register` | Registers the five cross-app actions this app *provides*. |
| `recipesApi.ts` | `window.__conjureos.actions.invoke` + plain `fetch` | The `recipes-db` client — both the tokenless public reads and the minted-token per-user ops. |
| `whoami.ts` | `window.__conjureos.auth.whoami()` | Display-only identity (Phase 30g subset). Explicitly **not** a security boundary (`src/bridge/whoami.ts:5`). |
| `realtime.ts` | none (raw `WebSocket`) | Hand-rolled Phoenix-channels client for Supabase Realtime *broadcast* — the app has only the public anon key, so `postgres_changes` is impossible; it subscribes to `family-<channelToken>` instead (`src/bridge/realtime.ts:1`). |

`recipesApi.ts` derives the app's own kernel path from its origin rather than
hardcoding `/apps/recipes` (`src/bridge/recipesApi.ts:30`): desktop serves each
app from `<slug>.conjureos.app`, mobile from `<slug>.mobile.conjureos.app`, and
mobile's install-time collision avoidance can land the app at `/apps/recipes-2`
— a hardcoded path then fails to resolve and silently breaks every per-user
backend call.

---

## recipes-data-model

id: `recipes-data-model`
title: Data model: one `recipes` table, `source` splits catalog from user

---

Everything recipe-shaped lives in **one Postgres table**, `public.recipes`,
created by ConjureOS migration **`supabase/migrations/086_recipes.sql`**.

The column that carries the design:

```sql
source text not null default 'user' check (source in ('user', 'catalog'))
```

- `source = 'catalog'` + `creator_id is null` + `visibility = 'public'` — the
  curated public catalog. Read without auth.
- `source = 'user'` + `creator_id = <ConjureOS user id>` — a user's own recipe.
  Owner-scoped, defaults to `visibility = 'private'`.

Because catalog and user rows share a table, a saved recipe and a catalog recipe
are the same shape all the way to the UI, and one filter (`.eq("source",
"catalog")`, `supabase/functions/recipes-db/index.ts:1117`) separates them.

Other notable columns (086 unless stated):

| Column | Purpose |
|---|---|
| `visibility` (`public`/`unlisted`/`private`) + `share_token` | Mirrors the `store_apps` sharing model (migrations 005/022/065), so a user recipe can be made public or shared by link with **no schema change**. |
| `source_url` | Attribution. Every catalog row keeps its original recipe URL; the app renders it as a "Source" link. |
| `ingredients`, `instructions`, `tokens`, `tags`, `nutrition` | `jsonb`. `tokens` is the precomputed canonical-ingredient projection used for pantry matching. |
| `favorite`, `made_count`, `last_made_at` | Per-row user state on saved recipes. |
| `rating` | 1–5 stars, **migration `087_recipes_rating.sql`**. Nullable; `NULL` = not rated (0 is not allowed). |
| `chef_featured`, `blog` | **Migration `108_recipes_chef.sql`** — a chef post is a normal row with `chef_featured = true`. |
| `image_url` | **Migration `109_recipe_images.sql`** — public URL in the `recipe-images` bucket. |

**RLS shape (086).** `select` is allowed for anon on public rows, for
authenticated on public-or-own rows, and for admins on everything. There are
**deliberately no client `insert`/`update`/`delete` policies** — the only writer
is the service role inside the `recipes-db` Edge Function, which has already
verified the minted token. Grants: `select` to `anon, authenticated`; full CRUD
to `service_role`.

The client's saved-recipe `path` is the synthetic string `db:<uuid>`
(`src/bridge/recipesApi.ts:131`); `recipeIdFromPath()` recovers the id. There is
no longer a real file path for a recipe.

Sibling tables, all service-role-only (RLS on, **zero** policies and grants):
`recipe_app_users` (107, roles + username), `recipe_families` /
`recipe_family_members` / `recipe_plans` (110), plus the invite `status` /
`invited_by` columns (111).

---

## recipes-backend-recipes-db

id: `recipes-backend-recipes-db`
title: The `recipes-db` backend and the minted-token auth path

---

`supabase/functions/recipes-db/index.ts` (in the **ConjureOS** repo, ~1,380
lines) is the app's BYO backend. It is deployed with `verify_jwt = false`
because (a) the minted ConjureOS token is not a Supabase JWT so the gateway
cannot check it, and (b) the public actions must work with no auth at all. All
verification happens in-process.

**Two access classes.**

1. **Public, tokenless** — `catalog`, `catalogGet`, `catalogFacets`,
   `getShared`, `chefFeed` (`index.ts:75`). The client `fetch`es these directly
   at the URL the kernel injects as `window.__conjureos.env.recipesApiUrl`,
   falling back to the dev project when the host injects nothing (i.e. under
   `conj-pack dev`) — `src/bridge/recipesApi.ts:20,48`.
   `planWeek` is deliberately **not** public: it is the CPU-heavy action, so it
   stays behind a verified token.
2. **Per-user, token-gated** — everything else: `list`, `get`, `add`, `update`,
   `delete`, `setVisibility`, `setFavorite`, `setRating`, `markCooked`,
   `planWeek`, `listPlans`, `savePlan`, `deletePlan`, `myRole`, `myProfile`,
   `setUsername`, the family verbs, `chefUpsert`, `uploadImage`,
   `adminListUsers`, `adminSetRole`.

**How the token works (Phase 16c remote actions).** The app declares its own
backend in the manifest:

```json
"remoteActions": { "recipesDb": { "url": "<project>/functions/v1/recipes-db", "method": "POST" } }
```

The app invokes **its own** remote action
(`actions.invoke(APP_PATH, "recipesDb", { action, ...params })`). The kernel
mints a short-lived ES256 token via `mint-app-token` with `sub` = the ConjureOS
user id and `aud` = the function's origin, attaches it as a bearer, and POSTs.
`recipes-db` verifies it against the `mint-app-token` JWKS (issuer + audience
checked), takes `sub` as the owner, and then runs as the **service role** —
RLS is bypassed, and ownership is enforced in code by `creator_id` filters
(e.g. `setRating`'s `.eq("creator_id", userId)`, `index.ts:1275`).

**Why this instead of handing the app a JWT.** A sandboxed store app must never
hold the user's Supabase session — and on mobile it structurally cannot (the
WebView never receives the JWT). The minted token is the platform's answer, and
Recipes is the precedent later reused by Conjure Health's community food DB.

**Side effects worth knowing.** On every token-verified call the function
best-effort registers/refreshes the caller in `recipe_app_users`
(`touchUser`, `index.ts:104`), and a bootstrap-admin allowlist grants `admin` on
first sign-in so the in-app console can take over role management with no seed
row (`index.ts:44-46`).

**Paging.** `catalog` clamps `limit` server-side (currently 1..1000, default 50
— `index.ts:1100`). An older deploy clamped at 200, which silently truncated the
browse list, so the client now **pages until a short page comes back** rather
than trusting one call (`src/bridge/recipesApi.ts:193`).

---

## recipes-catalog-pipeline

id: `recipes-catalog-pipeline`
title: The catalog: how it is built, and where it lives now

---

**Current state (since `0.30.0`, commit `fc3381d`): the catalog is NOT bundled
and NOT stored on the device.** `src/data/catalog.ts` was deleted; there is no
offline fallback path any more. `src/features/catalog.ts` fetches from
`recipes-db` on load and holds the result **in memory only** — closing the app
drops it. Bundle size went 1.78 MB → 0.37 MB.

Two sources of truth had already drifted (the bundled copy had 1,170 rows while
prod had ~3,170), which is what forced the change.

What the client fetches:

- A **slim projection** for the whole corpus — `id, title, category, difficulty,
  cook_time, servings, nutrition, tags, tokens, image_url, source_url,
  chef_featured` (`recipes-db` `LIST_COLS`, `index.ts:1112`). `ingredients` and
  `instructions` are ~66% of the payload and are left off.
- `tokens` rides along anyway because pantry matching and "cook from my kitchen"
  rank the *whole* corpus; without it those screens silently rank nothing.
- The **body** (`ingredients` + `instructions`) is fetched per recipe via
  `catalogGet` the first time a recipe is opened, then memoized for the session
  (`src/features/catalog.ts:64` `loadRecipeBody`). Every open path hydrates the
  body first so a slim row never renders empty.
- Plan My Week now calls the **server** optimizer (`planWeek`) over the full
  catalog and builds the shopping list locally from the ~5–7 returned picks.

**How the catalog data was produced (build-time, offline).**

`scripts/build-catalog.ts` turns a scraped AllRecipes corpus (a ~64 MB Postgres
`pg_dump`) into a compact record set. It downloads the dump once and caches it
under `scripts/.cache/` (gitignored), then parses, normalizes, dedupes,
classifies a category, infers difficulty, computes per-serving nutrition, and
precomputes `tokens` using the **same** `parseIngredient` the runtime matcher
uses (`src/features/nutrition.ts`) so ranking is a set-compare with zero drift.

```bash
npx -y tsx scripts/build-catalog.ts --limit 1500
```

The emitted record is deliberately terse (`scripts/build-catalog.ts:479`):
`i` id, `t` title, `c` category index, `d` difficulty, `m` cook time, `s`
servings, `g` ingredients, `n` instructions, `u` source URL, `k` tokens,
`z` nutrition tuple, `a` tags. **There is no description/summary field.**

Two companion scripts:

- `scripts/gen-seed-sql.ts` — turns the catalog into batched SQL
  (`delete from public.recipes where creator_id is null and source='catalog'`
  followed by 200-row `insert`s) applied via the Supabase Management API SQL
  endpoint. It inserts `title, category, difficulty, cook_time, servings,
  ingredients, instructions, tokens, nutrition, tags, source_url, source,
  visibility` — **no `summary`**.
- `scripts/recategorize-catalog.ts` — a conservative category-repair pass (only
  moves a recipe on a confident signal).

**Caveat for anyone rerunning these:** `build-catalog.ts` still defaults its
output to `src/data/catalog.ts`, and `rewrite-catalog.ts` / `gen-seed-sql.ts` /
`recategorize-catalog.ts` all `import { CATALOG } from "../src/data/catalog"`,
which **no longer exists in the repo**. The scripts are therefore currently
broken against `main` and need a regenerated catalog module (or a source
change) before they run. That is a real gap for the licensing work tracked in
`recipes-catalog-licensing`.

---

## recipes-ai-features

id: `recipes-ai-features`
title: Every `ai.complete()` call in the app

---

All model access goes through one wrapper, `complete()` in `src/bridge/ai.ts`,
which is gated on the `ai.complete` permission. The app asks for a **tier**; the
host decides the model (BYO key → Sonnet at `capable`; hosted free-tier proxy →
Haiku regardless of hint). There are **nine** call sites, covering eight
user-facing features (#2 and #3 are two prompts of the same "generate recipes"
feature).

| # | Feature | Call site | Tier | System prompt marker | Vision |
|---|---|---|---|---|---|
| 1 | **Fridge scan** — identify ingredients from fridge photos | `src/features/vision.ts:68` | `capable` | ingredient identifier | ✅ |
| 2 | **Generate three recipes** from confirmed ingredients | `src/features/recipes.ts:64` | `capable` | recipe generator | — |
| 3 | **Describe a dish** → three recipes | `src/features/recipes.ts:135` | `capable` | `DESCRIBE_SYSTEM` | — |
| 4 | **Write your own** — structure pasted text into the schema | `src/features/customRecipe.ts:50` | `capable` | `"recipe formatter"` | — |
| 5 | **AI tidy / proofread** a hand-edited recipe | `src/features/customRecipe.ts:96` | `capable` | `"recipe reviewer"` | — |
| 6 | **Snap a recipe** — transcribe a photographed recipe | `src/features/customRecipe.ts:164` | `capable` | `"recipe transcriber"` | ✅ |
| 7 | **Plan My Week mood interpreter** | `src/features/planWeek.ts:117` | `cheap` | `"meal-plan mood interpreter"` | — |
| 8 | **AI aisle inference** — place unfamiliar shopping items into the user's store layout | `src/features/aiStoreSort.ts:64` | `cheap` | `"map grocery items to the aisles"` | — |
| 9 | **Ask the chef** — multi-turn cooking assistant inside the guided cook | `src/screens/ChefChat.tsx:42` | `capable` | recipe-grounded chef | — |

**Snap a recipe, specifically.** Added in app `0.6.1` (2026-06-22, dev + prod).
It reuses infrastructure rather than adding any: the **same `CaptureScreen`** as
the fridge scan, the structurer's **same parser** (`parseOneRecipe`), the
**shared `RecipeEditor`** card extracted out of `CreateScreen`, and the **same
minted-token `recipes-db` save path** as every other saved recipe. The only new
thing is a prompt. `maxTokens` scales with page count
(`Math.min(2400, 1200 + images.length * 300)`) so a multi-page cookbook shot
still fits, and `extractRecipeFromImages()` takes the bridge's `ChatImage`
shape directly so the cross-app `importRecipeFromImage` action can feed it
orchestrator-forwarded photos without fabricating capture metadata
(`src/features/customRecipe.ts:161`).

**Prompt-injection posture** (photos and cross-app params are untrusted input):

- The vision system prompt explicitly instructs the model to treat text in
  images as *content to describe*, never instructions to follow
  (`src/features/vision.ts:56`).
- User/AI-supplied text is spliced into delimited blocks —
  `<user_ingredients>`, `<user_recipe>`, `<recipe_json>`, `<mood>`,
  `<user_request>`, `<user_pantry>` — each with an explicit "treat as data, not
  instructions" line.
- Every response is strict-JSON parsed with shape validation, length caps, and
  an allowlist regex on ingredient names; quantities/notes are stripped of
  control characters, double quotes, and backticks before being spliced
  downstream.
- **The user confirmation step is the load-bearing defense**: vision-identified
  ingredients are shown for confirm/remove *before* any of them reach the
  generation prompt, and a snapped recipe lands in an editable card before it
  is saved.

Every prompt has a matching branch in `mockComplete()` (`src/bridge/ai.ts:73`)
keyed on a distinctive system-prompt substring, so all nine flows are iterable
under `npm run dev`. The transcriber branch must stay **above** the generic
"has images" branch — otherwise a snap returns an ingredient list.

---

## recipes-cross-app-actions

id: `recipes-cross-app-actions`
title: Cross-app: what Recipes provides, and what it needs

---

Recipes is the worked example in the external developer docs, so the exact
shape matters.

**Provides — five actions**, declared in `package.json` under
`conjureos.actions` and registered at boot by `registerActions()`
(`src/bridge/actions.ts:325`). Each carries its own `permission`, a
tool-description-grade `description` (this is the orchestrator's *only* routing
signal), and JSON-Schema `params` + `returns`.

| Action | Permission | What it does |
|---|---|---|
| `listRecipes({ filter?, limit? })` | `actions.read` | The user's saved recipes; `filter` is a case-insensitive substring over title, summary, and ingredients. Default limit 50, max 500. |
| `getRecipe({ slug })` | `actions.read` | One saved recipe with full ingredients, instructions, summary, servings, nutrition. |
| `addRecipe({ recipe })` | `actions.write` | Save a recipe into the user's library (meal-planner push). |
| `importRecipeFromImage({ images })` | `actions.write` | Transcribe a recipe from up to 6 attached photos and save it — this is "add this recipe to my recipe app" with a photo attached. Runs the same vision transcription as Snap-a-recipe. |
| `markCooked({ slug })` | `actions.write` | Increment `madeCount`, set `lastMadeAt`. |

Reads never prompt (side-effect-free); writes hit the kernel's one-time grant
dialog — *Allow once / Always / Block*, **per calling app, per action**. A
meal planner granted `addRecipe` cannot silently call `markCooked`.

**Callers are not trusted.** Every param is validated field-by-field before the
handler runs: type checks, length caps (title 80, summary 400, 30 ingredients ×
80 chars, 30 instructions × 400 chars), ASCII control-character stripping,
URL-safe slug normalization, numeric range checks, and an image media-type
allowlist (`image/jpeg|png|webp|gif`, max 6 images) — `src/bridge/actions.ts:60`
onward. Invalid params reject as `HANDLER_THREW`, which the kernel reports
cleanly to the caller.

**Shape contract that consumers depend on:** nutrition is stored **per
serving**, and `listRecipes` returns both `servings` and `lastMadeAt`, so a
calorie tracker can compute a meal total (`perServing × servings`) and answer
"what did I cook this week?" with one call, not one per recipe.

**Needs — none.** As of `0.31.4` the manifest declares **no `needs` block**.
Recipes is a Phase-45 *provider*, not a consumer: the self-describing-apps work
(`needs` + shape-matched connection) was built to kill Conjure Health's
hardcoding of *Recipes'* action names, so the `needs` live on the consumer side.
Recipes' contribution to Phase 45 was gaining typed `params`/`returns` on its
actions (app `0.9.4`) so a consumer can shape-match against it. If you are
writing developer docs: Recipes is the "how to expose capability" example, not
the "how to consume one" example.

Also in the manifest: `promptSuggestions` (seeds the assistant with example
asks) and `remoteActions.recipesDb` (see `recipes-backend-recipes-db`).

---

## recipes-local-storage

id: `recipes-local-storage`
title: What still lives in the VFS (and what moved out)

---

Saved recipes and week plans are in the DB. What remains on the device, under
`/home/Documents/Recipes/`, browseable in the Files app:

| Path | Contents |
|---|---|
| `.pantry.json` | The pantry inventory (max 200 items, 256 KB cap). Dot-prefixed so file listings ignore it. `src/features/pantry.ts:14` |
| `.favorites.json` | Favorited **catalog** ids (saved recipes carry their own `favorite` column). Max 5,000 ids. `src/features/favorites.ts:13` |
| `stores.json` | Grocery-store layouts — ordered aisles + category slots + per-item overrides. **Personal by owner decision (2026-07-26)**, never in the shared family DB, so a family shopping list re-groups per viewer. `src/features/storeLayout.ts:63` |
| `nutrition-cache.json` | USDA lookup cache (app-folder relative). `src/features/nutrition.ts:59` |
| `Plans/` | Legacy week plans, read once by the VFS→DB migration then left alone. `src/features/planStorage.ts:13` |
| `.migrated-to-db`, `Plans/.migrated-to-db` | One-shot migration markers. |
| `.family-invite.json` | Kernel→app handoff for `?joinFamily=<code>` web links. Written by the shell, read and deleted by the app; ignored if older than 10 minutes. `src/App.tsx:96` |

**Two one-time migrations** lift pre-existing local data into the DB:
`migrateLegacyRecipes()` (markdown recipes → rows, `src/features/storage.ts:63`)
and `importVfsPlansOnce()` (plan JSON → `recipe_plans`,
`src/features/planStorage.ts:28`). Both are best-effort and flag-guarded so they
run at most once per device — and both had the *same* one-shot-flag bug, fixed
in `0.31.3` (plans) and `0.31.4` (recipes).

The family-invite handoff exists because **no channel passes a runtime URL
param into a sandboxed app** — only `viewportMode` / `signedIn` / `isAdmin` and
static env are injected. The VFS is the one app-readable cross-origin channel,
and Recipes already holds `vfs.read`/`vfs.write`, so the shell drops a file and
emits `shell.app.launchRequested`. Shell `0.42.0`, Recipes `0.25.0`.

---

## recipes-identity-and-roles

id: `recipes-identity-and-roles`
title: Identity, roles, families, and realtime

---

**Identity.** The app never holds a Supabase session. `whoami` gives it a
display-only view of the signed-in user (`src/bridge/whoami.ts`). The
*authoritative* identity is the minted token's `sub`, resolved server-side.

**Roles** (`recipe_app_users.role`, migration 107): `user` (default), `chef`
(unlocks Studio), `admin` (unlocks the in-app console). The client reveals tabs
from `getMyRole()`, but every privileged write re-verifies the role in
`recipes-db` — `chefUpsert` 403s a non-chef; `adminSetRole` is admin-gated
in-process. The role tables have **no** anon/authenticated grants at all, so
only the service-role function can read them.

The app footer surfaces `v<version> · <email> · <role>`, and when the identity
call fails it shows the reason (`REQUIRES_AUTH`, blocked consent, HTTP status)
so a device can be debugged without a console (`src/App.tsx:245`).

**Families** (migrations 110/111). A family has an `invite_code` (shareable) and
a high-entropy `channel_token` handed only to verified members. Week plans live
in `recipe_plans`; `family_id` null = personal, set = shared. Adding someone by
`@username` creates a **pending** invite they must accept — you cannot pull
someone into your family (111). Joining by code stays instant, because entering
the code is itself consent.

**Realtime** is a dependency-free Phoenix-channels client
(`src/bridge/realtime.ts`) over the public anon key: the app subscribes to
`family-<channelToken>` and receives broadcasts that `recipes-db` emits on every
family-plan write. `postgres_changes` is impossible without a session, so
broadcast-with-an-unguessable-channel is the substitute.

**Images.** The app has no storage capability, so `uploadImage` ships bytes as
base64 over the minted-token action and the function service-role-uploads into
the **public** `recipe-images` bucket (migration 109), returning a URL stored on
the row. Public read is required because chef posts and share links are viewed
by other users and signed-out browsers; keys are random UUIDs, so a private
recipe's image is reachable only by someone holding the URL — the same accepted
tradeoff as `issue-attachments` (migration 063). Cap 5 MB, media types
whitelisted.

---

## recipes-nutrition

id: `recipes-nutrition`
title: Nutrition: USDA lookups through a server-side proxy

---

Each recipe gets a per-serving macro strip (`~520 cal · 32g P · 18g F · 48g C ·
est.`). Ingredient quantities are parsed locally
(`parseIngredient`, `src/features/nutrition.ts`), looked up against USDA
FoodData Central's `Foundation` + `SR Legacy` datasets, and aggregated.

**The USDA key is never in the client bundle.** Lookups go through the
`usda-proxy` Supabase Edge Function, which holds `USDA_API_KEY` as a server
secret. Because a store app ships **one** artifact that must run in dev and
prod, the proxy URL is resolved at **runtime** from
`globalThis.__conjureos.env.usdaProxyUrl`, with a fallback to the dev proxy
(`src/features/nutrition.ts:52`). There is no build-time env and no `VITE_*`.

Accuracy is roughly ±25–40% — fine for "should I cook this?", not medical. The
strip renders `rough` instead of `est.` below 70% ingredient coverage. Results
(including misses, cached as `null`) are cached forever in the app's VFS folder,
with bounded concurrency (3 in flight) and a session-wide one-hour gate after
the first `429`.

---

## recipes-build-and-publish

id: `recipes-build-and-publish`
title: Build and publish: one bundler, three places it runs

---

**The bundler.** `@conjureos/pack`'s `bundle()` (esbuild-wasm + a jspm.io
importmap, deps externalized rather than inlined) is the single bundler for:

1. `npm run build` locally — `scripts/build-bundle.mjs` walks the repo into a
   FileMap and calls `bundle(files, { projectName: "Recipes" })`, writing
   `dist/recipes.html`. It deliberately mirrors ConjureOS
   `scripts/bundle-app.ts` so local output matches CI output.
2. **CI**, via the shared composite action
   `ConjureOS/.github/actions/publish-anchor-app` in `source-path` mode, which
   compiles and runs `scripts/bundle-app.ts`.
3. `conj-pack`'s **build-check**, which bundles the app exactly as the shell's
   importer would (see `recipes-build-check-supersession`).

`npm run dev` (`conj-pack dev`) is a *different*, faster path: esbuild with
inlined deps and mocked bridges. Good for iteration, not proof.

**Publishing.** There is no manual ZIP import. `.github/workflows/publish-store.yml`:

- **Dev** → Actions → "Publish to ConjureOS App Store" → *Run workflow*
  (`workflow_dispatch`), publishes to the **dev** Supabase project.
- **Prod** → publish a **GitHub Release**; the release body becomes the store
  changelog.

Three details in that workflow that exist because they bit us:

- The changelog is read from **env vars**, never interpolated via `${{ }}` — a
  release body containing a double quote once failed the job with
  `made: command not found`.
- It checks out ConjureOS pinned to **`dev`** with a read-only PAT (a private
  personal repo can't be referenced as `uses:`), because the publish tooling is
  canonical there. It was briefly pinned to `main`, whose stale bundler emitted
  a broken ~1.8 KB stub to the prod store.
- It **stamps** `conjureos.remoteActions.recipesDb.url` to the project being
  published to. The committed default is **prod**, on purpose: versions
  `0.10.0`–`0.31.0` were published outside this workflow, the stamp never ran,
  and prod shipped pointing at the dev project — every per-user call
  (`myRole`, `myProfile`, `createFamily`, `planWeek`, `markCooked`) failed with
  a bare "Load failed" while public catalog browse kept working. Defaulting to
  prod makes an unstamped publish at worst correct for real users.

The catalog-browse URL does **not** need stamping — it comes from the
kernel-injected `env.recipesApiUrl`, which is already per-environment.

---

## recipes-versioning

id: `recipes-versioning`
title: Versioning: bump both files or CI fails the publish

---

The version lives in **two** places and they must match:

- `package.json` `"version"` — what the store records as the app version.
- `src/version.ts` `APP_VERSION` — what the in-app footer renders.

The publish action greps `src/version.ts` and hard-fails the job when it
disagrees with `package.json`
(`ConjureOS/.github/actions/publish-anchor-app/action.yml:155`):

```
::error::package.json version (X) != src/version.ts APP_VERSION (Y). Bump both together.
```

The check is skipped for apps that don't use the `src/version.ts` convention, so
it is a convention plus a gate, not a platform requirement. Practically: bump
both in the same commit, always.

---

## recipes-catalog-licensing

id: `recipes-catalog-licensing`
title: DECISION — catalog licensing: partially de-risked, NOT resolved

---

**Read this before any public or prod-facing decision about the catalog. The
honest summary is "risk reduced from HIGH to MEDIUM, and the remaining item is
an open blocker."**

**Origin.** The catalog was built from a **scraped AllRecipes dataset** — a
~64 MB `pg_dump` fetched by `scripts/build-catalog.ts` and cached under
`scripts/.cache/` (gitignored). It is third-party content we did not license.

**What has been done.**

1. **Instructions were programmatically rewritten** into original wording
   (commit `e97e085`, app `0.5.2`, "Reword all catalog instructions into
   original wording (copyright de-risk)"). Recipe *instruction prose* is the
   clearly copyrightable expression, so this was the biggest item. The mechanism
   is `scripts/rewrite-catalog.ts`: it `split`s the catalog into small chunk
   files, AI agents rewrite each chunk, then `merge` patches `title` (`t`) and
   `instructions` (`n`) back in by id. **The script itself calls no model** —
   the rewriting was done by agents over the chunk files.
2. **Ingredient lists were left untouched, deliberately.** An ingredient list is
   a statement of fact, not copyrightable expression — *Publications
   International v. Meredith Corp.*, 88 F.3d 473 (7th Cir. 1996). `tokens`
   derive from ingredients, so they inherit the same position.
3. **Attribution retained.** Every row keeps its original `source_url`
   (`recipes.source_url`), rendered as a "Source" link in the app.
4. **Separability built into the schema.** `source = 'catalog'` vs
   `source = 'user'` (migration 086) means catalog rows can be filtered,
   re-seeded, or deleted wholesale without touching a single user recipe.
5. Some **title normalization** happened in the same pass — the rewrite script's
   stated intent includes stripping personal names from titles, and `merge`
   does patch titles.

**What is NOT done — the open blocker.**

Tracked as **[Jonny-B/conjureos-app-recipes#48](https://github.com/Jonny-B/conjureos-app-recipes/issues/48)**,
labelled `legal` + `blocker`, **still open** as of 2026-08-21:

> Recipe **titles** and **descriptions** may still be verbatim from AllRecipes.
> Purely descriptive titles ("Chicken Parmesan") are fine, but creative titles
> ("Grandma's Sunday Secret Casserole") and expressive description text are
> copyrightable.

Its remaining checklist — audit titles, programmatically rewrite/normalize the
creative ones, rewrite or drop descriptions, rebuild, smoke-test — is **entirely
unchecked**. The issue's own assessment: *"Risk level: reduced from HIGH to
**MEDIUM**… should be cleaned up before prod."*

**Facts that complicate the picture — do not paper over these.**

- **The catalog is already live in the prod store.** The 2026-06-21 decision
  entry records that the owner cleared the reworded catalog for prod use,
  releasing an earlier "hold for licensing review" gate, and ~1,170 rows were
  seeded into **both** dev and prod. So #48 is not a pre-launch gate any more;
  it is an open legal item against something already shipped.
- **The live catalog is larger than what was rewritten.** Commit `fc3381d`
  records prod at **~3,170** rows against a bundled/rewritten set of **1,170**.
  Where the extra ~2,000 rows came from, and whether they went through the same
  instruction-rewrite pass, is **not recorded anywhere in this repo**. Treat
  their provenance as unverified.
- **The current build pipeline emits no description field at all.** The
  generated record shape is `i,t,c,d,m,s,g,n,u,k,z,a` — no summary/description
  (`scripts/build-catalog.ts:479`) — and `gen-seed-sql.ts` inserts no `summary`
  column. So *by that path* catalog rows carry no description. Whether the rows
  actually in the dev/prod databases carry summaries (or verbatim titles) has
  **not been checked against the live data**; #48 assumes they may.
- **The rewrite tooling is currently unrunnable.** `rewrite-catalog.ts`,
  `gen-seed-sql.ts`, and `recategorize-catalog.ts` all import
  `../src/data/catalog`, which was deleted in `0.30.0`. Any work on #48 has to
  regenerate that module first.

**Standing rules.**

- The catalog is regenerable and swappable by design; each row keeps its source
  URL; catalog and user content are separable by one column.
- The app itself is MIT (`LICENSE`); the ConjureOS licensing policy
  (2026-05-xx) contemplates moving anchor apps to PolyForm Noncommercial once
  fleshed out. **Neither license says anything about the catalog data**, which
  is third-party content shipped alongside — a distinct question.
- Do not describe the catalog as "licensing-cleared", "de-risked", or "resolved"
  anywhere. The accurate phrasing is: *instructions rewritten; ingredient lists
  not copyrightable; titles and descriptions unaudited; issue #48 open.*

---

## recipes-no-json-import

id: `recipes-no-json-import`
title: DECISION — never `import` a `.json` file in a ConjureOS app

---

**The rule: bundled data ships as a `.ts` module that `export`s a constant.
Never `import data from "./data.json"`.**

**The failure mode, precisely.** The store bundler's loader map covers
`tsx / ts / jsx / js / css` plus image and font types — but **not** `.json`. The
esbuild dev server behind `conj-pack dev` *does* handle JSON. So a JSON import:

- works perfectly in `npm run dev`;
- bundles **without an error** in the store build;
- and hands back **`undefined`** at runtime.

There is no compile error and no bundle warning. The app boots and then crashes
(or silently renders nothing) the first time it touches the imported value — in
Recipes' case `getCatalog()` returning `undefined`, i.e. an empty app, only for
users who installed from the store.

That asymmetry is the whole reason this is a written rule rather than a
footnote: it is invisible in every place a developer normally looks.

**The fix, as shipped.** `scripts/build-catalog.ts` emits a TypeScript module,
not JSON, and says why inline (`scripts/build-catalog.ts:503`):

```ts
// AUTO-GENERATED by scripts/build-catalog.ts. Do not edit by hand.
export const CATALOG = { /* … */ } as {
  v: number; generatedAt: string; count: number; categories: string[]; r: unknown[];
};
```

The broad `as {...}` cast is not cosmetic — it stops `tsc` from deep-inferring a
~1,000-record object literal, which is slow.

**Is the caveat still live?** Yes as a bundler fact, but Recipes no longer has a
bundled data module at all (the catalog moved server-side in `0.30.0`), so the
app is not currently exposed to it. Keep the rule for the next app that wants to
ship data; issue #76 flags re-confirming it before trimming the note from
`CLAUDE.md`.

---

## recipes-de-vite-migration

id: `recipes-de-vite-migration`
title: DECISION — de-Vite: Recipes builds through `@bundle`, like a user app

---

**Call (2026-06-04).** Anchor-app repos stop carrying Vite. Local dev is
`conj-pack dev` (esbuild dev server, shipped in `@conjureos/pack@0.0.4`); the
published build is produced **in CI by ConjureOS `@bundle`** through the
composite action's `source-path` mode. The published artifact is byte-for-byte
the same kind of thing a user gets when they publish through the in-shell App
Store — not a special-cased `vite-plugin-singlefile` inline build.

**Why.** Two pipelines for "the same thing" was the bug. Anchor apps built by
Vite-singlefile diverged from user apps built by `@bundle` — different
minification, inlined vs externalized dependencies — so AI-orchestrated edits
and the app importer behaved *differently* on the two. Collapsing onto one
bundler means one thing to reason about. Recipes proved it: **337 KB inlined →
118 KB externalized**. Dropping Vite from the repo also stops a stray
`npm run dev` from quietly reintroducing the divergent toolchain, which is why
an esbuild dev server was added to `@conjureos/pack` — "local dev" needed a
first-party answer.

**What changed in this repo.**

- No `vite.config.ts`, no `vite` dependency, no `.env` / `VITE_*` build-time
  config. Anything environment-specific is resolved at **runtime** from the
  injected bridge env (`usdaProxyUrl`, `recipesApiUrl`) or stamped into the
  manifest by CI (`remoteActions.recipesDb.url`).
- Two build outputs (`build` + `build:inline`) collapsed to one:
  `npm run build` → `dist/recipes.html`.
- The old "ZIP import / `DEFAULT_APPS` embed" deployment story is gone; publish
  is CI-only.

**Recipes went first; the others did not follow immediately.** Conjure Health /
Fitness and Finance were still on Vite as of the last STATUS entry. So "anchor
apps are de-Vited" is true of *Recipes*, aspirational for the rest — the shared
publish action still supports `html-path` for prebuilt single-file apps, which
is how the Vite ones publish.

**One enabling fix** landed with it: `lib/bundle`'s `resolveInMap` now strips a
leading `./` so `@bundle`'s entry resolves under Node (it had only ever
mattered in-browser). Related later breakage: the recipes workflow was briefly
pinned to ConjureOS `main`, whose stale `lib/bundle` couldn't bundle the
de-Vited app and shipped a raw unbundled ~1.8 KB stub to the **prod** store.
Pin stays on `dev`.

---

## recipes-build-check-supersession

id: `recipes-build-check-supersession`
title: DECISION — the manual `dist/recipes.html` load is no longer the gate

---

**`CLAUDE.md` in this repo still says:**

> Hard rule: never publish (dev or prod) without building the store bundle
> locally and loading it. … Treat "`dist/recipes.html` loads clean" as the gate
> for any publish.

**That rule is out of date.** It is tracked for correction as
[#76](https://github.com/Jonny-B/conjureos-app-recipes/issues/76).

**Why it existed.** Historically `conj-pack` validated only *shape* (manifest,
entry presence, size) while the ConjureOS shell did the real bundling at import
time — two code paths that could disagree. An app could pass validation and then
crash on import, at the user. The manual "build the store bundle and open it"
step was the only way to exercise the real bundler before shipping.

**What closed the gap.** `@conjureos/pack` gained **build-check**
(`node_modules/@conjureos/pack/src/buildcheck.ts`), which runs the **exact**
bundler the shell uses over the app's FileMap and fails the pack when it throws
or emits an error-level message. From its own header:

> This runs the EXACT bundler the shell uses (`./bundle`) over the app's
> FileMap, so a real build error surfaces to the dev BEFORE they ship, not to
> the user at import.

The CLI runs it as a step of packing and returns exit code **1** with
`✖ build-check failed — this app would NOT import cleanly into ConjureOS`
(`src/cli.ts:226-242`). So the gate is now **`conj-pack` exiting 0**.

**The corrected story, in full — including the parts that are still true.**

- **Build-check proves it *bundles*, not that it *works*.** Opening
  `dist/recipes.html` in a browser is still a genuinely useful **runtime**
  sanity check (it runs standalone against the mocked bridges), and it catches
  a class of thing no bundler can: a blank screen, a thrown effect, a broken
  render. Keep it as an optional smoke test; stop calling it the gate.
- **`--skip-build-check` exists** for offline/CI runs, and using it **forfeits
  the guarantee** (shape validation still runs). Build-check also self-skips
  with a warning when jspm.io is unreachable — that is "couldn't verify", not
  "would not import", so a green pack after a jspm outage proves less than
  usual.
- **Recipes' own `npm run build` is not build-check.** `scripts/build-bundle.mjs`
  calls `bundle()` directly, and CI runs `bundle-app.ts` directly — neither goes
  through `conj-pack`. They exercise the same bundler, so a bundle-time failure
  still fails the publish job; they just aren't the CLI's checked path.
- **Version skew is real and open.** `CLAUDE.md` and this repo's
  `devDependencies` pin `@conjureos/pack@^0.1.1`; ConjureOS's publish CLI
  (`scripts/package.json`) pins `^0.2.0`. Local and CI can therefore diverge —
  exactly what the "keep the pin aligned" note was written to prevent. Fixing
  the pin is on #76's checklist.

**Why this matters beyond tidiness:** the same story is going into third-party
developer docs, where the message must be *"if `conj-pack` passes, it imports."*
Leaving a hard rule in place that the toolchain already enforces teaches
developers that the automated check is not trustworthy.

---

## recipes-all-in-db-decision

id: `recipes-all-in-db-decision`
title: DECISION — recipes go all-in-DB (app `0.6.0`, migration 086)

---

**Call (2026-06-2x, dev `0.18.2` / app `0.6.0`).** The Recipes app stops saving
recipes as VFS markdown and stops treating the bundled catalog as the primary
source. Both become rows in **one** Supabase table (migration 086).

**What it replaced.** Saved recipes used to be
`/home/Documents/Recipes/<slug>.md` — Markdown with YAML frontmatter, so a user
could open and edit them in the Files app or any markdown editor. The parser
was defensive (64 KB size cap, 40 frontmatter lines, 1,000-char fields, 60
ingredients / 60 instructions, silent skip on malformed) precisely because
anything could edit those files.

**Why move.** Files don't do the things the product now needs: recipes should
follow the user across devices, a recipe should be shareable by link or made
public, and the catalog needs server-side search/paging/planning. The
`store_apps`-style `visibility` + `share_token` columns mean sharing is a
column flip, not a migration.

**What it cost / kept.**

- The public API of `features/storage.ts` (`saveRecipe`, `listSavedRecipes`,
  `markMade`, `deleteRecipe`, `setSavedFavorite`) is **unchanged**, so screens
  and the cross-app action registry kept working untouched.
- A saved recipe's `path` became the synthetic `db:<id>`.
- The markdown reader survives *only* as the source of a one-time device
  migration into the DB.
- Access is the Phase 16c minted-token pattern applied to a store app — the
  first time that pattern was used this way; Conjure Health's community food DB
  later reused it.
- The bundled catalog was kept as an instant/offline fallback **at the time**;
  that fallback was removed later (see below).

**Follow-on: the catalog leaves the device entirely (`0.30.0`, `fc3381d`).**
Bundling the catalog *and* fetching it meant two sources of truth that had
already drifted (1,170 bundled vs ~3,170 in prod). Call: delete
`src/data/catalog.ts` and the whole fallback path, no legacy branch — everyone
force-updates. Fetch a slim projection into memory, hydrate bodies per recipe on
open, move the week-plan optimizer server-side. Bundle 1.78 MB → 0.37 MB, and
nothing recipe-shaped is written to the device.

---

## recipes-ratings-decision

id: `recipes-ratings-decision`
title: DECISION — 1–5 star ratings (migration 087)

---

Users rate a dish after cooking it; the value shows on recipe cards (rounded to
the half star).

Shape, and the reasoning behind each choice
(`supabase/migrations/087_recipes_rating.sql`):

- **A nullable `smallint` column on `recipes`**, not a separate ratings table.
  It is a per-row, owner-set value — there is no aggregation across users to
  model, so a join table would be pure overhead.
- **`NULL` means "not rated yet"**, deliberately distinct from a 0 rating, which
  the check constraint forbids: `rating is null or (rating between 1 and 5)`.
- **Written through `recipes-db`'s `setRating` action** as the service role,
  scoped `.eq("creator_id", userId)` so a caller can only rate their own row
  (`supabase/functions/recipes-db/index.ts:1259`). `null` clears a rating;
  anything outside 1–5 is a `400 invalid_rating`. There are still **no client
  write policies**, so 086's RLS is unchanged.
- **Additive + idempotent** (`add column if not exists`, no backfill), per the
  migrations rule.

---

## recipes-related-decisions

id: `recipes-related-decisions`
title: DECISION — other recorded calls that shaped Recipes

---

Short entries, each with its reasoning first.

**Anchor apps live outside the ConjureOS repo (2026-05-09).** Because they must
be built the way a third-party app is built — a repo inside the monorepo would
have quietly earned privileges no real developer has. Public on GitHub from the
start, MIT-licensed, branded "an app for ConjureOS".

**Migration numbers are a shared ledger; hand-deploying breaks it (resolved
2026-07-25).** The recipes family backend was hand-deployed to dev and prod all
session via the Management API — the objects existed and worked, but the commits
never merged, so nothing was recorded in `schema_migrations`. Meanwhile `dev`
independently used `101–106`, so the recipes files `101–105` **collided**. Fix:
renumber recipes to **`107–111`** (above dev's 106) and merge them through CI as
the sole applier. Because every statement is additive and idempotent, CI
re-applied against already-existing objects as a no-op and simply **recorded**
the migrations, closing the debt. The general rule this reinforces: CI is the
only applier; the Management API is a scratchpad.

**Cross-app invokes warm a provider in the background (desktop `0.36.0`,
mobile `0.6.17`).** An app-initiated `actions.invoke` on a provider that wasn't
open used to fail on desktop with `TARGET_NOT_RUNNING` and on mobile to pop the
provider fullscreen — Conjure Health's search literally jumped into Recipes.
Owner: *"when one app is taking action in another app I don't want to see that
other app pop up at all."* Now the provider is warmed hidden, answers the
invoke, and never shows a window. Recipes is the provider this was built for.

**Diverged-update false positive + the diff3 merge (`0.26.0`).** Recipes, being
frequently republished and featured, always read as "You've changed this app" on
update: the store had pruned the installed version, and the divergence check
defaulted to `diverged = true`. Fixed with featured-aware retention
(`RETAIN_PREVIOUS_FEATURED = 20`), an exact `installedContentSha` fingerprint
stamped at install and every update, and a self-healing warn path. The
"too large to auto-merge" ceiling was Recipes-shaped too: the whole-file LLM
merge had to reprint 1.76 MB (~440K output tokens) — replaced with a real
line-level **diff3**, which merges clean regions with no model and no size
limit (the 1.47 MB `var CATALOG` blob was one atomic line).

**Grocery-store layouts are personal, not shared (owner, 2026-07-26).** Stored
in the app's VFS (`stores.json`), never in the family DB, so a shared family
shopping list re-groups to whoever is viewing it — your aisles are yours.

**Family invites need acceptance (migration 111).** You cannot pull someone into
your family by username; a username-add creates a `pending` row the invitee
accepts or declines. Joining by invite *code* stays instant, because typing the
code is itself consent.

**Family invite links are a VFS handoff, not a URL param (shell `0.42.0`,
app `0.25.0`).** Research found **no** channel that passes a runtime URL param
into a sandboxed app, and a direct-to-apphost link has no kernel, therefore no
token, therefore no auth. The VFS is the one app-readable cross-origin channel
and Recipes already holds `vfs.read`/`vfs.write` — so the shell writes
`.family-invite.json` and asks the kernel to launch the app. Additive, and a
no-op when the param is absent, so it never touches the security-sensitive
`Sandbox.load`.

**The USDA key is server-side, and the proxy URL is runtime-resolved.** A store
app ships one artifact for every environment, so there is no build-time env to
bake a key into — and the de-Vited app's dev-proxy fallback would otherwise have
made a **prod** install hammer the dev project's USDA quota.

---

## recipes-open-questions

id: `recipes-open-questions`
title: Open questions and known-stale documentation

---

Recorded so the next person doesn't have to rediscover them.

**Open issues.**

- **#48 — catalog titles/descriptions (`legal`, `blocker`, open).** The gate for
  calling the catalog licensing-clean. See `recipes-catalog-licensing`.
- **#76 — `CLAUDE.md`'s manual build gate (`docs`, `dx`, open).** Includes
  re-checking the `.json` caveat and fixing the `@conjureos/pack` pin skew
  (`^0.1.1` here vs `^0.2.0` in ConjureOS's publish CLI). See
  `recipes-build-check-supersession`.

**Unverified facts, flagged rather than guessed.**

- The provenance of the live catalog rows beyond the 1,170 that were rewritten
  and seeded (prod was ~3,170 at `0.30.0`) is not recorded anywhere in this
  repo.
- Whether live catalog rows carry `summary` text is unchecked; the current
  build/seed scripts never write that column.

**Stale docs and comments to fix when touched.**

- `docs/how-it-works.md` — describes Vite (`build` + `build:inline`), markdown
  recipe files, ZIP-import deployment, `VITE_USDA_API_KEY`, and "no user login".
  All four are wrong now.
- `CLAUDE.md` — the publish gate (#76) and the pack pin.
- `README.md` — still describes the bundled catalog as an "instant, offline
  fallback"; it was deleted in `0.30.0`.
- `src/bridge/vfs.ts:7` — comment says the app writes recipes to
  `/home/Documents/Recipes/<slug>.md`; it no longer does.
- `src/features/favorites.ts:4` — comment says saved recipes carry their
  favorite flag "in their own markdown frontmatter"; it is a DB column.
- `scripts/rewrite-catalog.ts`, `scripts/gen-seed-sql.ts`,
  `scripts/recategorize-catalog.ts` — all import the deleted
  `src/data/catalog`, so they cannot run as-is.

# Recipes

**A recipe library you add to, browse and cook from.**

Write a recipe, photograph one off a card or a cookbook page, or describe a dish
and have the model write it — then cook it step by step with the ingredients and
the steps ticked off as you go.

> **This app used to carry a pantry.** For a while it was going to *become*
> Conjure Pantry — a pantry app that happens to know recipes. That is reversed:
> of 42 designed screens only six were ever about recipes, so the pantry, the
> week planner, the shopping list, the grocery-store aisle layouts and the
> shared families all moved to [**Conjure Pantry**](https://github.com/Jonny-B/conjureos-pantry),
> a separate app with its own repo and store slug. The two share nothing — not a
> table, not an edge function, not a VFS path.

> **The store slug is `recipes` and the VFS path is `/home/Documents/Recipes/`.**
> Neither can change: the slug is the dedupe key for every installed copy, and
> the path holds every saved recipe on every device.

An anchor app for [ConjureOS](https://github.com/Jonny-B/ConjureOS). A pure
React + TypeScript source project (no Vite). Developed locally with
`conj-pack dev` and **published to the ConjureOS App Store from CI**, where it is
built by ConjureOS `@bundle`: the exact same pipeline a user-published app goes
through. It is a **sealed** app (`conjureos.appType`, ConjureOS Phase 62): the
AI changes nothing in it.

## The app

**One screen.** The library, with a segmented switch across the top for All /
My recipes / Favorites, a search box, a category rail (on All) and a "+".

- **Tonight's pick** heads the library when you are browsing rather than
  searching — one suggestion, scored on your favourites, how quick a recipe is,
  and what you have not cooked lately, with a daily seed so it changes (and a
  shuffle). It shows only on All with no query and no category picked: a
  suggestion is help when you are browsing and an obstacle when you already know
  what you want. Chef Payson's newest recipe sits beside it.
- **Three ways to add a recipe**, all behind the "+": write it (the model
  structures free text into the schema, then every line is editable by hand),
  snap a photo of a recipe card or cookbook page, or describe a dish and have
  three written for you.
- **The guided cook** opens as an overlay, not a tab, so Back leaves the library
  exactly as you left it — including a search three screens deep. A cook you walk
  away from is remembered on that device (localStorage) for 12 hours and offered
  back at the top of the library.

**Studio** (chef authoring; chef and admin roles) and **Admin** (admin role)
appear as extra tabs, and the tab bar only exists when a role has earned one —
for everyone else the library is the whole app. **Appearance** and **Recipe
terms** live behind the header cog.

### Where the AI is

The design rule is that **AI is the verb inside the app, never a tab**, and
**every AI output is editable in place** — because AI that cannot be corrected
reads as a gimmick the first time it is wrong.

| Surface | Where |
|---|---|
| Snap a recipe from a photo | `screens/SnapRecipeScreen.tsx` |
| Write a recipe from free text | `features/customRecipe.ts`, `screens/CreateScreen.tsx` |
| Describe a dish → three recipes | `features/recipes.ts`, `screens/DescribeScreen.tsx` |
| Recipe photo: enhance a real one, or generate one | `features/aiPhoto.ts`, `hooks/usePhotoActions.tsx` |
| Mid-cook Q&A | `screens/ChefChat.tsx` |

### How other apps reach this one

`listRecipes`, `searchRecipes` and `getRecipe` are more than a convenience API:
they are what **Conjure Pantry** discovers. Pantry declares the SHAPE it wants
and the ConjureOS kernel matches it STRUCTURALLY against the `returns` schemas
in this app's manifest — no app names, no allow-list, no coordination between
the two.

The consequence worth knowing: **changing one of those `returns` schemas can
silently disconnect Pantry.** The matcher fails closed, so nothing errors
anywhere; Pantry simply reports that nothing can suggest meals. Treat them as a
published contract. See the header of `src/bridge/actions.ts`.

Your **saved recipes** live in your ConjureOS account rather than on-device: a
Supabase table (the `recipes-db` backend), keyed to your user and reached through
a minted identity token, so they follow you across devices (a saved recipe's
favourite flag is a column on its row). Your **catalog-favourites index**
(`.favorites.json`) and **blocked list** (`.blocked.json`) live in the VFS under
`/home/Documents/Recipes/`, browseable in ConjureOS's Files app. Markdown recipes
that older versions saved there are imported into your account once, and the
files are left in place.

## Recipe catalog

The catalog is 1,240 recipes of US federal government content, public domain: **USDA MyPlate**, 1,120 of them (`provenance='usda-myplate'`), plus 120 from the National Heart, Lung, and Blood Institute's "Keep the Beat" cookbooks (NIH; `provenance='nhlbi'`, added in 0.58.0). They live in the `recipes` table and are fetched from `recipes-db` at runtime, paged. The catalog is **not** bundled: 0.30.0 stopped shipping it on devices.

**Photos** are shown only where the source is federal: the 198 MyPlate recipes whose page credits USDA, HHS or one of its institutes (`scripts/usda-photo-census.py` decides, `scripts/usda-photos.json` is the list, `scripts/import-usda-photos.mjs` uploads it), and the NHLBI recipes whose cookbook photo could be paired with them (48 of the 120). Everything else keeps its category plate. A photo's credit (`recipes.image_credit`, "Photo: USDA MyPlate" or "Photo: Ben Fink Photography / NHLBI") is drawn in the picture's top-right corner on Tonight's pick and the open recipe, the corner an AI image's stamp uses. Never widen the list to a partner-credited photo without the partner's permission.

> **The scraped AllRecipes corpus is gone** (2026-09-17): 3,170 rows deleted from prod, 3,169 from dev. Do not regenerate it. `scripts/build-catalog.ts` and `scripts/rewrite-catalog.ts` remain in the repo as history and still point at the old cached dump under `scripts/.cache/`; running either would reintroduce exactly the content that was deliberately removed, and the licensing question that came with it. Reasoning in ConjureOS `DECISIONS.md` (2026-09-17). No licensing review is needed before a prod publish any more — that gate existed solely for the scraped corpus.

## Permissions

Declared in `package.json` under `conjureos.permissions`:

- `ai.complete`: reading a recipe off a photo, structuring typed text into a recipe, writing three from a description, the proofread pass, and Ask the chef
- `ai.image`: a recipe photo, either generated from scratch (`ai.image.generate`)
  or a real photo retouched (`ai.image.edit`, ConjureOS 0.141+). Both are billed
  to the person who asks, and the result is marked "AI-generated" or
  "AI-enhanced" in the pixels before upload
- `vfs.read`: the catalog-favourites index, the blocked list, the nutrition cache, the old markdown recipes the one-time import lifts, and the image ConjureOS just generated
- `vfs.write`: the favourites index, the blocked list and the nutrition cache, plus the import's done-flag

## Roles, moderation and terms

The server is the authority on all of it: `recipes-db` derives the caller's role (`user`, `chef`, `admin`) from the minted identity token, and every write re-checks it. The app only decides what to reveal (Studio for chef and admin, Admin for admin).

- **Admin → Users** searches the people who have opened Recipes (paged), sets roles, and bans or unbans. **Admin → Recipes** lists every user-added recipe, private ones included, with delete, remove photo and generate an AI photo. Admins cannot be banned (demote first).
- **A ban is Recipes-only.** The ConjureOS account and every other app are untouched. While banned, `recipes-db` refuses everything but `myRole` and the app shows a notice instead of itself.
- **Terms** (`src/features/terms.ts`, `TERMS_VERSION`): you keep ownership of what you add and grant ConjureOS LLC a broad licence that ends when you delete the content or your account. The app asks before the first save, upload or AI photo; `recipes-db` refuses `add`, `update`, `chefUpsert` and `uploadImage` until some version is accepted, and the app asks again when `TERMS_VERSION` moves. The text is readable any time from the cog.
- **Recipe photos** all go through one hook, `hooks/usePhotoActions.tsx`, in the editor, on the open recipe and in Admin → Recipes: upload as is, **upload & enhance with AI** / **enhance this photo** (`ai.image.edit`, ConjureOS 0.141+), or **generate with AI** (`ai.image.generate`). Both AI paths are desktop only today, billed to whoever asks at the `high` option (the editor's picker quotes the price first, enhance as "up to N credits"), and stamped "AI-enhanced" / "AI-generated" into the pixels before upload. The terms are checked before any credits are spent. The original of an enhanced photo stays one tap away ("Use my original").

## Nutrition data (USDA FoodData Central)

Each generated recipe gets a per-serving macros strip (`~520 cal · 32g P · 18g F · 48g C · est.`) from the [USDA FoodData Central API](https://fdc.nal.usda.gov/api-guide.html). Ingredient quantities are parsed locally, looked up against FDC's `Foundation` + `SR Legacy` datasets, and aggregated. Cached to the app's VFS folder so repeat ingredients (eggs, olive oil, garlic) only hit the network once per user, ever.

**The USDA key is never in the client bundle.** Lookups route through a server-side `usda-proxy` Supabase Edge Function that holds `USDA_API_KEY` as a server secret and relays the request. The app resolves the proxy URL **at runtime** — `globalThis.__conjureos?.env?.usdaProxyUrl`, injected by ConjureOS — so there's no build-time key and no `VITE_*` env to set. Outside ConjureOS (e.g. `conj-pack dev`) the resolver falls back to a dev proxy and the strip degrades gracefully if none is reachable.

Accuracy is ~±25-40% on totals — fine for "should I cook this?" but not medical-grade. The strip displays `rough` instead of `est.` when fewer than 70% of ingredients matched.

## Development

```bash
npm install
npm run dev          # conj-pack dev: esbuild dev server (no Vite), live reload
npm run build        # the REAL store bundle (ConjureOS @bundle) -> dist/recipes.html
npm run typecheck    # tsc -b --noEmit
npm test             # theme, catalog paging, pack pin, app type (plain tsx, no framework)
```

`npm run dev` is a fast esbuild dev server. It serves and live-reloads your source; it does **not** stand up any part of the ConjureOS bridge — there is no injected shim, so `ai.complete`, `actions.*`, `auth.whoami`, `notify` and the VFS are absent locally (ConjureOS #722). The app's own wrappers (`src/bridge/ai.ts`, `vfs.ts`, `whoami.ts`, and the role and upload calls in `recipesApi.ts`) fall back to in-app stand-ins when the host is missing — canned AI JSON, an in-memory VFS, a pretend admin — so the UI stays iterable; that is the app's code, not `conj-pack`, and it proves nothing about the real bridge. Dev is also **not** the same pipeline as the store build, so code can pass in dev and still break on import.

The gate for this repo is **`npm run build` succeeds and CI is green** — not "`conj-pack` passes", since this repo calls `bundle()` directly and never invokes the CLI.

1. `npm run build` runs the same `@conjureos/pack` `bundle()` that CI's `@bundle` uses, writing `dist/recipes.html`. It throws and exits non-zero on a real build error.
2. **Optional runtime sanity check:** serve `dist/` (any static server) and open `dist/recipes.html` in a browser, and confirm it renders with a clean console. A clean build proves the app *bundles*; it does not prove the app *works*. The bridge is absent here too, so this is not a test of platform behavior.

Keep `@conjureos/pack` on the `0.4.x` line CI uses. See CLAUDE.md for why bumping to npm `latest` would *recreate* the local-vs-store skew rather than fix it. `npm run check:pack-pin` enforces it.

Bump `version` in **both** `package.json` and `src/version.ts` together (the in-app footer reads the latter, and CI fails the publish if they disagree).

## Publishing to the ConjureOS App Store (CI)

There is no manual ZIP-import step. CI builds this source with ConjureOS `@bundle` and publishes a new store version:

- **Dev:** Actions → "Publish to ConjureOS App Store" → Run workflow (`workflow_dispatch`).
- **Prod:** publish a GitHub Release (the release notes become the changelog).

Installed users see the new version as an update. Full mechanics, secrets, and the one-time bootstrap are in [`ANCHOR_APP_CI_SETUP.md`](https://github.com/Jonny-B/ConjureOS/blob/dev/ANCHOR_APP_CI_SETUP.md) in the ConjureOS repo. Author + repository fields from `package.json` surface on the installed app's manifest.

## Cross-app integration

The app registers eighteen actions via ConjureOS's [action bridge](https://github.com/Jonny-B/ConjureOS) so other installed apps (calorie trackers, meal planners, shopping lists, the Chat orchestrator) can use the recipe library. Each is declared in `package.json` → `conjureos.actions` with a JSON schema for its params and its result, and implemented in `src/bridge/actions.ts`.

**The user's library** (saved recipes; `slug` is the id `listRecipes` returns)

| Action | Scope | What it does |
|---|---|---|
| `listRecipes({ filter?, limit?, favoritesOnly?, cookedSince? })` | read | Saved recipes. `filter` is a title/summary/ingredient substring; `cookedSince` (ISO date) keeps the ones last cooked on or after it, newest first |
| `getRecipe({ slug })` | read | One saved recipe in full: ingredients, instructions, nutrition |
| `scaleSavedRecipe({ slug, servings })` | read | A saved recipe rescaled; the stored copy is untouched |
| `addRecipe({ recipe })` | write | Save a recipe |
| `importRecipeFromImage({ images })` | write | Transcribe a photographed recipe and save it (no review step) |
| `markCooked({ slug })` | write | Bump the made-counter and `lastMadeAt`; returns `previousLastMadeAt` for an exact undo |
| `unmarkCooked({ slug, previousLastMadeAt? })` | write | Undo one `markCooked` |
| `setFavorite({ slug, favorite })` | write | Mark or unmark a favourite |

**The catalog** (1,240 recipes: 1,120 MyPlate + 120 NHLBI; chef posts are not in it, `listChefPicks` has those; `id` is the id `searchRecipes` returns)

| Action | Scope | What it does |
|---|---|---|
| `searchRecipes({ query?, category?, limit? })` | read | Search the catalog. `ingredients` are canonical names ("chicken breasts"), not lines |
| `getCatalogRecipe({ id })` | read | One catalog recipe in full: ingredient lines, instructions, nutrition, photo and its credit |
| `listCategories()` | read | The category taxonomy with counts |
| `listChefPicks({ limit? })` | read | The featured chef recipes, newest first |
| `getSharedRecipe({ shareToken })` | read | A recipe from a share link (public or unlisted only) |
| `setBlocked({ id, blocked })` / `getBlocked()` | write / read | Stop (or resume) a catalog recipe being suggested; it stays searchable |

**Recipe tools** (pure: they read and write nothing of the user's)

| Action | Scope | What it does |
|---|---|---|
| `parseIngredients({ lines })` | read | Each line split into `quantity`, `unit`, `name` and a rough `grams`; anything a line doesn't state is null |
| `estimateNutrition({ ingredients, servings? })` | read | Per-serving calories/protein/fat/carbs by USDA lookup, the estimate this app shows. `rateLimited: true` means retry later |
| `scaleRecipe({ slug \| id \| recipe, servings })` | read | Rescale a saved recipe, a catalog recipe, or lines you pass in. Never saves |

Reads (`actions.read`) are side-effect-free, but they are gated too: ConjureOS asks the first time another installed app calls any action here, read or write (the dialog says which kind, e.g. "see your recipes" or "add a recipe"), and the user picks Don't allow / Allow once / Always allow per caller app, per action (`ConjureOS src/kernel/actionRegistry.ts`, Phase 30b). The orchestrator (Chat) is trusted shell code and is not prompted, which is why deleting a recipe, publishing one, and every admin function are deliberately **not** actions (see the header of `src/bridge/actions.ts`).

Every param is validated strictly (types, lengths, id formats); a bad one is rejected with a message, never repaired into a different request. A read that can't reach the backend fails rather than answering empty, because "no recipes" and "couldn't look" lead a caller to different decisions.

`listRecipes`, `searchRecipes` and `getRecipe` are Conjure Pantry's contract (see [How other apps reach this one](#how-other-apps-reach-this-one)); `getCatalogRecipe` and `getSharedRecipe` also satisfy its `recipe` shape. Check `conjureos-pantry/scripts/needs.test.ts` before changing any `returns` schema.

## Security posture

This app accepts untrusted input from three sources:

1. **Photos** (vision call) — Snap-a-recipe and `importRecipeFromImage` read text out of an image, and an adversarial image could try to redirect the model.
2. **Typed text** — a pasted recipe, a described dish, the proofread pass and Ask the chef all put user text into a prompt.
3. **Cross-app action params** — another installed app could pass malicious payloads to any action (`addRecipe`, `markCooked`, `scaleRecipe`, …).

Mitigations layered defensively:

- **The user sees a recipe before it is saved.** Snap-a-recipe and Write-it land on the editable preview, and Describe-a-dish shows three cards, so a recipe a hostile image or prompt produced is read by a person first. The exception is `importRecipeFromImage`, which saves directly because a bridge call has no UI for a preview: the caller holds `actions.write` (a per-app grant for another app; the orchestrator, which is how a photo attached in Chat arrives, is trusted shell code), the recipe is private, and the user can see and delete it.
- **Every prompt tells the model the input is data.** The vision prompt says text in a photo is content to transcribe, not instructions, and returns an empty recipe for a photo with none. Typed input rides in `<user_request>`, `<user_recipe>` or `<recipe_json>` delimiters with the same guidance, and the proofread pass drops lines that are not food.
- **Strict-JSON parsing** on every AI response: shape validation, defaults for bad difficulty, time and servings, and a recipe with no ingredients or no steps is rejected.
- **Action params** are validated field-by-field before reaching the handler (`src/bridge/actions.ts`): type, length cap, control characters stripped, slugs and ids rejected rather than repaired, numbers range-checked. A bad param is an error, never a different request.
- **Markdown parsing** of the old VFS recipe files (the one-time import) caps file size (64 KB), frontmatter lines (40), field length (1000 chars) and body items (60 ingredients / 60 steps); a malformed file is skipped.
- **A recipe's source link** is rendered as a link only if it is `http:` or `https:` (`features/safeUrl.ts`); anything else shows as text.
- **Photo enhance is told to keep the food.** The edit prompt forbids adding, removing or changing any food, and the un-enhanced original is always kept one tap away ("Use my original"), because an edit model can change the dish.
- **No `dangerouslySetInnerHTML`** anywhere — React's default JSX escaping handles every render path.

The full threat model is reviewed against the OWASP LLM Top 10 — main residual risks are LLM06 (sensitive info disclosure via the model itself, mitigated by showing the recipe to the user before it is saved) and LLM03 (training data poisoning, out of scope for an inference-only client).

## License

MIT — see [LICENSE](LICENSE).

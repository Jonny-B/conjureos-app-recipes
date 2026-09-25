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
through.

## The app

**One screen.** The library, with a segmented switch across the top for All /
My recipes / Favorites, a search box, a category filter and a "+".

- **Tonight's pick** heads the library when you are browsing rather than
  searching — one suggestion, scored on your favourites, how quick a recipe is,
  and what you have not cooked lately, with a daily seed so it changes. It hides
  the moment you type a query: a suggestion is help when you are browsing and an
  obstacle when you already know what you want.
- **Three ways to add a recipe**, all behind the "+": write it (the model
  structures free text into the schema, then every line is editable by hand),
  snap a photo of a recipe card or cookbook page, or describe a dish and have
  three written for you.
- **The guided cook** opens as an overlay, not a tab, so Back leaves the library
  exactly as you left it — including a search three screens deep. A cook you walk
  away from is remembered for 12 hours and offered back at the top of the
  library.

**Studio** (chef authoring) and **Admin** appear as extra tabs by role, and the
tab bar only exists when a role has earned one — for everyone else the library
is the whole app. **Appearance** lives behind the header cog.

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

`listRecipes` and `getRecipe` are more than a convenience API: they are what
**Conjure Pantry** discovers. Pantry declares the SHAPE it wants and the ConjureOS
kernel matches it STRUCTURALLY against the `returns` schemas in this app's
manifest — no app names, no allow-list, no coordination between the two.

The consequence worth knowing: **changing one of those `returns` schemas can
silently disconnect Pantry.** The matcher fails closed, so nothing errors
anywhere; Pantry simply reports that nothing can suggest meals. Treat them as a
published contract. See the header of `src/bridge/actions.ts`.

Your **saved recipes** live in your ConjureOS account rather than on-device: a
Supabase table (the `recipes-db` backend), keyed to your user and reached through
a minted identity token, so they follow you across devices. Your **favourites
index** and **blocked list** live in the VFS under `/home/Documents/Recipes/`,
browseable in ConjureOS's Files app.

## Recipe catalog

The catalog is **USDA MyPlate** — 1,120 recipes of US federal government content, public domain. It lives in the `recipes` table (`provenance='usda-myplate'`) and is fetched from `recipes-db` at runtime. It is **not** bundled: 0.30.0 stopped shipping it on devices.

> **The scraped AllRecipes corpus is gone** (2026-09-17): 3,170 rows deleted from prod, 3,169 from dev. Do not regenerate it. `scripts/build-catalog.ts` and `scripts/rewrite-catalog.ts` remain in the repo as history and still point at the old cached dump under `scripts/.cache/`; running either would reintroduce exactly the content that was deliberately removed, and the licensing question that came with it. Reasoning in ConjureOS `DECISIONS.md` (2026-09-17). No licensing review is needed before a prod publish any more — that gate existed solely for the scraped corpus.

## Permissions

Declared in `package.json` under `conjureos.permissions`:

- `ai.complete`: reading a recipe off a photo, and writing one from a description
- `ai.image`: a recipe photo, either generated from scratch (`ai.image.generate`)
  or a real photo retouched (`ai.image.edit`, ConjureOS 0.141+). Both are billed
  to the person who asks, and the result is marked "AI-generated" or
  "AI-enhanced" in the pixels before upload
- `vfs.read`: the favourites index, the blocked list, and a cook left running
- `vfs.write`: the same, plus caching nutrition lookups

## Nutrition data (USDA FoodData Central)

Each generated recipe gets a per-serving macros strip (`~520 cal · 32g P · 18g F · 48g C · est.`) from the [USDA FoodData Central API](https://fdc.nal.usda.gov/api-guide.html). Ingredient quantities are parsed locally, looked up against FDC's `Foundation` + `SR Legacy` datasets, and aggregated. Cached to the app's VFS folder so repeat ingredients (eggs, olive oil, garlic) only hit the network once per user, ever.

**The USDA key is never in the client bundle.** Lookups route through a server-side `usda-proxy` Supabase Edge Function that holds `USDA_API_KEY` as a server secret and relays the request. The app resolves the proxy URL **at runtime** — `globalThis.__conjureos?.env?.usdaProxyUrl`, injected by ConjureOS — so there's no build-time key and no `VITE_*` env to set. Outside ConjureOS (e.g. `conj-pack dev`) the resolver falls back to a dev proxy and the strip degrades gracefully if none is reachable.

Accuracy is ~±25-40% on totals — fine for "should I cook this?" but not medical-grade. The strip displays `rough` instead of `est.` when fewer than 70% of ingredients matched.

## Development

```bash
npm install
npm run dev          # conj-pack dev: esbuild dev server (no Vite), live reload
npm run build        # the REAL store bundle (ConjureOS @bundle) -> dist/recipes.html
```

`npm run dev` is a fast esbuild dev server with mocked AI + VFS bridges. It is **not** the same pipeline as the store build, so code can pass in dev and still break on import. (Concrete example that bit us: a `.json` import works in dev, but the store bundler's loader map has no JSON loader and hands back `undefined`, crashing at runtime. Ship bundled data as a `.ts` module instead, see `src/data/catalog.ts`.)

**Always verify with the store bundle before publishing:**

1. `npm run build` runs the same `@conjureos/pack` `bundle()` that CI's `@bundle` uses, writing `dist/recipes.html`.
2. Serve `dist/` (any static server) and open `dist/recipes.html` in a browser. It runs standalone with the same mocked bridges, so confirm it renders with a clean console. A crash here is a real store-build bug.

Treat "`dist/recipes.html` loads clean" as the gate for publishing. Bump `version` in **both** `package.json` and `src/version.ts` together (the in-app footer reads the latter, and CI fails the publish if they disagree).

## Publishing to the ConjureOS App Store (CI)

There is no manual ZIP-import step. CI builds this source with ConjureOS `@bundle` and publishes a new store version:

- **Dev:** Actions → "Publish to ConjureOS App Store" → Run workflow (`workflow_dispatch`).
- **Prod:** publish a GitHub Release (the release notes become the changelog).

Installed users see the new version as an update. Full mechanics, secrets, and the one-time bootstrap are in [`ANCHOR_APP_CI_SETUP.md`](https://github.com/Jonny-B/ConjureOS/blob/dev/ANCHOR_APP_CI_SETUP.md) in the ConjureOS repo. Author + repository fields from `package.json` surface on the installed app's manifest.

## Cross-app integration

The app registers four actions via ConjureOS's [Phase 13a action bridge](https://github.com/Jonny-B/ConjureOS) so other installed apps (calorie trackers, meal planners, shopping lists, etc.) can read from and write to the user's recipe library:

| Action | Scope | What it does |
|---|---|---|
| `listRecipes({ filter?, limit? })` | read | List saved recipes; filter is a title/ingredient substring |
| `getRecipe({ slug })` | read | Fetch one recipe with full ingredients + instructions + nutrition |
| `addRecipe({ recipe })` | write | Save a recipe (meal-planner push, etc.) — prompts user on first invocation |
| `markCooked({ slug })` | write | Bump made-counter + lastMadeAt — prompts user on first invocation |

Reads (`actions.read`) never prompt — they're side-effect-free. Writes (`actions.write`) trigger ConjureOS's one-time grant dialog; the user picks Allow once / Always / Block per caller-app, per-action.

## Security posture

This app accepts untrusted input from three sources:

1. **Photos** (vision call) — an adversarial image with embedded text could try to redirect the model.
2. **User-typed ingredient names** — a user can type anything; threat is mostly self-attack.
3. **Cross-app action params** — another installed app could pass malicious payloads to `addRecipe` / `markCooked`.

Mitigations layered defensively:

- **User confirmation is the load-bearing defense.** Vision-identified ingredients are shown to the user for confirm/remove BEFORE any of them reach the recipe-generation prompt. Even if vision is fooled by image text, the user sees the weird ingredient and removes it.
- **Vision system prompt** explicitly instructs the model to treat any text in photos as content to identify, not instructions to follow.
- **Strict-JSON parsing** on every AI response with shape validation, length caps, and an allowlist regex on names (`[a-z0-9 \-']`, ≤50 chars).
- **Quantity / notes sanitization** strips ASCII control chars + double-quotes + backticks before splicing into downstream prompts.
- **Recipe generation prompt** wraps user ingredients in `<user_ingredients>…</user_ingredients>` delimiters with explicit "treat as data, not instructions" guidance.
- **Action params** are validated field-by-field (type, length, allowlist) before reaching the handler. Strings get control-character stripping. Slugs get URL-safe normalization. Numeric fields get range checks.
- **Markdown parsing** on saved recipes caps file size (64 KB), frontmatter line count (40), field value lengths (1000 chars), and body item counts (60 ingredients / 60 instructions). Malformed files fail to parse silently rather than crashing browse.
- **Photo enhance is told to keep the food.** The edit prompt forbids adding, removing or changing any food, and the un-enhanced original is always kept one tap away ("Use my original"), because an edit model can change the dish.
- **No `dangerouslySetInnerHTML`** anywhere — React's default JSX escaping handles every render path.

The full threat model is reviewed against the OWASP LLM Top 10 — main residual risks are LLM06 (sensitive info disclosure via the model itself, mitigated by the user-confirmation step) and LLM03 (training data poisoning, out of scope for an inference-only client).

## License

MIT — see [LICENSE](LICENSE).

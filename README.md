# Conjure Pantry

**A pantry app that happens to know recipes.** The promise is to use up what you already have.

Two mechanics carry it. **Scan your shelves and fridge** — a camera pass turns a shelf into a stocked ingredient list, so the app knows what you own without you typing it. **Plan a week that maximises what you use up while staying varied** — not eight recipes that each want tomatoes, but six different dinners that between them finish the tomatoes, the half bag of spinach and the rice.

Around those: plan the week with your family, share the plan by link, and shop from a list ordered by your own store's aisles.

> **The store slug is still `recipes`, on purpose.** It is the dedupe key for every installed copy, so changing it would put a second app on every device instead of updating the one that is there. Slug is plumbing; nobody sees it.

The first Phase 12a anchor app for [ConjureOS](https://github.com/Jonny-B/ConjureOS). A pure React + TypeScript source project (no Vite). Developed locally with `conj-pack dev` and **published to the ConjureOS App Store from CI**, where it's built by ConjureOS `@bundle`: the exact same pipeline a user-published app goes through.

## The app

Four tabs, opening on **Pantry**:

- **Pantry** — home. What you own, and how it got there: scan a shelf or your fridge and a vision pass turns it into a stocked ingredient list you review and correct before anything is saved. Add by hand too. Everything else in the app ranks against this list.
- **Plan** — the week, shared with your family. Say what you're in the mood for (pick ingredients, start from a recipe, or just describe it) and the planner picks a week of meals chosen to use up what you have without cooking the same dish twice, then consolidates one shopping list where shared ingredients are bought once. Family plans sync live over Realtime.
- **List** — the shopping list, grouped by aisle in the order you actually walk your store. Big check-off targets for one-handed use in a shop; ticks sync to the family as ops, not blob writes, so two people shopping together don't erase each other. Printable.
- **Recipes** — the library, not the landing page. 1,120 USDA MyPlate recipes plus whatever you've saved or written, every row showing how much of it your pantry already covers. Three ways to add one, all behind the "+": write it, snap a photo of it, or describe a dish and let the model write it.

**Studio** (chef authoring) and **Admin** appear as extra tabs by role. **Family**, **Grocery stores** and **Appearance** live behind the header cog — they are set once. The guided cook is not a tab: it opens as an overlay over whatever tab you were on, so Back leaves that screen exactly as you left it.

### Where the AI is

Seven AI surfaces, none of them a button with a sparkle on it. The design rule is that **AI is the verb inside each pillar, never a tab**: you point the camera and the shelf becomes a list; you type "busy week, two vegetarian nights" and the week fills in; the list sorts itself into your store's order. And **every AI output is editable in place** — a scan you can correct, a plan you can nudge, an aisle you can move — because AI that can't be corrected reads as a gimmick the first time it is wrong.

| Surface | Where |
|---|---|
| Pantry / fridge scan | `features/vision.ts` → Pantry |
| Snap a recipe from a photo | `screens/SnapRecipeScreen.tsx` |
| Describe a dish → recipe | `features/customRecipe.ts`, `screens/DescribeScreen.tsx` |
| Invent recipes from the pantry | `features/recipes.ts` |
| Mood → week plan | `features/planWeek.ts` |
| Aisle placement inference | `features/aiStoreSort.ts` (silent, learned per store) |
| Mid-cook Q&A | `screens/ChefChat.tsx` |

Your **saved recipes** persist in your ConjureOS account, not on-device: they live in a Supabase table (the `recipes-db` backend), keyed to your user and reached through a minted identity token, so they follow you across devices. Your **pantry**, **favorites index**, **store layouts** and legacy **week plans** live in the VFS under `/home/Documents/Recipes/`, browseable in ConjureOS's Files app. (That path is deliberately still named `Recipes`: moving it would orphan every saved file on every device.)

## Recipe catalog

The catalog is **USDA MyPlate** — 1,120 recipes of US federal government content, public domain. It lives in the `recipes` table (`provenance='usda-myplate'`) and is fetched from `recipes-db` at runtime. It is **not** bundled: 0.30.0 stopped shipping it on devices.

> **The scraped AllRecipes corpus is gone** (2026-09-17): 3,170 rows deleted from prod, 3,169 from dev. Do not regenerate it. `scripts/build-catalog.ts` and `scripts/rewrite-catalog.ts` remain in the repo as history and still point at the old cached dump under `scripts/.cache/`; running either would reintroduce exactly the content that was deliberately removed, and the licensing question that came with it. Reasoning in ConjureOS `DECISIONS.md` (2026-09-17). No licensing review is needed before a prod publish any more — that gate existed solely for the scraped corpus.

## Permissions

Declared in `package.json` under `conjureos.permissions`:

- `ai.complete`: multimodal vision, recipe generation, and mood interpretation
- `vfs.read`: list saved recipes, pantry, favorites, and week plans
- `vfs.write`: save recipes, pantry, favorites, plans, and cache nutrition lookups

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
- **No `dangerouslySetInnerHTML`** anywhere — React's default JSX escaping handles every render path.

The full threat model is reviewed against the OWASP LLM Top 10 — main residual risks are LLM06 (sensitive info disclosure via the model itself, mitigated by the user-confirmation step) and LLM03 (training data poisoning, out of scope for an inference-only client).

## License

MIT — see [LICENSE](LICENSE).

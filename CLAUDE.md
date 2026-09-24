# Recipes: instructions for Claude

A ConjureOS anchor app (separate repo from ConjureOS). Pure React + TypeScript, no Vite.

**It is a recipe library, full stop.** You add recipes to it — by writing them,
photographing them, or describing a dish — you browse them, and you cook them
step by step. That is the whole app.

## What used to be here and is not

This app briefly carried a pantry, a week planner, a shopping list,
grocery-store aisle layouts and shared families, and was going to be renamed
**Conjure Pantry**. That is reversed. Of 42 designed screens only six were ever
about recipes, so all of it moved to
[`conjureos-pantry`](https://github.com/Jonny-B/conjureos-pantry) — its own repo,
its own store slug (`pantry`), its own VFS path.

**The two apps share NOTHING.** Not a table, not an edge function, not a VFS
path. Do not add a pantry, a week planner or a shopping list back here. If a
recipe screen wants to know what the user has in, the answer is to ask Conjure
Pantry through the action bridge, never to grow a second copy of it.

| Thing | Value | Changeable? |
|---|---|---|
| Store slug | `recipes` | **No.** It is the dedupe key for every installed copy. |
| VFS path | `/home/Documents/Recipes/` | **No.** It holds saved files on every device. |
| Display name | `Recipes` | It was briefly "Conjure Pantry". Two apps with that name is the worst outcome of the split. |
| Backend | `recipes-db` (in the ConjureOS repo) | Pantry must never read it, and this app must never read Pantry's. |

## Conjure Pantry discovers this app, and a schema change can break it silently

`listRecipes`, `searchRecipes` and `getRecipe` are a published contract, not
just a convenience API. Pantry declares the SHAPE it wants (`manifest.needs`)
and the ConjureOS kernel matches it **structurally** against the `returns`
schemas in this app's `package.json` — no app names, no allow-list, nothing
coordinated between the two authors. Today `listRecipes` (the saved library)
and `searchRecipes` (the catalog) both satisfy Pantry's `recipeSearch` need,
and `getRecipe` satisfies `recipe`.

`searchRecipes` only matches because its results carry `ingredients` (the
catalog's canonical tokens) and declare them `required`. Without that, Pantry
could plan only from the handful of recipes a user has saved; with an empty
library it planned nothing at all (ConjureOS #915).

`schemaSatisfies` **fails closed**. So dropping a field from either list
action's `required` array, or narrowing a type, disconnects Pantry with **no
error anywhere** — it just reports that nothing can suggest meals, and plans
nothing. Nothing in this repo's tests will fail. Before touching any of the
three schemas, run
`conjureos-pantry/scripts/needs.test.ts`, which checks this app's real shapes
against Pantry's declared needs using the kernel's own matcher.

## Before publishing: build the REAL store bundle and smoke-test it

`npm run dev` (conj-pack dev) is a fast esbuild dev server with mocked bridges.
It is NOT the pipeline the App Store uses, so code can pass in dev and still
crash on import. The store build is `@conjureos/pack`'s `bundle()` (esbuild-wasm
+ jspm importmap), run by ConjureOS `@bundle` in CI.

Hard rule: never publish (dev or prod) without building the store bundle locally
and loading it.

1. `npm run build` produces `dist/recipes.html` via the same `bundle()` CI uses.
2. Open `dist/recipes.html` in a browser. It runs standalone with the same mocked
   bridges, so confirm it renders with a clean console. A crash here is a real
   store-build bug.

Treat "`dist/recipes.html` loads clean" as the gate for any publish.

### Known dev-vs-store differences (do not get bitten again)

- The store bundler's loader map covers tsx/ts/jsx/js/css + image/font types, but
  NOT `.json`. Do not `import x from "*.json"`; a JSON import returns `undefined`
  in the store build and works fine in dev.
- The bundler cannot resolve a `.js` extension on a TypeScript import. Relative
  imports in this repo are extensionless; keep them that way.
- Keep `@conjureos/pack` aligned with the version CI uses (ConjureOS
  `scripts/package.json` pins it).

## Appearance

Locked to the Spring palette (`spr`); the only appearance choice a user makes is
light or dark. `src/theme.ts` holds that one axis — this app's own stored flavor
choice if there is one, else whatever flavor ConjureOS is wearing, live, else
nothing (the browser's own preference decides) — and
`src/components/AppearanceSheet.tsx` is the two-button UI behind the cog. Picking
Light or Dark is a one-way door: from then on this app's own choice wins, and
clearing site data is the only way to resume following ConjureOS. The palette
itself is never a setting: `data-theme` is always written as `"spr"`, and
`theme.ts` ignores the theme field of every appearance message ConjureOS sends.

(Conjure Pantry locks BOTH axes — Spring and light — so do not copy its
`theme.ts` here, or this app loses its dark mode.)

`npm test` runs `scripts/theme.test.ts`: 19 plain-tsx cases, no framework. 18
exercise `theme.ts`; the last reads `src/conjureos-ui.css` off disk to guard the
re-sync below.

`src/conjureos-ui.css` is a VENDORED copy of `@conjureos/ui` `dist/ui.css` and
must stay at a 1.x version — 0.x had one dark palette and no light/dark axis, so
an accidental re-sync from an older build would silently break the one appearance
lever this app has. Re-sync with:

```
cp node_modules/@conjureos/ui/dist/ui.css src/conjureos-ui.css
```

That also wipes the header comment at the top of the file, which is not part of
the upstream package — put it back from git history before committing.

### The opening screen

`components/Splash.tsx` covers the app until the catalog loads (at most 6s,
`SPLASH_MAX_MS` in `App.tsx`). The art, `src/assets/splash-art.webp`, is the
owner's (2026-09-24), re-encoded to ~80 KB: the store bundle inlines images
only up to 256 KB and silently drops anything bigger from a single-HTML
publish. It is portrait, so it is never stretched to `cover` (that crops the
corner props on a wide screen): it is drawn as two height-fitted halves pinned
to the screen's edges (styles.css "Splash"). It is always Spring dark, whatever
the user picked, because the art is dark.

## Versioning

Bump `version` in BOTH `package.json` and `src/version.ts` together. CI fails the
publish if they differ; the in-app footer reads `src/version.ts`.

## Catalog

The catalog is **USDA MyPlate** — 1,120 recipes, US federal government content,
public domain. It lives in the `recipes` table (`provenance='usda-myplate'`) and
is fetched from `recipes-db` at runtime; it is NOT bundled.

**The scraped AllRecipes corpus is gone** (2026-09-17): 3,170 rows deleted from
prod, 3,169 from dev. Do not regenerate it. `scripts/build-catalog.ts` and
`scripts/rewrite-catalog.ts` remain in the repo as history and still reference
the old cached dump under `scripts/.cache/` — running either would reintroduce
exactly the content that was deliberately removed, and the licensing question
that came with it. Reasoning in ConjureOS `DECISIONS.md` (2026-09-17).

No licensing review is needed before a prod publish any more. That gate existed
solely for the scraped corpus.

**Photos: USDA-credited recipes only** (owner decision, 2026-09-23). Each
MyPlate page credits a source, and most credit a partner (a state university,
a state SNAP-Ed programme, a nonprofit, a company) who may still own the photo.
Only recipes crediting a federal source (USDA, HHS and its NIH/NCI/NHLBI/CDC/
FDA) get their photo. `scripts/usda-photo-census.py` decides and writes
`scripts/usda-photos.json`; `scripts/import-usda-photos.mjs` uploads exactly
that list to the `recipe-images` bucket and sets `image_url` (needs the
project's service-role key, run once per project). Never widen that list to
partner-credited photos without the partner's permission.

## Moderation, bans, terms and AI photos (0.56.0)

Backend half lives in ConjureOS `recipes-db` + migration `153_recipes_moderation`.

- **Admins** (role `admin`; the bootstrap emails in recipes-db are admins
  automatically) get Admin → Users (search, paged; set role; ban / unban; delete
  a user's recipes and/or images) and Admin → Recipes (every user-added recipe,
  private included; delete, remove photo, generate an AI photo). Every admin
  action is re-checked server-side.
- **A ban is Recipes-only.** It never touches the ConjureOS account. While
  banned, recipes-db refuses everything but `myRole`, and the app shows a
  notice instead of itself. Admins can't be banned (demote first).
- **Terms** (`src/features/terms.ts`): users keep ownership and grant ConjureOS
  LLC a broad licence (owner decision; the text is an unreviewed DRAFT). The app
  asks before the first save/upload/AI photo; recipes-db refuses `add`,
  `update`, `chefUpsert` and `uploadImage` until accepted. Bump `TERMS_VERSION`
  when the text changes and everyone is asked again.
- **AI photos** (`src/features/aiPhoto.ts`): ConjureOS `ai.image.generate`
  (desktop only; billed to the requesting user's credits, an admin's own for
  admin actions). "AI-generated" is **burned into the pixels** in the app before
  upload — not a CSS overlay — and uploaded with `ai: true`, which keys it
  `ai-<uuid>` so the server derives `recipes.image_ai`. The open recipe also
  shows an "AI image" pill, because the photo fade can cover the stamp there.
  Terms are checked BEFORE generating, so nobody pays for an image they can't
  save.

## Visual language

Squared-off angles, hairline borders, and nothing else carrying structure. The
rules live at the top of `src/styles.css`; the short version:

- **Every radius comes from the scale** (`--r-0/1/2/pill/circle`). No component
  picks its own curve. `--r-pill` is RATIONED to status chips and count badges:
  a pill says "this is data", structure goes square.
- **Every type size comes from the scale** (`--t-micro` … `--t-5xl`).
- **One shadow** (`--shadow-float`), and only genuinely floating layers get it:
  bottom sheets, dropdowns, popovers. Cards and rows get `--hair`.
- **One gradient** (`--grad-primary`), on one element per screen: the primary
  action. Everything else that reads as "accent" is a flat `--cui-accent`.
- **`--cui-accent-mute` / `--cui-accent-tint` are NOT the accent tokens.** They
  are deprecated aliases for the SUPPORT hue, which in Spring is pink. Use
  `--accent-line` / `--accent-wash` / `--hair-accent`, defined in this repo and
  derived from `--cui-accent`.
- The canvas is flat. A tinted background is the one thing that makes a
  10%-opacity hairline disappear.
- **Never hardcode a colour.** Spring's `--cui-on-accent` is DARK (`#0d1108`) in
  the dark flavour and white in light, so `color: #fff` on a filled button is a
  real bug in Spring dark. Use the token and check both flavours.

The **cookbook layer** (0.54.0) sits on top of that, because squares and
hairlines alone read as a 2001 directory listing:

- **A display face** (`--font-display`, a system serif stack — still no web
  fonts) for recipe titles and stat-strip figures ONLY. Everything else is sans.
- **Category hues** (`.hue-*` in `src/styles.css`, mapped per category in
  `src/features/recipeLook.ts`). Each is a `--cui-*` ROLE, never a value. A hue
  marks what kind of dish something is (plate, category word, rail chip, macro
  key) and is never decoration on anything else.
- **Every recipe surface has a picture slot**, `components/RecipePlate.tsx`: the
  recipe's photo when it has one, otherwise a flat hue-and-glyph plate in the
  same box. Don't add a second, photo-only layout.
- **The open recipe is laid out to the owner's mockup** (2026-09-23, the
  "Pumpkin Cookies" image): the recipe's picture behind the whole card, serif
  title, the app's own pills, the one-line nutrition strip, ingredients down the
  left, instructions in two columns with round step numbers. Its photo scrim and
  those round numbers are deliberate exceptions to the rules above, documented
  in `src/styles.css` ("Open recipe: the cover"). Don't redesign this screen
  without the owner.

## Publishing

Dev: Actions, "Publish to ConjureOS App Store", Run workflow (workflow_dispatch).
Prod: publish a GitHub Release. See `README.md` and ConjureOS
`ANCHOR_APP_CI_SETUP.md`.

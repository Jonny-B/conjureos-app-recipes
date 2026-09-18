# Conjure Pantry — design plan

> Written 2026-09-18 as the hand-off brief for a fresh thread. Read this plus
> `CLAUDE.md` before touching anything. Nothing here has been implemented yet;
> the app on dev/prod is still "Recipes" at `0.43.1`.

---

## 1. What we are actually building

Today the app is a recipe app with a pantry feature. The repositioning inverts
that: **it is a pantry app that happens to know recipes.**

The promise, in the owner's words, is to *use up what you already have.* Two
mechanics carry it:

1. **Scan your pantry and fridge** — a camera pass turns shelves into a stocked
   ingredient list, so the app knows what you own without typing.
2. **A planner that maximizes use of what you have while maximizing recipe
   diversity** — not "here are 8 recipes that each use tomatoes," but "here are
   6 different dinners that between them finish the tomatoes, the half bag of
   spinach, and the rice." Waste reduction is the outcome; diversity is the
   constraint that stops it being a week of the same dish.

Supporting pillars, in priority order:

3. **Plan the week with your family** — a shared plan, not a solo one.
4. **Share the plan** — a family member opens a link and sees the same week.
5. **A grocery list ordered by your store's layout** — check things off in the
   order you physically walk the aisles.

**"Not just a recipe app" has to be the first thing you see.** The current Home
screen opens on recipe rows; the redesign opens on the pantry and the week.

### AI is the *how*, not a feature list

Seven AI surfaces already exist in the codebase and every one of them is hidden
behind a generic label:

| Surface | Where | Current label |
|---|---|---|
| Pantry / fridge scan | `features/vision.ts`, `PantryScreen` | (a camera button) |
| Snap a recipe from a photo | `SnapRecipeScreen` | "Snap a recipe" |
| Describe a dish → recipe | `features/customRecipe.ts` | "Structure with AI" |
| Invent recipes from pantry | `features/recipes.ts` | (generate) |
| Mood → week plan | `features/planWeek.ts` | "Reading your mood…" |
| Aisle placement inference | `features/aiStoreSort.ts` | (silent) |
| Mid-cook Q&A | `ChefChat` | "Ask the chef" |

**Design rule: AI is the verb inside each pillar, never a tab and never a ✨
button.** You point the camera and the shelf becomes a list; you type "busy
week, two vegetarian nights" and the week fills in; the list sorts itself into
your store's order. The user should experience competence, not a robot mascot.

Corollary rule: **every AI output is editable in place.** A scan result you can
correct, a plan you can nudge with words, a list whose aisle you can drag. AI
that can't be corrected reads as a gimmick the first time it is wrong.

---

## 2. Naming

Rename **Recipes → Conjure Pantry**. Surfaces to change:

| Surface | File / location | Note |
|---|---|---|
| Display name | `package.json` → `conjureos.displayName` | `"Recipes"` → `"Conjure Pantry"` |
| Description | `package.json` → `description` | rewrite around pantry-first promise |
| Icon | `package.json` → `conjureos.icon` | `fa:utensils` → a pantry/basket glyph |
| Store listing | ConjureOS App Store row | title + blurb |
| In-app title | `src/App.tsx` `TAB_TITLE`, header | |
| Prompt suggestions | `package.json` → `conjureos.promptSuggestions` | rewrite for pantry framing |

**Leave the store slug as `recipes`.** It is hard-coded in
`.github/workflows/publish-store.yml` (lines 119, 133) and is the dedupe key for
installed copies — changing it produces a second app on every device instead of
an update. Slug is plumbing; the user never sees it.

Repo name, npm package name, and directory can stay `conjureos-app-recipes`.
Renaming the repo would break the CI secrets and the ConjureOS docs that point
at it, for zero user-visible gain.

---

## 3. Visual language

The brief: **squared-off angles, and border definition that is light — almost
not there.** Away from the current "Modern Whimsy" bubbly language.

### The concrete problem

`src/styles.css` is 3,857 lines with **106 hard-coded `border-radius`
declarations** across 15 distinct values (`999px` ×26, `14px` ×20, `12px` ×11,
`10px` ×11, `16px` ×8, `18px` ×7, `20px` ×6, `8px` ×7, plus one-offs at 3, 6,
22, 24px). There is no radius scale. That is the single biggest lever: you
cannot "square off the app" while every component picks its own curve.

### The change

1. **Introduce a radius scale** on `.cui-ui` and sweep all 106 sites onto it:
   - `--r-0: 0` — full-bleed edges, section dividers
   - `--r-1: 2px` — the default for cards, inputs, sheets, buttons
   - `--r-2: 4px` — the largest thing in the app (modals, image frames)
   - `--r-pill: 999px` — **kept, but rationed**: only status chips and avatars.
     The coverage chips (`.cov-chip`, `.miss-chip`, `.short-chip`) read as
     *data*, and pills are right for data. Everything structural goes square.
2. **Borders carry the structure, not shadows.** Today depth comes from
   `--shadow-glow` / `--shadow-soft` and a radial background wash. Replace with
   a hairline: `1px solid var(--cui-border)` at low contrast, and delete the
   glow shadows from cards entirely. Keep one shadow, for genuinely floating
   layers (sheets, dropdowns) only.
3. **Kill the background wash.** `body` currently paints a
   `radial-gradient(… var(--cui-accent-mute) …)`. A flat `var(--bg-0)` is the
   modern read and makes hairlines legible.
4. **Ration the gradient.** `--grad-primary` / `--grad-warm` should survive on
   exactly one element per screen (the primary action). Everywhere else, flat
   fills. Note the existing constraint in the CSS comments: both stops must stay
   inside the `--cui-accent` / `--cui-accent-hover` pair, because
   `--cui-on-accent` is only calibrated against it. Do not introduce a third
   colour.
5. **Type does more work.** With ornament gone, hierarchy has to come from size
   and weight. Expect to add a type scale alongside the radius scale.

### Guardrails (these have bitten before — see `CLAUDE.md`)

- **Never hard-code a colour.** Spring's `--cui-on-accent` is *dark* (`#0d1108`)
  in dark flavour and white in light, so `color: #fff` on a filled button is a
  real bug, not a shortcut.
- The palette is locked to Spring (`spr`). The only appearance axis is
  light/dark, and **both must be checked** for every change.
- `src/conjureos-ui.css` is a vendored 1.x copy of `@conjureos/ui`. Don't
  re-sync it as part of this work; `npm test` guards it.

---

## 4. Information architecture

Current bottom nav: **Home · Recipes · Plans** (plus Studio/Admin by role), with
Family, Stores and Appearance hidden behind a header cog.

Proposed: **Pantry · Plan · List · Recipes**

| Tab | Why it moves |
|---|---|
| **Pantry** | The new home. Opens on what you have, with the scan button as the primary action and "what's about to go off" as the top block. This is the "not just a recipe app" screen. |
| **Plan** | The week, shared with family. Absorbs today's Plans screen. |
| **List** | The grocery list, store-ordered. Today it is buried inside a plan; it is a place you stand in a shop holding a phone, and it deserves a tab. |
| **Recipes** | Demoted from co-star to library/browse. Still the 1,120 USDA recipes + saved + family. |

Home as a separate tab goes away — Pantry is home. Studio and Admin stay
role-gated. Family, Stores and Appearance stay behind the cog; they're set once.

**This is the highest-risk item in the plan** — it touches routing in
`src/App.tsx` (`Tab` union, `TABS`, `TAB_TITLE`, `cookOrigin`) and every
screen's back-navigation. Do it as its own commit, before any visual work, so a
regression is bisectable.

---

## 5. Screen-by-screen

### Pantry (new home) — `PantryScreen.tsx` (410 lines today)
- Hero: **Scan shelf / Scan fridge**, camera-first, not a text-entry form.
- "Use these up" block: items nearest expiry or longest-held, each linking to
  the planner pre-seeded with that ingredient.
- Stock list, grouped by location (pantry / fridge / freezer), square rows,
  hairline dividers, no cards.
- Scan results land in an **editable review sheet** — never written straight
  through. This is the AI-is-correctable rule in its most important instance.

### Plan — `PlansScreen.tsx` (995) + `PlanWeekScreen.tsx` (962)
- Seven day columns/rows, each slot showing the dish and a **coverage chip**
  (how much of it you already own) — reusing `CoverageChips` from
  `RecipeRow.tsx`.
- A "week score" strip: *ingredients used up* and *distinct cuisines*, so the
  two objectives of the planner are visible, not implicit.
- Natural-language nudge box ("busy Tuesday, no fish") feeding `interpretMood`.
- Family presence: who else is looking at this week, and a share control that is
  one tap.
- These two files are ~1,950 lines between them and are the most complex in the
  repo. Budget accordingly; consider splitting before restyling.

### List — new screen, logic exists in `storeLayout.ts` / `aiStoreSort.ts` / `printList.ts`
- Grouped by aisle, in walk order for the selected store.
- Big square checkboxes, thumb-reachable, high contrast — this is used one-handed
  in bad lighting.
- Aisle order is editable; the AI proposes, the user corrects, the correction
  sticks for that store.

### Recipes — `RecipesScreen.tsx` (525) / `RecipesBrowseScreen.tsx` (384)
- Library, not landing. Square thumbnails, hairline separators.
- Coverage chips stay — they are the pantry-first idea showing up in the
  recipe list.
- Keep the `cookTime > 0` guard (fixed at `0.43.1`): the USDA corpus carries no
  times, and "0 min" was printing on all 1,120 rows.

### Guided cook — `GuidedCook.tsx` (308)
- Largely leave alone; it was just hardened (localStorage resume, 12h TTL,
  reversible "I made this").
- Restyle only: square the cards, drop the glow.

---

## 6. Work order

Each step is a commit; each is independently shippable to dev.

1. **Radius + border token scale**, sweep `styles.css`. No structural change.
   Visual-only, reversible, and it is the thing the owner will feel first.
2. **Rename** to Conjure Pantry (display name, description, icon, in-app
   strings, prompt suggestions). Slug untouched.
3. **IA change**: four tabs, Pantry as home. Routing only, minimal styling.
4. **Pantry screen** rebuild — scan-first hero, use-these-up block.
5. **List screen** promoted out of Plans.
6. **Plan screen**: week score strip, coverage chips, nudge box.
7. **Recipes** restyle (cheapest; it is already mostly rows).
8. **Planner objective function** — server-side in `planWeekRemote`. See §7.

Steps 1–3 are a coherent first ship. Steps 4–7 are the redesign proper.
Step 8 is the one that needs real thought and probably its own thread.

---

## 7. The planner algorithm (the actual differentiator)

Everything above is packaging. This is the product.

Current `planWeek` ranks recipes by pantry coverage and picks the top N. That
produces a week of near-duplicates, because the highest-coverage recipes are
the ones sharing the same ingredients.

What is wanted is a **set** objective, not a per-recipe one:

- maximize *distinct pantry items consumed across the week* (waste reduction)
- maximize *diversity across the set* (cuisine, protein, method, so it doesn't
  feel like leftovers seven nights running)
- weight items by **waste risk** — nearest expiry, longest held, most commonly
  thrown out — so the week clears what's actually about to be binned
- subject to: servings, the family's constraints, effort on weeknights

This is a coverage/diversity trade-off, i.e. greedy submodular selection is the
obvious first cut (pick the recipe with the best marginal gain, where gain
decays for ingredients and cuisines already used). Cheap, explainable, good
enough. It runs **server-side in `planWeekRemote`**, not on device.

It also needs to be *legible*: the week score strip in §5 exists so the user can
see the planner doing its job, and so a bad week is diagnosable rather than
mysterious.

---

## 8. Constraints the new thread must not rediscover the hard way

- **Never publish without building the store bundle locally and loading
  `dist/recipes.html` in a browser.** `npm run dev` uses a different pipeline.
- Bump `version` in **both** `package.json` and `src/version.ts`, together. CI
  fails the publish if they differ.
- `npm run typecheck` and `npm test` (19 appearance cases) green before commit.
- Migrations are applied by **CI only**; additive and idempotent; applied ones
  are immutable. The Management API is a scratchpad.
- **Do not regenerate the AllRecipes corpus.** It was deleted deliberately on
  2026-09-17. `scripts/build-catalog.ts` and `scripts/rewrite-catalog.ts` remain
  only as history; running either reintroduces the removed content.
- Data loss is acceptable for this work — the owner has confirmed the only users
  are himself, his wife, and one friend. Migrations can be destructive if that
  buys a cleaner schema.

## 9. Open questions

1. **Icon** for Conjure Pantry — `fa:` glyph, or a custom mark?
2. **Does "Recipes" survive as a tab name**, or does the library get folded into
   search from the Pantry screen?
3. **Waste-risk data** — partly answered: `PantryItem` (`src/types.ts:141`)
   already carries `addedAt`, so *longest held* works today. There is no expiry
   date and no shelf-life table, so *nearest expiry* needs either a new optional
   `expiresAt` field or a per-category shelf-life lookup (spinach ≠ rice).
   Which?
4. **Store layout bootstrapping** — how does a new user's store get its aisle
   order the first time, before there's anything for the AI to learn from?

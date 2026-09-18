# Conjure Pantry — design plan

> The brief that turned Recipes into Conjure Pantry, kept in the repo because
> it is the answer to "why is the app shaped like this?". §1–§9 are the
> original hand-off brief, written 2026-09-18. §10 records what was actually
> decided while building it, including the answers to §9's open questions —
> read §10 before treating anything in §9 as still open.

---

## 1. What we are actually building

Today the app is a recipe app with a pantry feature. The repositioning inverts
that: **it is a pantry app that happens to know recipes.**

The promise is to *use up what you already have.* Two mechanics carry it:

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

**"Not just a recipe app" has to be the first thing you see.** The old Home
screen opened on recipe rows; the redesign opens on the pantry and the week.

### AI is the *how*, not a feature list

Seven AI surfaces exist in the codebase and every one of them used to sit
behind a generic label:

| Surface | Where | Old label |
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

Rename **Recipes → Conjure Pantry**:

| Surface | File / location |
|---|---|
| Display name | `package.json` → `conjureos.displayName` |
| Description | `package.json` → `description` |
| Icon | `package.json` → `conjureos.icon` |
| Store listing | ConjureOS App Store row (title + blurb) |
| In-app title | `src/App.tsx`, header |
| Prompt suggestions | `package.json` → `conjureos.promptSuggestions` |

**Leave the store slug as `recipes`.** It is hard-coded in
`.github/workflows/publish-store.yml` and is the dedupe key for installed
copies — changing it produces a second app on every device instead of an
update. Slug is plumbing; the user never sees it.

Repo name, npm package name, and directory stay `conjureos-app-recipes`.
Renaming the repo would break the CI secrets and the ConjureOS docs that point
at it, for zero user-visible gain.

---

## 3. Visual language

The brief: **squared-off angles, and border definition that is light — almost
not there.** Away from the old "Modern Whimsy" bubbly language.

### The concrete problem

`src/styles.css` carried **106 hard-coded `border-radius` declarations** across
15 distinct values (`999px` ×26, `14px` ×20, `12px` ×11, `10px` ×11, `16px` ×8,
`18px` ×7, `20px` ×6, `8px` ×7, plus one-offs at 3, 6, 22, 24px). There was no
radius scale. That is the single biggest lever: you cannot "square off the app"
while every component picks its own curve.

### The change

1. **A radius scale** on `.cui-ui`, and every site swept onto it:
   `--r-0: 0` (edges, dividers, bars), `--r-1: 2px` (the default),
   `--r-2: 4px` (the largest thing in the app), `--r-pill` — **kept, but
   rationed**: status chips and count badges only, because a pill reads as
   *data*. Everything structural goes square.
2. **Borders carry the structure, not shadows.** A hairline at
   `1px solid var(--cui-border)`, the glow shadows gone from cards entirely.
   One shadow survives, for genuinely floating layers (sheets, dropdowns).
3. **Kill the background wash.** `body` painted a radial accent gradient. Flat
   `var(--bg-0)` is the modern read and is what makes hairlines legible.
4. **Ration the gradient.** `--grad-primary` survives on exactly one element
   per screen (the primary action). Everywhere else, flat fills. Both stops
   must stay inside the `--cui-accent` / `--cui-accent-hover` pair, because
   `--cui-on-accent` is only calibrated against it.
5. **Type does more work.** With ornament gone, hierarchy has to come from size
   and weight, so there is a type scale alongside the radius scale.

### Guardrails (these have bitten before — see `CLAUDE.md`)

- **Never hard-code a colour.** Spring's `--cui-on-accent` is *dark* (`#0d1108`)
  in the dark flavour and white in light, so `color: #fff` on a filled button is
  a real bug, not a shortcut.
- The palette is locked to Spring (`spr`). The only appearance axis is
  light/dark, and **both must be checked** for every change.
- `src/conjureos-ui.css` is a vendored 1.x copy of `@conjureos/ui`. Don't
  re-sync it as part of this work; `npm test` guards it.

---

## 4. Information architecture

Old bottom nav: **Home · Recipes · Plans** (plus Studio/Admin by role), with
Family, Stores and Appearance behind a header cog.

New: **Pantry · Plan · List · Recipes**

| Tab | Why it moves |
|---|---|
| **Pantry** | The new home. Opens on what you have, with the scan as the primary action and "what's about to go off" as the top block. This is the "not just a recipe app" screen. |
| **Plan** | The week, shared with family. |
| **List** | The grocery list, store-ordered. It was buried inside a plan; it is a place you stand in a shop holding a phone, and it deserves a tab. |
| **Recipes** | Demoted from co-star to library. Still the 1,120 USDA recipes + saved + family. |

Home as a separate tab goes away — Pantry is home. Studio and Admin stay
role-gated. Family, Stores and Appearance stay behind the cog; they're set once.

---

## 5. Screen by screen

### Pantry (home)
- Hero: **Scan fridge / Scan a shelf**, camera-first, not a text-entry form.
- "Use these up" block: items nearest expiry or longest-held, each linking to
  the planner pre-seeded with that ingredient.
- Stock list grouped by location (pantry / fridge / freezer), square rows,
  hairline dividers, no cards.
- Scan results land in an **editable review sheet** — never written straight
  through. This is the AI-is-correctable rule in its most important instance.

### Plan
- Day slots, each showing the dish and a **coverage chip** (how much of it you
  already own).
- A "week score" strip: *ingredients used up* and *distinct cuisines*, so the
  two objectives of the planner are visible, not implicit.
- Natural-language nudge box ("busy Tuesday, no fish") feeding `interpretMood`.
- Family presence, and a share control that is one tap.

### List
- Grouped by aisle, in walk order for the selected store.
- Big square checkboxes, thumb-reachable, high contrast — this is used
  one-handed in bad lighting.
- Aisle order is editable; the AI proposes, the user corrects, the correction
  sticks for that store.

### Recipes
- Library, not landing. Square thumbnails, hairline separators.
- Coverage chips stay — the pantry-first idea showing up in the recipe list.
- Keep the `cookTime > 0` guard (fixed at `0.43.1`): the USDA corpus carries no
  times, and "0 min" was printing on all 1,120 rows.

### Guided cook
- Largely leave alone; it was just hardened (localStorage resume, 12h TTL,
  reversible "I made this"). Restyle only.

---

## 6. Work order

Each step is a commit; each is independently shippable.

1. **Radius + border token scale**, sweep `styles.css`. Visual-only.
2. **Rename** to Conjure Pantry. Slug untouched.
3. **IA change**: four tabs, Pantry as home. Routing only.
4. **Pantry screen** rebuild — scan-first hero, use-these-up block.
5. **List screen** promoted out of Plans.
6. **Plan screen**: week score strip, coverage chips, nudge box.
7. **Recipes** restyle.
8. **Planner objective function** — server-side in `planWeekRemote`. See §7.

---

## 7. The planner algorithm (the actual differentiator)

Everything above is packaging. This is the product.

Ranking recipes by pantry coverage and picking the top N produces a week of
near-duplicates, because the highest-coverage recipes are the ones sharing the
same ingredients.

What is wanted is a **set** objective, not a per-recipe one:

- maximize *distinct pantry items consumed across the week* (waste reduction)
- maximize *diversity across the set* (cuisine, protein, method, so it doesn't
  feel like leftovers seven nights running)
- weight items by **waste risk** — nearest expiry, longest held — so the week
  clears what's actually about to be binned
- subject to: servings, the family's constraints, effort on weeknights

This is a coverage/diversity trade-off, i.e. greedy submodular selection: pick
the recipe with the best marginal gain, where gain decays for ingredients and
cuisines already used. Cheap, explainable, good enough. It runs **server-side
in `planWeekRemote`**, not on device.

It also needs to be *legible*: the week score strip in §5 exists so the user can
see the planner doing its job, and so a bad week is diagnosable rather than
mysterious.

---

## 8. Constraints not to rediscover the hard way

- **Never publish without building the store bundle locally and loading
  `dist/recipes.html` in a browser.** `npm run dev` uses a different pipeline.
- Bump `version` in **both** `package.json` and `src/version.ts`, together.
- `npm run typecheck` and `npm test` green before commit.
- Migrations are applied by **CI only**; additive and idempotent; applied ones
  are immutable. The Management API is a scratchpad.
- **Do not regenerate the AllRecipes corpus.** It was deleted deliberately on
  2026-09-17.
- Data loss is acceptable for this work — the only users are the owner, his
  wife, and one friend.

## 9. Open questions (as raised)

1. **Icon** for Conjure Pantry — `fa:` glyph, or a custom mark?
2. **Does "Recipes" survive as a tab name**, or does the library get folded into
   search from the Pantry screen?
3. **Waste-risk data** — `PantryItem` already carries `addedAt`, so *longest
   held* works today. There is no expiry date and no shelf-life table, so
   *nearest expiry* needs either a new optional `expiresAt` field or a
   per-category shelf-life lookup (spinach ≠ rice). Which?
4. **Store layout bootstrapping** — how does a new user's store get its aisle
   order the first time, before there's anything for the AI to learn from?

---

## 10. Decisions taken while building it

> Anything here supersedes §1–§9. Cross-cutting calls are also in ConjureOS
> `DECISIONS.md`.

### §9.1 Icon — `fa:basket-shopping`, registered upstream

`fa:` icons come from a **curated allowlist** in ConjureOS
(`src/shell/icons/manifestFaIcons.ts`), because FontAwesome tree-shakes and
accepting arbitrary names would mean shipping every icon. An unregistered name
silently renders a grey initials tile, so the glyph had to land there first —
ConjureOS `0.81.1`, plus the three prose copies of the allowlist that
`faIconDocsSync.test.ts` pins to the registry.

A basket over a jar because it is unambiguous at tile size and covers both
halves of the promise: what you have, and what you're going out for. A custom
mark was not worth the maintenance for an app with three users.

### §9.2 "Recipes" survives as a tab

Folding the library into search from the Pantry screen would have made 1,120
recipes reachable only by knowing what to type. Browsing is a real mode — it is
how you find something you did not know you wanted — and the tab is where the
"Tonight's pick" recommendation and the three ways of ADDING a recipe now live.
Demoted from co-star to library, which was the actual goal, not deleted.

### §9.3 Waste risk — BOTH, layered, and never blended

`src/features/shelfLife.ts`. A per-category shelf-life table applied to
`addedAt` gives every item a risk estimate with zero user input, which is the
"it just knows" experience the app promises. An optional `expiresAt` — read off
the packaging by the scan, or typed on the row — overrides it outright.

The two are deliberately **not** blended. A printed date nudged by a table is
less trustworthy than either alone, and the moment the app is confidently wrong
about a date the whole block is dead. The UI always says which it is showing.

Two rules keep the table honest, both pinned by `scripts/shelfLife.test.ts`:
longest matching keyword wins ("ground beef" ≠ "beef", "black pepper" ≠
"pepper"), and a keyword must start at a word boundary (without it, "boiled
eggs" matches `oil`).

The scan also learns **where** it was looking (`PantryItem.location`), which is
what makes the freezer stop the clock and what groups the stock list.

### §3 — two colour bugs the hairlines exposed

`--cui-accent-mute` and `--cui-accent-tint` look like the accent tokens and are
not: both are deprecated aliases for the **support** hue, which in Spring is
pink. Every "accent" hairline and hover wash in the app was a pink one on a
green app — invisible under the old glows, loud once a hairline is the whole
structure. Replaced by `--accent-line` / `--accent-wash` / `--hair-accent`,
derived from `--cui-accent`. Fifteen hard-coded literals off the retired
purple/pink palette went at the same time.

### §4 — the guided cook stopped being a tab

It was a routable tab, so starting a cook unmounted whatever you were looking
at and Back needed a `cookOrigin` to find its way home. It is an overlay now:
the tab underneath stays mounted and merely hidden, so a half-confirmed scan or
a search three screens deep is exactly where you left it.

### §2 — the store listing is a manual step

`scripts/publish-app.mjs` only writes `display_name` / `description` on
`--first-publish`, when it creates the `store_apps` row. Every later publish
registers a version and leaves the row alone, so renaming the listing is an
Admin edit or one SQL statement per project. CI cannot do it.

/**
 * Build-time feature flags.
 *
 * Same convention Conjure Health uses to park its workout coach: the code
 * stays, the surface goes, and re-enabling is a one-line change rather than
 * an archaeology exercise.
 */

/**
 * Recipe photography in the UI.
 *
 * ON since 0.56.0, for the USDA-credited photos only (owner decision,
 * 2026-09-23: "just use the USDA images").
 *
 * History: it was OFF by owner decision (2026-09-04) over the scraped
 * AllRecipes corpus, where 0 of 3,190 rows carried an image_url and every
 * photo would have added to its provenance question (issue #48). The corpus
 * is USDA MyPlate now, and the Internet Archive's captures of the retired
 * myplate.gov pages carry a photo per recipe — but most recipes credit a
 * partner (a state university, a nonprofit, a company), and a partner may
 * still own its photo. So only recipes whose page credits a FEDERAL source
 * get one: `scripts/usda-photo-census.py` decides which and writes
 * `scripts/usda-photos.json`, and `scripts/import-usda-photos.mjs` uploads
 * exactly those and sets their image_url. Everything else keeps its plate.
 * Do not import a partner-credited photo without that partner's permission.
 *
 * What it switches: every recipe surface has one picture slot
 * (components/RecipePlate.tsx) — the feed tile, Tonight's pick, and the
 * picture behind an open recipe. With this on, a row with an image_url shows
 * its photo there; a row without one (or a photo that fails to load) shows
 * the category plate. It also turns on the recipe-photo picker in the editor,
 * so people can photograph their own recipes. The layout does not change.
 *
 * What this flag does NOT do:
 *   - It does not remove backend support. `recipes.image_url`, the
 *     `uploadImage` action, and the `imageUrl` field on every wire shape all
 *     stay live, and an existing value round-trips through save untouched.
 *   - It does not touch the fridge-scan capture flow. Those photos are
 *     *input* to the vision pass, not recipe photography, and they are the
 *     whole point of the app. `.photo-tile`, `.photo-strip-img`,
 *     `.ing-screen .thumb` and the ImagePicker's own preview belong to that
 *     flow and are unaffected.
 */
export const RECIPE_PHOTOS_ENABLED = true;

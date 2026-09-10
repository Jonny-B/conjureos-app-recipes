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
 * OFF by owner decision (2026-09-04). The app committed to a typographic
 * visual language instead of a photo-led one, because the corpus can't
 * support the alternative: **0 of 3,190 live recipes carry an image_url**,
 * and only 18 carry a summary. A photo-led browse grid over that corpus is
 * 3,190 grey rectangles — worse than no photos at all, and it would make the
 * catalog's unresolved provenance question (issue #48) larger by adding
 * another 3,190 assets of uncertain origin.
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
 *
 * Flipping this to `true` restores the browse thumbnail, the detail hero, and
 * the recipe-photo picker in the editor. Nothing else needs to change — but
 * check the typographic card system still holds with images in it before you
 * do, because it was designed on the assumption they're absent.
 */
export const RECIPE_PHOTOS_ENABLED = false;

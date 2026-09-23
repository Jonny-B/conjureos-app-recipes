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
 * OFF by owner decision (2026-09-04), taken over the scraped AllRecipes
 * corpus: 0 of its 3,190 rows carried an image_url, a photo-led grid over it
 * would have been 3,190 grey rectangles, and every photo would have added to
 * its unresolved provenance question (issue #48).
 *
 * Where that stands now (2026-09-23): the corpus is USDA MyPlate (1,120
 * rows) and still 0 rows carry an image_url. The Internet Archive's captures
 * of the retired myplate.gov recipe pages DO carry a photo per recipe, so
 * importing them is possible — but it is an owner decision, not a flag flip,
 * because the photos' terms are looser than the text's: USDA asks that its
 * photos be used "only for promotion, informational and educational purposes
 * of a non-profit nature", and recipes credited to partner programmes may
 * carry partner photos that are not federal works at all.
 *
 * Since 0.54.0 the UI no longer needs photos to look finished: every recipe
 * surface has a picture slot (components/RecipePlate.tsx) that shows a
 * category plate — hue + glyph — when there is no photo. Flipping this to
 * `true` puts photos in that same slot (the feed tile, Tonight's pick, and
 * the picture behind an open recipe) wherever a row has an image_url, keeps
 * the plate where it doesn't, and restores the recipe-photo picker in the
 * editor. The layout around the slot does not change.
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
export const RECIPE_PHOTOS_ENABLED = false;

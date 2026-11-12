/** Polish batch (ConjureOS #1243): no internal id in the footer, saved catalog recipes listed once, one price wording, plain errors. Plain tsx. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { withoutSavedTwins } from "../src/features/feedMerge";
import { plainError } from "../src/features/plainError";
import { costLabel } from "../src/hooks/usePhotoActions";
import { RecipeDetail } from "../src/screens/RecipeDetail";

let failures = 0;
const ok = (cond: boolean, what: string): void => {
  if (!cond) {
    failures++;
    console.error("FAIL", what);
  }
};

// 2. a saved copy hides its catalog twin, by title, and nothing else.
const cat = [{ title: "Pumpkin Cookies", id: "1" }, { title: "Chili", id: "2" }];
const twin = withoutSavedTwins(cat, [{ title: " pumpkin cookies " }]);
ok(twin.length === 1 && twin[0]!.id === "2", "saved twin is dropped from the catalog side");
ok(withoutSavedTwins(cat, []).length === 2, "no saved recipes keeps the catalog whole");

// 3. one wording for the price.
ok(costLabel(null, true) === null, "no quote, no price");
ok(costLabel(12, true) === "up to 12 credits", "enhance is a ceiling");
ok(costLabel(8, false) === "8 credits", "generate is exact");

// 4. kernel errors become plain words; our own sentences pass through.
const warn = console.warn;
console.warn = () => {};
const kernel = new Error('Remote action failed (HTTP 413): {"error":"image_quota_exceeded"}');
ok(!/HTTP|\{|error"/.test(plainError(kernel)), "kernel text is not shown");
ok(/photo limit/.test(plainError(kernel)), "quota code has its own line");
ok(/removed/.test(plainError(new Error('Remote action failed (HTTP 403): {"error":"banned"}'))), "banned has its own line");
ok(!/HTTP/.test(plainError(new Error("Remote action failed (HTTP 500): boom"))), "unknown status is generic");
console.warn = warn;
ok(plainError(new Error("Give the recipe a title first.")) === "Give the recipe a title first.", "plain sentence passes through");

// 1. the footer of a saved recipe does not print its internal id.
const saved = {
  title: "Soup", path: "db:3f2a9c1e-0000-4000-8000-123456789abc", slug: "x", difficulty: "easy", cookTime: 10, servings: 2,
  ingredients: ["1 onion"], instructions: ["Cook."], savedAt: "2026-01-01", madeCount: 0, favorite: false,
};
const html = renderToStaticMarkup(
  createElement(RecipeDetail, {
    feed: { kind: "saved", recipe: saved as never, favorite: false },
    onCook: () => {},
    onBack: () => {},
    onToggleFavorite: () => {},
  } as never),
);
ok(!html.includes("db:3f2a9c1e"), "saved recipe footer does not leak db:<uuid>");

if (failures) process.exit(1);
console.log("polish.test: ok");

// recipes-db's own limit codes (orchestrator review): a full block list is a
// 409, so the 429 fallback would not catch it.
{
  const { plainError } = await import("../src/features/plainError");
  const full = plainError(new Error('recipes-db blockAuthor failed (HTTP 409): {"error":"too_many_blocked"}'));
  if (full !== "Your block list is full. Unblock someone first.") throw new Error(`too_many_blocked: got ${full}`);
  const reports = plainError(new Error('recipes-db reportRecipe failed (HTTP 429): {"error":"too_many_reports"}'));
  if (!/reports in a short time/.test(reports)) throw new Error(`too_many_reports: got ${reports}`);
  console.log("polish: recipes-db limit codes pass");
}

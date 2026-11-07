/**
 * Tests for the user-content safety half of the app (ConjureOS Phase 68):
 * the server's 422 refusals read back as a line for the field they name,
 * Report and Block reach recipes-db with the shapes it accepts, and the chef
 * feed and share link go through the signed-in path so a block takes effect.
 * Plain tsx like the other tests; the bridge and fetch are stubbed.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { refusalFrom, RecipeRefusal } from "../src/features/refusal";
import { REPORT_CATEGORIES } from "../src/features/report";
import { ReportSheet } from "../src/components/ReportSheet";
import {
  addRecipe,
  blockAuthor,
  fetchChefLatest,
  fetchShared,
  listBlocked,
  publishChefRecipe,
  reportChef,
  reportRecipe,
  unblockAuthor,
  updateRecipe,
} from "../src/bridge/recipesApi";
import { FieldLine, revealRefusal } from "../src/components/RecipeEditor";
import { canActOnAuthor } from "../src/components/SafetyActions";
import { hideRecipe, isRecipeHidden } from "../src/features/blockedAuthors";

let failures = 0;
const ok = (cond: boolean, what: string): void => {
  if (cond) return;
  failures++;
  console.error(`  FAIL  ${what}`);
};

type Call = { action: string; params: Record<string, unknown> };
let calls: Call[] = [];
let respond: (c: Call) => unknown = () => ({});
const g = globalThis as unknown as Record<string, unknown>;
g.__conjureos = {
  actions: {
    invoke: async (_path: string, _name: string, params: Record<string, unknown>) => {
      const c = { action: String(params.action), params };
      calls.push(c);
      const r = respond(c);
      if (r instanceof Error) throw r;
      return r;
    },
  },
};
const remoteError = (status: number, body: string): Error =>
  Object.assign(new Error(`Remote action failed (HTTP ${status}): ${body}`), { code: "REMOTE_ERROR" });

const MISTAKE = "Think this is a mistake? Write to support@conjureos.com.";
const recipe = { title: "Soup", difficulty: "easy" as const, cookTime: 10, servings: 2, ingredients: ["water"], instructions: ["boil"] };

async function main(): Promise<void> {
  // ── refusal parsing ───────────────────────────────────────────────
  const full = JSON.stringify({ error: "text_not_allowed", field: "title", term: "x", code: "blocked", message: `That word is not allowed. ${MISTAKE}` });
  const r1 = refusalFrom(remoteError(422, full));
  ok(r1 instanceof RecipeRefusal && r1.field === "title" && r1.line === `That word is not allowed. ${MISTAKE}`, "a whole 422 body gives the server's message as is");
  // The kernel cuts a remote error body at 200 characters.
  const long = JSON.stringify({ error: "text_not_allowed", field: "instructions", term: "x".repeat(40), code: "blocked", message: `${"A long sentence. ".repeat(10)}${MISTAKE}` });
  const r2 = refusalFrom(remoteError(422, long.slice(0, 200)));
  ok(!!r2 && r2.field === "instructions", "a body cut at 200 characters still names its field");
  ok(!!r2 && r2.line.endsWith(MISTAKE) && !r2.line.includes("A long sentence"), "a cut body gets finished copy with the support line, never half a sentence");
  const r3 = refusalFrom(remoteError(422, JSON.stringify({ error: "image_not_allowed", field: "imageUrl", message: "Upload the picture from your device or camera instead of linking to it." })));
  ok(!!r3 && r3.field === "imageUrl" && r3.line.startsWith("Upload the picture"), "a photo refusal reads back");
  ok(refusalFrom(new Error("Remote action failed (HTTP 500): boom")) === null, "other failures are not refusals");
  ok(refusalFrom(remoteError(409, '{"error":"username_taken"}')) === null, "a 409 is not a refusal");
  const copy = [r2!.line, r3!.line].join(" ");
  ok(!/[—–]/.test(copy) && !/\b(now|no longer|yet)\b/i.test(copy), "refusal copy has no em-dash, now, no longer or yet");

  // ── writes surface the refusal as RecipeRefusal ───────────────────
  respond = () => remoteError(422, full);
  for (const [name, fn] of [
    ["add", () => addRecipe(recipe)],
    ["update", () => updateRecipe("id1", recipe)],
    ["chefUpsert", () => publishChefRecipe(recipe)],
  ] as const) {
    let e: unknown = null;
    try {
      await fn();
    } catch (x) {
      e = x;
    }
    ok(e instanceof RecipeRefusal && (e as RecipeRefusal).field === "title", `${name} rethrows the refusal with its field`);
    ok(e instanceof Error && e.message === `That word is not allowed. ${MISTAKE}`, `${name} refusal message is the line`);
  }

  // ── report ────────────────────────────────────────────────────────
  calls = [];
  respond = () => ({ reported: true });
  await reportRecipe("r1", "harassment", "rude");
  await reportChef("r1", "other");
  ok(calls[0]!.action === "reportRecipe" && calls[0]!.params.recipeId === "r1" && calls[0]!.params.category === "harassment" && calls[0]!.params.details === "rude", "reportRecipe sends recipeId, category, details");
  ok(calls[1]!.action === "reportChef" && !("details" in calls[1]!.params), "reportChef omits empty details");
  respond = () => remoteError(429, '{"error":"too_many_reports"}');
  let rerr = "";
  try {
    await reportRecipe("r1", "other");
  } catch (e) {
    rerr = (e as Error).message;
  }
  ok(/later|several|many/i.test(rerr) && !/Remote action failed/.test(rerr), "a report rate limit reads as a plain line");

  // ── block ─────────────────────────────────────────────────────────
  calls = [];
  respond = (c) => (c.action === "listBlocked" ? { blocked: [{ userId: "u1", username: "pat" }, { userId: "u2", username: null }] } : { blocked: true });
  await blockAuthor("r1");
  const list = await listBlocked();
  await unblockAuthor("u1");
  ok(calls[0]!.action === "blockAuthor" && calls[0]!.params.recipeId === "r1", "blockAuthor names the author by a recipe");
  ok(list.length === 2 && list[1]!.username === null, "listBlocked returns handles, null allowed");
  ok(calls[2]!.action === "unblockAuthor" && calls[2]!.params.userId === "u1", "unblockAuthor sends the user id from the list");
  hideRecipe("r1");
  ok(isRecipeHidden("r1") && !isRecipeHidden("r2"), "a blocked author's recipe is hidden at once");

  // ── signed-in reads ───────────────────────────────────────────────
  calls = [];
  let plainFetches = 0;
  g.fetch = async () => {
    plainFetches++;
    return { ok: true, status: 200, json: async () => ({ recipes: [] }) };
  };
  respond = () => ({ recipes: [] });
  await fetchChefLatest(5);
  ok(calls.length === 1 && calls[0]!.action === "chefFeed" && plainFetches === 0, "chefFeed goes through invoke so the token is sent");
  respond = () => remoteError(404, '{"error":"not_found"}');
  ok((await fetchShared("tok")) === null && plainFetches === 0, "getShared 404 through invoke reads as not found");
  respond = () => remoteError(401, "not signed in");
  await fetchChefLatest(5);
  ok(plainFetches === 1, "chefFeed falls back to the plain read when the person is signed out");
  respond = () => remoteError(500, "down");
  let feedThrew = false;
  try {
    await fetchChefLatest(5);
  } catch {
    feedThrew = true;
  }
  ok(feedThrew && plainFetches === 1, "chefFeed fails closed on a server error, never the unfiltered read");
  let sharedThrew = false;
  try {
    await fetchShared("tok");
  } catch {
    sharedThrew = true;
  }
  ok(sharedThrew && plainFetches === 1, "getShared fails closed on a server error, never the unfiltered read");
  respond = () => remoteError(401, "not signed in");
  await fetchShared("tok");
  ok(plainFetches === 2, "getShared falls back to the plain read when signed out");

  // ── Report and Block are for someone else's recipe ────────────────
  ok(canActOnAuthor({ mine: false }, false), "a plain reader may report and block");
  ok(!canActOnAuthor({ mine: true }, false), "never on a recipe the server marks as yours");
  ok(!canActOnAuthor({ mine: false }, true), "a chef or admin may be the author, and the read cannot say, so no buttons");

  // ── a refusal is brought into view ────────────────────────────────
  let scrolled = 0;
  const el = { scrollIntoView: () => void scrolled++ };
  revealRefusal({ querySelector: (q: string) => (q === ".field-refusal" ? el : null) } as never);
  ok(scrolled === 1, "the field line is scrolled into view");
  revealRefusal({ querySelector: () => null } as never);

  // ── Report sheet ──────────────────────────────────────────────────
  ok(REPORT_CATEGORIES.map((c) => c.id).join() === "copyright_dmca,csam,malware,illegal,ip_other,harassment,hateful_sexual,other", "the eight categories recipes-db accepts");
  ok(REPORT_CATEGORIES.find((c) => c.id === "ip_other")!.label === "Other IP / trademark", "labels match the ConjureOS report dialog");
  const html = renderToStaticMarkup(createElement(ReportSheet, { recipeId: "r1", onClose: () => {} }));
  ok(REPORT_CATEGORIES.every((c) => html.includes(c.label)), "the sheet lists every category");
  ok(html.includes("Report this recipe") && html.includes("Report this chef"), "the sheet offers recipe or chef");
  ok(!/[—–]/.test(html), "the sheet has no em-dash");

  // ── the line sits under the field it names, and only that one ─────
  const line = (field: string, at: string[]): string =>
    renderToStaticMarkup(createElement(FieldLine, { refusal: new RecipeRefusal(field, `Line for ${field}.`, "text"), fields: at }));
  ok(line("ingredients", ["ingredients"]).includes("Line for ingredients.") && line("ingredients", ["ingredients"]).includes('role="alert"'), "the ingredients refusal shows under ingredients");
  ok(line("ingredients", ["instructions"]) === "", "a refusal does not show under another field");

  if (failures > 0) {
    console.error(`ugc: ${failures} failing`);
    process.exit(1);
  }
  console.log("ugc: all cases pass");
}
void main();

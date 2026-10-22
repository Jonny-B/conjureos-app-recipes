/**
 * Pins how Recipes declares its app type (ConjureOS Phase 62).
 *
 * Recipes is sealed: the AI changes nothing in it. A manifest that declares no
 * type is read as an AI-editable applet, which is wrong for every anchor, so
 * dropping either key fails here instead of shipping quietly. `editStyle` is
 * the old way; the store and the kernel write the legacy keys themselves, so
 * it must not come back.
 *
 * Plain tsx, no test framework, like scripts/theme.test.ts. Run with `npm test`.
 */
import { readFileSync } from "node:fs";

let failures = 0;
const ok = (cond: boolean, what: string): void => {
  if (cond) return;
  failures++;
  console.error(`  FAIL  ${what}`);
};

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { conjureos?: Record<string, unknown> };
const c = pkg.conjureos ?? {};

ok(c.appType === "sealed", `conjureos.appType is "sealed" (got ${JSON.stringify(c.appType)})`);
ok(c.editable === false, `conjureos.editable is false (got ${JSON.stringify(c.editable)})`);
ok(!("editStyle" in c), "conjureos.editStyle is not declared");

if (failures > 0) {
  console.error(`app-type: ${failures} failed`);
  process.exit(1);
}
console.log("app-type: all passed");

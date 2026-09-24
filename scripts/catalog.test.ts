/**
 * Tests for fetchCatalog's paging (ConjureOS #535): a failed page must never
 * turn into a catalog that stops partway through the alphabet. Plain tsx, like
 * theme.test.ts; `fetch` is stubbed with a fake recipes-db.
 */
import { fetchCatalog } from "../src/bridge/recipesApi";

let failures = 0;
const ok = (cond: boolean, what: string): void => {
  if (cond) return;
  failures++;
  console.error(`  FAIL  ${what}`);
};

const rows = Array.from({ length: 1120 }, (_, i) => ({
  id: `id${i}`,
  title: `r${String(i).padStart(4, "0")}`,
  category: "",
  difficulty: "easy",
  cookTime: 1,
  servings: 1,
  ingredients: [],
  instructions: [],
  tags: [],
  tokens: [],
  nutrition: null,
}));

/** A fake server; `fail(offset, callNo)` decides which calls come back 503. */
function serve(fail: (offset: number, call: number) => boolean): void {
  let call = 0;
  (globalThis as { fetch: unknown }).fetch = async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body) as { offset: number; limit: number };
    call++;
    if (fail(b.offset, call)) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ recipes: rows.slice(b.offset, b.offset + b.limit), total: rows.length }) };
  };
}

async function main(): Promise<void> {
  serve(() => false);
  ok((await fetchCatalog()).length === 1120, "a healthy server yields every recipe");

  // One hiccup on the second page: retried, and the whole catalog arrives.
  serve((offset, call) => offset > 0 && call === 2);
  ok((await fetchCatalog()).length === 1120, "a page that fails once is retried");

  // The second page never comes back: no partial catalog, an error instead.
  serve((offset) => offset > 0);
  let threw = false;
  try {
    await fetchCatalog();
  } catch {
    threw = true;
  }
  ok(threw, "a page that keeps failing throws rather than returning the first page alone");

  if (failures > 0) {
    console.error(`catalog: ${failures} failing`);
    process.exit(1);
  }
  console.log("catalog: 3 cases pass");
}
void main();

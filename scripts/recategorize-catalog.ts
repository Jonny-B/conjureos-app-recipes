/**
 * recategorize-catalog.ts: fix meal-type categories in the bundled catalog.
 *
 * The original build-time classifier (scripts/build-catalog.ts `classify`)
 * looked only at the scraped category + title and defaulted everything it
 * couldn't place to "Dinner". That dumped a lot of desserts, drinks, breads,
 * etc. into Dinner ("3 - Berry Sundaes", "A-Plus Hot Chocolate"...).
 *
 * This pass re-derives the category from title + ingredients + instructions,
 * but CONSERVATIVELY: it only MOVES a recipe when there is a confident signal,
 * otherwise it keeps whatever category the record already has. That targets the
 * obvious mis-tags without churning the whole corpus (and without inventing new
 * weird tags, which is the exact thing we're fixing).
 *
 *   npx -y tsx scripts/recategorize-catalog.ts          # dry run: report only
 *   npx -y tsx scripts/recategorize-catalog.ts --write  # rewrite src/data/catalog.ts
 *
 * Everything except the category index (`c`) is left untouched.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG } from "../src/data/catalog";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const OUT_CATALOG = resolve(REPO, "src/data/catalog.ts");

interface Rec {
  i: string; t: string; c: number; d: string; m: number; s: number;
  g: string[]; n: string[]; u: string; k: string[]; z?: number[]; a?: string[];
}
interface Catalog {
  v: number; generatedAt: string; rewrittenAt?: string; count: number;
  categories: string[]; r: Rec[];
}

const cat = CATALOG as unknown as Catalog;
const CATS = cat.categories;
const idxOf = (name: string): number => CATS.indexOf(name);

// A confident classifier. Returns a category NAME when sure, else null (keep
// the existing category). Title is the dominant signal; ambiguous words
// (cake/pie/tart) require a corroborating sweet signal and an absence of a
// savory-main signal.

const RX = (s: string) => new RegExp(s, "i");

// The head noun of a title = its last significant word (after stripping
// trailing roman numerals like "II"/"III" and punctuation). It disambiguates
// the categories that a sub-component word would otherwise hijack: an
// "...Cake with Brown Sugar Sauce" is a cake, not a sauce, because its head is
// "cake"; a "Sweet Chili Sauce" IS a sauce because its head is "sauce".
const ROMAN = new Set(["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"]);
function headNoun(title: string): string {
  const toks = title.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  while (toks.length && ROMAN.has(toks[toks.length - 1])) toks.pop();
  return toks[toks.length - 1] ?? "";
}

// Head-noun sets for the categories where the dish's last word is the reliable
// tell (a "Pasta Salad" is a salad; a "Chicken Salad Sandwich" is a sandwich).
const SAUCE_HEAD = new Set([
  "sauce", "dressing", "marinade", "pesto", "salsa", "gravy", "vinaigrette",
  "aioli", "chutney", "relish", "glaze", "jam", "jelly", "preserves", "syrup",
  "applesauce", "mayonnaise", "mayo", "ketchup", "mustard", "rub", "marinara",
]);
const LUNCH_HEAD = new Set([
  "sandwich", "sandwiches", "wrap", "wraps", "burger", "burgers", "taco",
  "tacos", "quesadilla", "quesadillas", "panini", "sub", "subs", "melt",
  "gyro", "gyros", "sliders", "slider", "hoagie", "calzone",
]);
const SOUP_HEAD = new Set([
  "soup", "stew", "chili", "bisque", "chowder", "broth", "gumbo", "ramen",
  "pho", "minestrone", "gazpacho",
]);
const SALAD_HEAD = new Set(["salad", "slaw", "coleslaw"]);
const DRINK_HEAD = new Set([
  "drink", "cocktail", "smoothie", "milkshake", "shake", "punch", "latte",
  "lemonade", "limeade", "margarita", "martini", "mojito", "daiquiri",
  "sangria", "eggnog", "spritzer", "slushie", "mimosa", "float", "frappe",
  "frappuccino", "soda", "tea", "coffee", "cooler", "fizz", "nog", "cider",
]);

// Strong keyword rules (a hit anywhere in the title) for categories that read
// better as "contains" than "ends with".
const STRONG_DESSERT = RX("\\b(dessert|sundae|cheesecake|brownie|blondie|cupcake|cookie|cookies|frosting|icing|buttercream|mousse|parfait|sorbet|sherbet|gelato|ice cream|ice-cream|custard|cobbler|fudge|truffle|truffles|donut|doughnut|macaron|macaroon|tiramisu|flan|eclair|meringue|trifle|shortcake|biscotti|churro|churros|gingerbread|panna cotta|creme brulee|cr.me br.l.e|popsicle|baklava|fudgesicle|toffee|praline|cinnamon roll|whoopie pie|rice krispie|rice krispy)s?\\b");
const STRONG_DRINK = RX("\\b(hot chocolate|hot cocoa|cocoa|smoothie|milkshake|frappe|frappuccino|frappucino|latte|cappuccino|espresso|macchiato|lemonade|limeade|cocktail|mocktail|margarita|martini|mojito|daiquiri|sangria|eggnog|spritzer|slushie|slushy|mimosa|mulled wine|hot toddy|horchata|agua fresca|aguas frescas|root beer float|iced coffee|iced tea|sweet tea|chai|hot buttered rum|bloody mary|pina colada|pi.a colada)s?\\b");
const STRONG_BREAKFAST = RX("\\b(breakfast|pancake|pancakes|omelet|omelette|waffle|waffles|frittata|scrambled egg|french toast|oatmeal|porridge|hash brown|hashbrown|quiche|crepe|crepes|granola|muesli|overnight oats|eggs benedict)s?\\b");
const STRONG_BREAD = RX("\\b(bread|focaccia|muffin|muffins|bagel|bagels|scone|scones|baguette|cornbread|naan|croissant|pretzel|breadstick|breadsticks|popover|brioche|dinner roll|crescent roll)s?\\b");
const STRONG_APPETIZER = RX("\\b(appetizer|hummus|bruschetta|deviled egg|canape|crostini|chicken wing|buffalo wing|hot wing|nachos|guacamole|queso|spring roll|egg roll|potsticker|stuffed mushroom|jalapeno popper|jalape.o popper|pigs in a blanket|cheese ball|charcuterie)s?\\b");
const STRONG_SNACK = RX("\\b(snack|trail mix|popcorn|jerky|energy ball|energy bite|granola bar|protein bar|kale chips|veggie chips)s?\\b");
const STRONG_SIDE = RX("\\b(mashed potato|roasted vegetable|french fries|\\bfries\\b|pilaf|stuffing|baked beans|green bean casserole|scalloped potato|au gratin|side dish)s?\\b");

// Ambiguous sweet baked goods: Dessert only with a corroborating sweet signal
// and no savory-main signal in the title.
// Deliberately narrow: "bar"/"crisp"/"crumble" caused false desserts
// ("Bar-B-Q Sauce", "Snack Mix") and are dropped for precision.
const AMBIG_SWEET = RX("\\b(cake|pie|tart|bread pudding|streusel)s?\\b");
const STRONG_SOUP = RX("\\b(soup|stew|chili|chowder|bisque|gumbo|minestrone)s?\\b");
const SWEET_SIGNAL = RX("sugar|powdered sugar|confectioners|chocolate|cocoa|vanilla|cinnamon|caramel|honey|maple|marshmallow|cream cheese|whipped cream|frosting|sweetened|condensed milk|nutella|butterscotch|molasses|berry|berries|apple|peach|cherry|banana|pumpkin|lemon curd|strawberr|blueberr|raspberr");
const SAVORY_MAIN = RX("\\b(pot pie|shepherd|cottage pie|chicken pie|turkey pie|beef pie|meat pie|tamale pie|hand pie|pizza|quiche|crab cake|fish cake|salmon cake|tuna cake|rice cake|pancake|cornbread|granola bar|protein bar)s?\\b");

// "coffee cake" / "tea cake" / "tea bread" are baked goods, not drinks.
const TITLE_DRINK_FALSE = RX("coffee cake|tea cake|tea sandwich|tea ring|tea bread|teacake");

function confidentCategory(r: Rec): string | null {
  const title = r.t.toLowerCase();
  const ings = r.g.join(" ").toLowerCase();
  const head = headNoun(title);

  // 0. A drink head noun wins outright ("Bailey's Sundae Coffee Drink" is a
  //    drink, not a dessert), guarded against "coffee cake" / "tea cake".
  if (DRINK_HEAD.has(head) && !TITLE_DRINK_FALSE.test(title)) return "Drink";
  // 1. Dessert next, so a cake/pie/cookie wins over a sub-component word
  //    ("...Cake with Lemon Glaze" stays a dessert, not a sauce).
  if (!SAVORY_MAIN.test(title)) {
    if (STRONG_DESSERT.test(title)) return "Dessert";
    if (AMBIG_SWEET.test(title) && (SWEET_SIGNAL.test(title) || SWEET_SIGNAL.test(ings))) {
      return "Dessert";
    }
  }
  // 2. Drinks.
  if (STRONG_DRINK.test(title) && !TITLE_DRINK_FALSE.test(title)) return "Drink";
  // 3. Head-noun routing for the "ends with the dish" categories.
  if (SAUCE_HEAD.has(head)) return "Sauce";
  if (SOUP_HEAD.has(head)) return "Soup";
  if (LUNCH_HEAD.has(head)) return "Lunch";
  if (SALAD_HEAD.has(head)) return "Salad";
  // 3b. A soup/stew/chili keyword anywhere wins over a baked-good sub-word
  //     ("Chili Stew with Cornbread Dumplings" is a soup, not a bread).
  if (STRONG_SOUP.test(title)) return "Soup";
  // 4. Remaining keyword categories.
  if (STRONG_BREAKFAST.test(title)) return "Breakfast";
  if (STRONG_BREAD.test(title)) return "Bread";
  if (STRONG_APPETIZER.test(title)) return "Appetizer";
  if (STRONG_SNACK.test(title)) return "Snack";
  if (STRONG_SIDE.test(title)) return "Side";

  return null;
}

// ── Run ────────────────────────────────────────────────────────────────────

const changes: Array<{ from: string; to: string; title: string }> = [];
for (const r of cat.r) {
  const want = confidentCategory(r);
  if (!want) continue;
  const wi = idxOf(want);
  if (wi < 0 || wi === r.c) continue;
  changes.push({ from: CATS[r.c], to: want, title: r.t });
  r.c = wi;
}

// Report.
const before = new Map<string, number>();
const after = new Map<string, number>();
const moveMatrix = new Map<string, number>();
for (const c of changes) {
  const k = `${c.from} -> ${c.to}`;
  moveMatrix.set(k, (moveMatrix.get(k) ?? 0) + 1);
}
for (const r of cat.r) after.set(CATS[r.c], (after.get(CATS[r.c]) ?? 0) + 1);
// before = after with the changes reversed
for (const r of cat.r) before.set(CATS[r.c], (before.get(CATS[r.c]) ?? 0));
for (const c of changes) {
  before.set(c.from, (before.get(c.from) ?? 0) + 1);
  before.set(c.to, (before.get(c.to) ?? 0) - 1);
}

console.log(`reclassified ${changes.length} of ${cat.r.length} recipes\n`);
console.log("moves:");
for (const [k, n] of [...moveMatrix.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(24)} ${n}`);
}
console.log("\ncategory counts (after):");
for (const name of CATS) console.log(`  ${name.padEnd(11)} ${after.get(name) ?? 0}`);

console.log("\nsample of changes:");
for (const c of changes.slice(0, 40)) {
  console.log(`  ${c.from.padEnd(10)} -> ${c.to.padEnd(10)} | ${c.title}`);
}

// Emit a tight, idempotent SQL patch for the DB-backed catalog (recipes-db):
// only the rows whose category changed, matched by title among catalog rows.
// Rerunnable (plain UPDATEs), and far lighter than a full re-seed.
{
  const sqlEsc = (s: string) => s.replace(/'/g, "''");
  const lines = [
    "-- Recategorization patch for the public catalog (source='catalog').",
    "-- Idempotent: re-running sets the same categories. Run on dev, then prod.",
    "begin;",
    ...changes.map(
      (c) =>
        `update public.recipes set category='${sqlEsc(c.to)}' ` +
        `where source='catalog' and title='${sqlEsc(c.title)}';`,
    ),
    "commit;",
  ];
  const outFile = resolve(REPO, "scripts", "recategorize-updates.sql");
  writeFileSync(outFile, lines.join("\n") + "\n", "utf8");
  console.log(`\nwrote ${changes.length} UPDATEs to ${outFile}`);
}

if (process.argv.includes("--write")) {
  const payload = {
    v: cat.v,
    generatedAt: cat.generatedAt,
    rewrittenAt: cat.rewrittenAt,
    recategorizedAt: new Date().toISOString(),
    count: cat.r.length,
    categories: cat.categories,
    r: cat.r,
  };
  const json = JSON.stringify(payload);
  const module =
    "// AUTO-GENERATED by scripts/build-catalog.ts, instructions reworded by\n" +
    "// scripts/rewrite-catalog.ts, categories corrected by\n" +
    "// scripts/recategorize-catalog.ts. Do not edit by hand.\n" +
    `export const CATALOG = ${json} as {\n` +
    "  v: number; generatedAt: string; rewrittenAt?: string; recategorizedAt?: string; count: number; categories: string[]; r: unknown[];\n" +
    "};\n";
  writeFileSync(OUT_CATALOG, module, "utf8");
  console.log(`\nwrote ${OUT_CATALOG} (${(module.length / 1024 / 1024).toFixed(2)} MB)`);
} else {
  console.log("\n(dry run — pass --write to rewrite src/data/catalog.ts)");
}

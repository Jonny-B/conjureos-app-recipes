#!/usr/bin/env python3
"""
NHLBI "Keep the Beat" recipes: what we can add, deduped against our catalog.
Writes scripts/nhlbi-recipes.json and caches photos under scripts/.cache/nhlbi/.

Two sources, both published by the National Heart, Lung, and Blood Institute
(NIH), a US federal agency:

  1. The live recipe pages, nhlbi.nih.gov/health/heart-healthy-living/
     healthy-foods/healthy-eating-recipes (54 recipes from eight NHLBI
     cookbooks). Clean structured text; NO photos (the site dropped them).
  2. Two cookbooks still hosted as PDFs on nhlbi.nih.gov, with the food
     photographs embedded:
       10-2921  Keep the Beat Recipes: Deliciously Healthy Dinners (75)
       10-7531  Keep the Beat Recipes: Deliciously Healthy Family Meals (43)
     Their acknowledgments credit the photos to "Ben Fink Photography", so
     every photo carries `imageCredit` and the app shows it on the picture
     (owner decision, 2026-09-28: photos published free for reuse alongside
     free recipes are used, with any stated credit displayed).

A recipe on both is taken from the WEB (cleaner text) with the PDF's photo and
category. Anything already in our catalog (same normalized title, or the same
ingredients under a near title) is dropped, as are repeats inside the set.

Parsing the PDFs is POSITIONAL (pymupdf text lines with coordinates), because
plain text extraction interleaves the quantity column with the step numbers:
  title        large type (>= 20pt) at the top
  section      the right-edge tab (x >= 540), e.g. "main dishes / beef"
  ingredients  left column: quantity at x~54, item at x~96
  steps        right column: number at x~263-269, text at x~283-289
  yield etc.   label line with its value on the next line
  nutrition    label / value pairs on one row
A recipe that runs over carries "(continued)" in its next page's title.

Which photo shows which recipe comes from the page layout: a photo on the
recipe's own page (or its continuation) is that recipe's; a full-page photo
opposite a recipe page belongs to that recipe; photos on section-divider
pages are skipped (they show "something from this section"). The pairing is
written into the JSON so it can be eyeballed (`photoPage`), and was checked by
eye on a contact sheet before the first import.

    pip install pymupdf
    python3 scripts/nhlbi-census.py
"""
import html as htmllib
import json
import os
import re
import subprocess
import sys

import pymupdf

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache", "nhlbi")
PHOTOS = os.path.join(CACHE, "photos")
OUT = os.path.join(HERE, "nhlbi-recipes.json")
RECIPES_DB = os.environ.get(
    "RECIPES_DB", "https://mqpvjlsywrptefgwuztn.supabase.co/functions/v1/recipes-db"
)
SITE = "https://www.nhlbi.nih.gov"
LIST = SITE + "/health/heart-healthy-living/healthy-foods/healthy-eating-recipes"
BOOKS = [
    ("10-2921", "Keep the Beat Recipes: Deliciously Healthy Dinners"),
    ("10-7531", "Keep the Beat Recipes: Deliciously Healthy Family Meals"),
]
PHOTO_CREDIT = "Ben Fink Photography / NHLBI"

# The cookbooks' section tabs, onto the app's categories.
SECTION_CATEGORY = [
    (r"soup", "Soup"),
    (r"salad", "Salad"),
    (r"side dish", "Side"),
    (r"dessert", "Dessert"),
    (r"snack", "Snack"),
    (r"lunch|brunch", "Lunch"),
    (r"breakfast", "Breakfast"),
    (r"beverage|drink", "Drink"),
    (r"sauce|dressing", "Sauce"),
    (r"main|beef|poultry|chicken|seafood|fish|pork|pasta|meatless|meal", "Dinner"),
]


# The dish's head noun settles the category on its own: the last word of the
# title before any "with ..." (so "Beef Tenderloin With Pineapple Salsa" is a
# beef dish, not a salsa, and "Creamy Squash Soup With Apples" is a soup).
HEAD_CATEGORY = [
    (r"soup|chowder|bisque|gazpacho", "Soup"),
    (r"salad|slaw", "Salad"),
    (r"smoothie|shake|lemonade|punch|spritzer|cooler", "Drink"),
    (r"parfait|compote|pudding|cake|cookies?|custard|crisp|cobbler|pie|sorbet|popsicles?|grapesicles|"
     r"brownies?|tart|trifle|mousse", "Dessert"),
    (r"muffins?|bread|biscuits?|scones?|cornbread", "Bread"),
    (r"pancakes?|waffles?|toast|fritters|oatmeal|omelet|frittata|granola", "Breakfast"),
    (r"salsa|dressing|sauce|gravy", "Sauce"),
    (r"dip|hummus|bruschetta|mix|pinwheels|roll-ups", "Snack"),
    (r"beans|medley|greens", "Side"),
    (r"rolls|lumpia|eggrolls", "Appetizer"),
]


def head_noun(title):
    t = re.sub(r"\(.*?\)", "", title.lower())
    t = re.split(r"\b(with|in)\b", t)[0]
    ws = re.findall(r"[a-z-]+", t)
    return ws[-1] if ws else ""


def curl(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 2000:
        return path
    for attempt in range(4):
        r = subprocess.run(["curl", "-sS", "-L", "-m", "180", "-o", path, "-w", "%{http_code}", url],
                           capture_output=True, text=True)
        if r.stdout.strip() == "200" and os.path.getsize(path) > 2000:
            return path
    raise SystemExit(f"could not fetch {url}")


# ─── The web pages ─────────────────────────────────────────────────────────

def web_lines(h):
    m = re.search(r"<main.*?</main>", h, re.S)
    b = m.group(0) if m else h
    b = re.sub(r"<script.*?</script>|<style.*?</style>", "", b, flags=re.S)
    t = htmllib.unescape(re.sub(r"<[^>]+>", "\n", b))
    return [l.strip() for l in t.split("\n") if l.strip()]


def web_recipes():
    os.makedirs(os.path.join(CACHE, "web"), exist_ok=True)
    slugs = set()
    for page in range(0, 20):
        p = curl(f"{LIST}?page={page}", os.path.join(CACHE, "web", f"list-{page}.html"))
        found = set(re.findall(r'healthy-eating-recipes/([a-z0-9-]+)"', open(p).read()))
        if not found - slugs and page > 0:
            break
        slugs |= found
    out = []
    for slug in sorted(slugs):
        ls = web_lines(open(curl(f"{LIST}/{slug}", os.path.join(CACHE, "web", slug + ".html"))).read())

        def sect(start, stops):
            if start not in ls:
                return []
            res = []
            for l in ls[ls.index(start) + 1:]:
                if l in stops:
                    break
                res.append(l)
            return res

        def after(k):
            return ls[ls.index(k) + 1] if k in ls else None

        head = [i for i, l in enumerate(ls) if l == "Healthy Eating Recipes"][-1]
        title = ls[head + 2]
        summary = ls[head + 3] if ls[head + 3] != "Recipe Source:" else ""
        out.append(dict(
            slug=slug, title=title, summary=summary,
            book=" ".join(sect("Recipe Source:", ["Ingredients"])),
            ingredients=[clean_line(plain_qty(x)) for x in sect("Ingredients", ["Directions"])],
            instructions=[clean_line(x) for x in sect("Directions", ["Prep Time", "Cook Time", "Yields", "Nutritional Facts"])],
            prep=after("Prep Time"), cook=after("Cook Time"), yields=after("Yields"),
            nutrition={k.lower(): after(k) for k in ["Calories", "Total Fat", "Protein", "Carbohydrates"] if after(k)},
            sourceUrl=f"{LIST}/{slug}",
        ))
    return out


# ─── The cookbook PDFs ─────────────────────────────────────────────────────

def page_lines(page):
    out = []
    for b in page.get_text("dict")["blocks"]:
        if b["type"] != 0:
            continue
        for l in b["lines"]:
            t = "".join(s["text"] for s in l["spans"]).strip()
            if t:
                out.append((l["bbox"][0], l["bbox"][1], l["spans"][0]["size"], t))
    return out


def big_image_rect(page):
    """The largest image drawn on the page, if it covers a real share of it."""
    best = None
    area = page.rect.width * page.rect.height
    for img in page.get_images(full=True):
        for r in page.get_image_rects(img[0]):
            a = r.width * r.height
            if a >= 0.12 * area and (best is None or a > best[0]):
                best = (a, r)
    return best[1] if best else None


UNITS = {"C": ("cup", "cups"), "Tbsp": ("tablespoon", "tablespoons"), "tsp": ("teaspoon", "teaspoons"),
         "lb": ("pound", "pounds"), "oz": ("ounce", "ounces"), "qt": ("quart", "quarts")}
FRAC = {"½": "1/2", "¼": "1/4", "¾": "3/4", "⅓": "1/3", "⅔": "2/3", "⅛": "1/8"}


def plain_qty(q):
    q = q.strip()
    for k, v in FRAC.items():
        q = re.sub(r"(\d)" + k, r"\1 " + v, q).replace(k, v)
    m = re.match(r"^([\d/ .]+)\s*(C|Tbsp|tsp|lb|oz|qt)\b\.?(.*)$", q)
    if m:
        n = m.group(1).strip()
        one = n in ("1", "1/2", "1/4", "3/4", "1/3", "2/3", "1/8")
        return f"{n} {UNITS[m.group(2)][0 if one else 1]}{m.group(3)}".strip()
    return q


def parse_book(path, book):
    d = pymupdf.open(path)
    recipes, cur, section = [], None, None
    for i in range(len(d)):
        page = d[i]
        # Drop the running footer (page number, book name), which sits at the
        # bottom edge. A bare number anywhere else is a quantity or a step.
        ls = [l for l in page_lines(page)
              if not (l[1] > 540 and re.match(r"^(\d+|[ivx]+|deliciously healthy .*)$", l[3], re.I))]
        tabs = [l[3] for l in ls if l[0] >= 540 and 11 <= l[2] <= 13]
        if tabs:
            section = " / ".join(tabs)
        titles = [l for l in ls if l[2] >= 20 and l[1] < 200]
        is_divider = any(l[3].startswith("•") for l in ls)
        cont = [l for l in ls if "(continued)" in l[3]]
        photo = big_image_rect(page)
        if is_divider:
            cur = None
            continue
        has_prep = any(re.match(r"(?i)^prep time", l[3]) for l in ls)
        if titles and not cont and has_prep:
            title = " ".join(t[3] for t in sorted(titles, key=lambda t: t[1]))
            cur = dict(book=book, title=re.sub(r"\s+", " ", title).strip(), section=section,
                       pages=[i], lines=[(x, y, s, t) for x, y, s, t in ls if s < 20], photoPages=[])
            if photo:
                cur["photoPages"].append(i)
            recipes.append(cur)
        elif cont and cur:
            off = 1000 * len(cur["pages"])
            cur["pages"].append(i)
            cur["lines"] += [(x, y + off, s, t) for x, y, s, t in ls if "(continued)" not in t and s < 20]
            if photo:
                cur["photoPages"].append(i)
        elif not ls and photo:
            # A photo-only page: it faces the recipe on the next page, or, when
            # the next page is not a recipe, the one before it.
            recipes.append(dict(_photo_only=i))
    # Resolve photo-only pages to neighbours.
    real = [r for r in recipes if "_photo_only" not in r]
    starts = {r["pages"][0]: r for r in real}
    for r in recipes:
        if "_photo_only" in r:
            p = r["_photo_only"]
            tgt = starts.get(p + 1) or (starts.get(p - 1) if starts.get(p - 1) and not starts[p - 1]["photoPages"] else None)
            if tgt is not None and not tgt["photoPages"]:
                tgt["photoPages"].append(p)
    return d, [structure(r) for r in real]


def structure(r):
    L = sorted(r["lines"], key=lambda l: (l[1], l[0]))
    text = [l[3] for l in L]
    low = [t.lower() for t in text]
    out = dict(title=r["title"], book=r["book"], section=r["section"], pages=r["pages"],
               photoPage=(r["photoPages"] or [None])[0])

    def value_below(label):
        for x, y, s, t in L:
            if t.lower().startswith(label):
                rest = t[len(label):].strip(" :\t")
                if rest:
                    return rest
                beside = [l for l in L if abs(l[1] - y) < 2 and 20 < l[0] - x < 120 and not l[3].endswith(":")]
                if beside:
                    return beside[0][3]
                below = [l for l in L if abs(l[0] - x) < 6 and 0 < l[1] - y < 16]
                return below[0][3] if below else None
        return None

    out["prep"] = value_below("prep time")
    out["cook"] = value_below("cook time")
    out["yields"] = value_below("yield")
    out["serving"] = value_below("serving size")
    summary = [l for l in L if 12 <= l[2] < 20 and l[0] < 300]
    out["summary"] = " ".join(l[3] for l in summary).strip()
    if out["summary"]:
        out["summary"] = out["summary"][0].upper() + out["summary"][1:]
        if not out["summary"].endswith((".", "!", "?")):
            out["summary"] += "."

    # The bottom block (tip / yield / nutrition) ends both columns.
    stop_y = min([l[1] for l in L if re.match(r"(?i)^(tip|hint|quick tip|yield|prep time:?$|each serving)", l[3])
                  and l[1] > 120] or [99999])
    # Ingredients: the left column, above the bottom block.
    # Left-hand pages sit ~18pt further left than right-hand ones, so the
    # columns are found per recipe, not hardcoded.
    left = [l for l in L if l[0] < 230 and 9.5 <= l[2] <= 10.6 and l[1] < stop_y
            and not re.match(r"(?i)^(prep|cook) time", l[3])]
    qty_x = min([l[0] for l in left] or [0])
    ingredients, buf = [], None
    for x, y, s, t in left:
        if re.match(r"(?i)^for .+:$", t):
            if buf:
                ingredients.append(buf)
            buf = None
            continue
        if x < qty_x + 20:  # the quantity column (sometimes "qty \t item" in one line)
            if buf:
                ingredients.append(buf)
            q, _, item = t.partition("\t")
            same_row = [l for l in left if l[0] >= qty_x + 20 and abs(l[1] - y) < 2]
            item = (item.strip() + " " + " ".join(l[3] for l in same_row)).strip()
            if not item and not re.search(r"\d|[½¼¾⅓⅔⅛]", q):
                item, q = q, ""
            buf = (plain_qty(q) + " " + item).strip()
        elif buf is not None and not any(abs(l[1] - y) < 2 and l[0] < qty_x + 20 for l in left):
            buf += " " + t
    if buf:
        ingredients.append(buf)
    out["ingredients"] = [clean_line(plain_qty(i)) for i in ingredients if i.strip()]

    # Steps: the right column; a number line starts each one.
    right = [l for l in L if 230 <= l[0] < 540 and l[2] >= 7.5
             and not (l[1] < 1000 and l[1] >= stop_y) and not re.match(r"(?i)^(prep|cook) time", l[3])]
    nums = [l for l in right if re.match(r"^\d{1,2}\.?$", l[3])]
    num_x = min([l[0] for l in nums] or [0])
    steps = []
    for x, y, s, t in right:
        if re.match(r"^\d{1,2}\.?$", t) and x < num_x + 8:
            steps.append("")
        elif steps and x >= num_x + 12 and s >= 9.8:
            steps[-1] = (steps[-1] + " " + t).strip()
    out["instructions"] = [clean_line(s.replace("ºF", "°F")) for s in steps if s.strip()]

    nut = {}
    for x, y, s, t in L:
        k = t.lower().strip()
        if k in ("calories", "total fat", "protein", "carbohydrates"):
            v = [l for l in L if abs(l[1] - y) < 2 and 40 < l[0] - x < 90]
            if v:
                nut[k] = v[0][3]
    out["nutrition"] = nut
    return out


def clean_line(t):
    """Drop what only makes sense in the printed book."""
    t = re.sub(r"\((Leftover Friendly)\)", "", t, flags=re.I)
    t = re.sub(r"\(see (the )?recipe on page \d+\)", "(recipe in this collection)", t, flags=re.I)
    t = re.sub(r"\s*\((?:on )?page \d+\)", "", t)
    t = re.sub(r",?\s*(?:on )?page \d+", "", t)
    t = re.sub(r";?\s*see\s*(?=\)|$)", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    if t.count("(") > t.count(")"):
        t += ")"
    return t


SMALL = {"a", "an", "and", "or", "the", "with", "in", "of", "on", "for", "to", "at", "by"}


def title_case(t):
    """The catalog's Title Case, for the cookbooks' all-lowercase titles."""
    if t != t.lower():
        return t
    words = t.split(" ")
    return " ".join(w if (i and w in SMALL) else "-".join(p[:1].upper() + p[1:] for p in w.split("-"))
                    for i, w in enumerate(words))


# Photos that sit next to a recipe but do not show the dish, found by eye on
# the contact sheet (2026-09-28). Each is reviewed, not guessed.
NOT_THE_DISH = {
    "thai-style-chicken-curry": "a how-to shot: hands zesting a lemon",
}


def washed_out(pix):
    """A faded background graphic, not a photo: bright and nearly flat."""
    small = pymupdf.Pixmap(pix, 0) if pix.alpha else pix
    s = small.samples
    step = max(1, len(s) // 30000) * small.n
    vals = [s[i] for i in range(0, len(s) - small.n, step)]
    mean = sum(vals) / len(vals)
    var = sum((v - mean) ** 2 for v in vals) / len(vals)
    return mean > 200 and var ** 0.5 < 30


def render_photo(doc, page_index, path):
    page = doc[page_index]
    rect = big_image_rect(page)
    if rect is None:
        return None
    scale = min(3.0, 1400 / max(rect.width, rect.height))
    pix = page.get_pixmap(clip=rect, matrix=pymupdf.Matrix(scale, scale))
    if washed_out(pix):
        return None
    pix.save(path, jpg_quality=86)
    return path


# ─── Merge, map, dedupe ────────────────────────────────────────────────────

def norm(t):
    t = re.sub(r"\(.*?\)", "", t.lower())
    t = re.sub(r"[^a-z0-9 ]", " ", t)
    t = re.sub(r"\b(the|a|an|and|with)\b", " ", t)
    return " ".join(t.split())


STOP = set("cup cups tsp tbsp lb oz ounce ounces teaspoon teaspoons tablespoon tablespoons pound pounds fresh "
           "chopped rinsed minced sliced diced large small medium low fat free sodium reduced taste cooking spray "
           "salt pepper ground black water whole about into finely dried".split())


def words(xs):
    return {w for x in xs for w in re.findall(r"[a-z]+", x.lower()) if len(w) > 2 and w not in STOP}


def token(line):
    """The canonical ingredient name the catalog stores in `tokens`."""
    s = re.sub(r"\(.*?\)", "", line.lower())
    s = re.sub(r"^[\d/ .½¼¾⅓⅔⅛-]+", "", s).strip()
    s = re.sub(r"^\d*-?inch\s+", "", s)
    s = re.sub(r"^(cups?|c|tablespoons?|tbsp|teaspoons?|tsp|pounds?|lbs?|ounces?|oz|quarts?|cans?|cloves?|"
               r"slices?|pieces?|stalks?|bunch|heads?|bags?|packages?|pkg|sprigs?|dash|pinch|large|medium|small)\b\.?\s*", "", s)
    s = s.split(",")[0].split(" or ")[0]
    s = re.sub(r"\b(fresh|ground|dried|low-sodium|reduced-sodium|fat-free|nonfat|lowfat|low-fat|lite|"
               r"boneless|skinless|chopped|minced|sliced|diced|rinsed|canned|frozen|uncooked|cooked)\b", " ", s)
    return " ".join(s.split())


def minutes(v):
    if not v:
        return 0
    v = v.lower()
    h = re.search(r"(\d+)\s*hour", v)
    m = re.search(r"(\d+)\s*min", v)
    return (int(h.group(1)) * 60 if h else 0) + (int(m.group(1)) if m else 0)


def num(v):
    m = re.search(r"[\d.]+", v or "")
    return round(float(m.group(0))) if m else None


def catalog():
    rows, offset = [], 0
    while True:
        body = json.dumps({"action": "catalog", "limit": 500, "offset": offset})
        r = subprocess.run(["curl", "-sS", "-X", "POST", RECIPES_DB, "-H", "content-type: application/json", "-d", body],
                           capture_output=True, text=True)
        batch = json.loads(r.stdout).get("recipes", [])
        rows += batch
        if len(batch) < 500:
            return rows
        offset += len(batch)


def main():
    os.makedirs(PHOTOS, exist_ok=True)
    web = web_recipes()
    print(f"[nhlbi] web: {len(web)} recipes", file=sys.stderr)
    book_recs, docs = [], {}
    for code, name in BOOKS:
        pdf = curl(f"{SITE}/sites/default/files/publications/{code}.pdf", os.path.join(CACHE, code + ".pdf"))
        doc, recs = parse_book(pdf, name)
        docs[name] = (doc, code)
        for r in recs:
            r["pdfUrl"] = f"{SITE}/sites/default/files/publications/{code}.pdf#page={r['pages'][0] + 1}"
        book_recs += recs
        print(f"[nhlbi] {name}: {len(recs)} recipes, {sum(1 for r in recs if r['photoPage'] is not None)} with a photo",
              file=sys.stderr)

    by_title = {norm(r["title"]): r for r in book_recs}
    merged = []
    for w in web:
        b = by_title.pop(norm(w["title"]), None)
        merged.append(dict(w, book=w["book"] or (b and b["book"]), section=b and b["section"],
                           photoPage=b and b["photoPage"], photoBook=b and b["book"]))
    for b in by_title.values():
        slug = re.sub(r"[^a-z0-9]+", "-", b["title"].lower()).strip("-")
        merged.append(dict(b, slug=slug, title=title_case(b["title"]),
                           sourceUrl=b["pdfUrl"], photoBook=b["book"]))

    cat = catalog()
    cat_titles = {norm(c["title"]): c["title"] for c in cat}
    cat_words = [(c["title"], words(c.get("tokens") or [])) for c in cat]
    kept, dropped, seen = [], [], set()
    for r in merged:
        n = norm(r["title"])
        if not r.get("ingredients") or not r.get("instructions"):
            dropped.append((r["title"], "unparsed"))
            continue
        if n in seen:
            dropped.append((r["title"], "repeat within NHLBI"))
            continue
        if n in cat_titles:
            dropped.append((r["title"], f"in catalog: {cat_titles[n]}"))
            continue
        rw = words(r["ingredients"])
        near = [t for t, cw in cat_words
                if len(rw & cw) / max(1, len(rw | cw)) >= 0.5
                and len(set(n.split()) & set(norm(t).split())) / max(1, len(n.split())) >= 0.5]
        if near:
            dropped.append((r["title"], f"same dish in catalog: {near[0]}"))
            continue
        seen.add(n)
        kept.append(r)

    photos = 0
    out = []
    for r in kept:
        # The title's head noun wins, then the cookbook section, then
        # Dinner. Web-only recipes have no section at all.
        head = head_noun(r["title"])
        category = next((c for rx, c in HEAD_CATEGORY if re.fullmatch(rx, head)), None)
        if category is None:
            category = next((c for rx, c in SECTION_CATEGORY
                             if r.get("section") and re.search(rx, r["section"], re.I)), "Dinner")
        photo = None
        if r.get("photoPage") is not None and r["slug"] not in NOT_THE_DISH:
            doc, code = docs[r["photoBook"]]
            path = os.path.join(PHOTOS, r["slug"] + ".jpg")
            if render_photo(doc, r["photoPage"], path):
                photo = os.path.relpath(path, HERE)
                photos += 1
        total = minutes(r.get("prep")) + minutes(r.get("cook"))
        steps, ings = len(r["instructions"]), len(r["ingredients"])
        difficulty = "easy" if steps <= 5 and ings <= 8 and total <= 30 else ("hard" if steps >= 10 or total > 90 else "medium")
        nut = r.get("nutrition") or {}
        out.append(dict(
            slug=r["slug"], title=r["title"], summary=r.get("summary") or None, category=category,
            difficulty=difficulty, cookTime=total, servings=num(r.get("yields")) or 4,
            ingredients=r["ingredients"], instructions=r["instructions"],
            tokens=[t for t in dict.fromkeys(token(i) for i in r["ingredients"]) if t],
            nutrition={k: v for k, v in dict(calories=num(nut.get("calories")), fat=num(nut.get("total fat")),
                                             protein=num(nut.get("protein")), carbs=num(nut.get("carbohydrates"))).items()
                       if v is not None} or None,
            sourceUrl=r["sourceUrl"], book=r.get("book"), photo=photo,
            photoPage=(r["photoPage"] + 1) if r.get("photoPage") is not None else None,
            imageCredit=PHOTO_CREDIT if photo else None,
        ))

    out.sort(key=lambda r: r["slug"])
    summary = dict(web=len(web), cookbooks=len(book_recs), merged=len(merged), new=len(out), withPhoto=photos,
                   dropped=len(dropped))
    json.dump(dict(generated=__import__("time").strftime("%Y-%m-%d"), summary=summary,
                   dropped=[dict(title=t, why=w) for t, w in dropped], recipes=out),
              open(OUT, "w"), indent=1, ensure_ascii=False)
    print(f"[nhlbi] {json.dumps(summary)}", file=sys.stderr)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Ingest USDA MyPlate recipes from the Internet Archive's capture of myplate.gov.

WHY THE ARCHIVE and not myplate.food: the recipes are US federal works, public
domain under 17 USC 105 — but myplate.food, which mirrors them with nicer JSON,
forbids "replicating the recipe catalog into your own database" on its free
tier. The content is free; their service is not. Pulling from the archived
federal site keeps the public-domain provenance and takes on no one's terms.

Politeness: one worker, a delay between fetches, resume from cache. 1,124 pages
is not a load worth being rude about.
"""
import json, os, re, sys, time, urllib.request, urllib.error, html as htmllib

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "pages")
os.makedirs(CACHE, exist_ok=True)
UA = "ConjureOS-recipes-ingest/1.0 (public-domain USDA corpus; contact: repo owner)"
DELAY = float(os.environ.get("DELAY", "0.6"))


def get(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def slugs():
    """Every archived recipe page, newest capture wins."""
    cdx = (
        "https://web.archive.org/cdx/search/cdx?url=myplate.gov/recipes/"
        "&matchType=prefix&output=json&collapse=urlkey&filter=statuscode:200"
        "&fl=original,timestamp&limit=60000"
    )
    rows = json.loads(get(cdx, timeout=120))[1:]
    out = {}
    for u, ts in rows:
        if "?" in u:
            continue
        m = re.match(r"https?://(?:www\.)?myplate\.gov/recipes/([^/?#]+)/?$", u)
        if not m:
            continue
        s = m.group(1)
        if s not in out or ts > out[s]:
            out[s] = ts
    return out


def page(slug, ts):
    """Fetched page, cached. `id_` gives the ORIGINAL bytes without the archive's banner."""
    p = os.path.join(CACHE, f"{slug}.html")
    if os.path.exists(p) and os.path.getsize(p) > 2000:
        return open(p, encoding="utf-8", errors="replace").read()
    url = f"https://web.archive.org/web/{ts}id_/https://www.myplate.gov/recipes/{slug}"
    for attempt in range(3):
        try:
            h = get(url)
            open(p, "w", encoding="utf-8").write(h)
            time.sleep(DELAY)
            return h
        except Exception as e:
            if attempt == 2:
                raise
            time.sleep(2 + attempt * 3)
    return ""


def txt(s):
    """Tags out, entities decoded, whitespace collapsed."""
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", htmllib.unescape(s)).strip()


def parse(slug, h):
    flat = re.sub(r"\s+", " ", h)
    rec = {"slug": slug, "sourceUrl": f"https://www.myplate.gov/recipes/{slug}"}

    # Metadata rides in schema.org JSON-LD; body content does not.
    ld = re.findall(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', h, re.S)
    node = {}
    for b in ld:
        try:
            d = json.loads(b)
        except Exception:
            continue
        for it in (d.get("@graph", []) if isinstance(d, dict) else []):
            if it.get("@type") == "Recipe":
                node = it
    rec["title"] = htmllib.unescape(node.get("name") or "").strip()
    rec["summary"] = htmllib.unescape(node.get("description") or "").strip() or None

    y = str(node.get("recipeYield") or "").strip()
    m = re.search(r"\d+", y)
    rec["servings"] = int(m.group(0)) if m else 0

    # Ingredients live in one or MORE <ul class="... ingredients ...">.
    #
    # Recipes with components ("For the Dressing:", "For the Salad:") emit an
    # empty first <ul> and then one <ul> per group, with a <b> label between
    # them. Reading only the first list returned zero ingredients for those —
    # 43 of 1,124, every one of them a grouped recipe, which is why the
    # failures looked systematic rather than random.
    #
    # The group label is preserved as a TRAILING parenthetical rather than a
    # prefix or a bare line: `parseIngredient` strips a trailing "(...)" before
    # tokenizing, so the cook still reads "1 cup mayonnaise (for the dressing)"
    # while the pantry matcher still sees "mayonnaise".
    ing = []
    section = ""
    for chunk in re.finditer(
        r'<b>\s*([^<]{2,60}?)\s*</b>|<ul[^>]*class="[^"]*ingredients[^"]*"[^>]*>(.*?)</ul>',
        flat, re.S,
    ):
        label, block = chunk.group(1), chunk.group(2)
        if label is not None:
            section = re.sub(r"[:\s]+$", "", txt(label)).strip()
            continue
        for li in re.findall(r"<li[^>]*>(.*?)</li>", block or "", re.S):
            t = txt(li)
            if not t:
                continue
            if section and not t.endswith(")"):
                t = f"{t} ({section.lower()})"
            ing.append(t)
    rec["ingredients"] = ing

    # Directions: the <ol>/<ul> that follows the Directions heading.
    ins = []
    md = re.search(r"<h2>\s*Directions\s*</h2>(.*?)(?:<h2>|</article>)", flat, re.S)
    if md:
        items = re.findall(r"<li[^>]*>(.*?)</li>", md.group(1), re.S)
        if items:
            ins = [txt(x) for x in items if txt(x)]
        else:
            body = txt(md.group(1))
            ins = [s.strip() for s in re.split(r"(?<=[.!?])\s+", body) if s.strip()]
    rec["instructions"] = ins

    # Macros from the nutrition table's row classes.
    def macro(cls):
        m = re.search(
            r'<tr[^>]*class="[^"]*\b' + cls + r'\b[^"]*"[^>]*>.*?<td[^>]*>.*?</td>\s*<td[^>]*>([^<]*)</td>',
            flat, re.S)
        if not m:
            return None
        n = re.search(r"[\d.]+", m.group(1))
        return round(float(n.group(0))) if n else None

    cal = node.get("nutrition", {}).get("calories")
    cal = round(float(re.search(r"[\d.]+", str(cal)).group(0))) if cal and re.search(r"[\d.]+", str(cal)) else macro("calories")
    rec["nutrition"] = {
        "calories": cal or 0,
        "protein": macro("protein") or 0,
        "fat": macro("total_fat") or 0,
        "carbs": macro("carbohydrates") or 0,
    }

    # Time is NOT on these pages. Recorded as 0 rather than invented; the UI
    # omits it when absent instead of printing a confident "0 min".
    rec["cookTime"] = 0
    return rec


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    idx = slugs()
    keys = sorted(idx)
    if limit:
        keys = keys[:limit]
    print(f"[ingest] {len(idx)} archived recipes; processing {len(keys)}", file=sys.stderr)
    out, fails = [], []
    for i, s in enumerate(keys, 1):
        try:
            r = parse(s, page(s, idx[s]))
            if r["title"] and r["ingredients"] and r["instructions"]:
                out.append(r)
            else:
                fails.append((s, f"thin: t={bool(r['title'])} i={len(r['ingredients'])} n={len(r['instructions'])}"))
        except Exception as e:
            fails.append((s, repr(e)[:90]))
        if i % 50 == 0:
            print(f"[ingest] {i}/{len(keys)} ok={len(out)} fail={len(fails)}", file=sys.stderr)
    json.dump(out, open(os.path.join(HERE, "usda.json"), "w"), indent=1)
    print(f"[ingest] DONE ok={len(out)} fail={len(fails)}", file=sys.stderr)
    for s, why in fails[:15]:
        print("   FAIL", s, why, file=sys.stderr)


if __name__ == "__main__":
    main()

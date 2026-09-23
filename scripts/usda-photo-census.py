#!/usr/bin/env python3
"""
Which MyPlate recipes may carry their photo: writes scripts/usda-photos.json.

For every catalog recipe (fetched from recipes-db's public `catalog` action),
read the Internet Archive's capture of its myplate.gov page (the live site was
retired in January 2026) and pull two things out of it: the recipe photo (the
schema.org Recipe `image`) and the page's "Source:" credit line.

A photo is listed only when the credit names a FEDERAL source — USDA or HHS
(NIH, NCI, NHLBI, CDC, FDA) — because those are US government works, public
domain. Most MyPlate recipes credit a partner instead (a state university, a
state SNAP-Ed programme, a nonprofit, an industry "MyPlate National Strategic
Partner"), and a partner may still own its photo: USDA's permission to show it
does not pass to us. Owner decision, 2026-09-23: "just use the USDA images".
The credit line says who supplied the RECIPE, not who took the photo; it is the
best signal the pages carry, not proof.

scripts/import-usda-photos.mjs then imports exactly what the JSON lists.

Polite by construction: two workers, a pause between fetches, backoff on the
Archive's frequent connection resets, and a page cache so a re-run (or a
resumed one) never refetches. Uses curl, which is on every dev machine.

    python3 scripts/usda-photo-census.py              # writes scripts/usda-photos.json
    PAGES=/some/cache python3 scripts/usda-photo-census.py
"""
import html as htmllib
import json
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
PAGES = os.environ.get("PAGES") or os.path.join(HERE, ".cache", "usda-pages")
OUT = os.path.join(HERE, "usda-photos.json")
RECIPES_DB = os.environ.get(
    "RECIPES_DB", "https://mqpvjlsywrptefgwuztn.supabase.co/functions/v1/recipes-db"
)

FEDERAL = re.compile(
    r"\bUSDA\b|\bU\.?S\.? Department of (?:Agriculture|Health and Human Services)"
    r"|National Heart, Lung, and Blood Institute|National Cancer Institute|\bNCI\b"
    r"|National Institutes of Health|Centers for Disease Control|Food and Drug Administration"
)
# Federally FUNDED is not federally MADE: SNAP-Ed is run by states and
# universities, and Strategic Partners are companies and trade bodies.
NOT_FEDERAL = re.compile(r"SNAP-Ed|MyPlate National Strategic Partner", re.I)


def is_federal(credit):
    return bool(credit) and bool(FEDERAL.search(credit)) and not NOT_FEDERAL.search(credit)


def curl(args):
    return subprocess.run(["curl", "-sS", "-L", "-m", "90", *args], capture_output=True, text=True)


def catalog():
    rows, offset = [], 0
    while True:
        body = json.dumps({"action": "catalog", "limit": 500, "offset": offset})
        r = curl(["-X", "POST", RECIPES_DB, "-H", "content-type: application/json", "-d", body])
        batch = json.loads(r.stdout).get("recipes", [])
        rows += batch
        if len(batch) < 500:
            return rows
        offset += len(batch)


def page(slug):
    path = os.path.join(PAGES, slug + ".html")
    if os.path.exists(path) and os.path.getsize(path) > 2000:
        return open(path, encoding="utf-8", errors="replace").read()
    url = f"https://web.archive.org/web/2025id_/https://www.myplate.gov/recipes/{slug}"
    for attempt in range(5):
        r = curl(["-o", path, "-w", "%{http_code}", url])
        if r.stdout.strip() == "200" and os.path.exists(path) and os.path.getsize(path) > 2000:
            time.sleep(0.4)
            return open(path, encoding="utf-8", errors="replace").read()
        time.sleep(2 + attempt * 4)
    return None


def text(s):
    return re.sub(r"\s+", " ", htmllib.unescape(re.sub(r"<[^>]+>", " ", s))).strip()


def parse(h):
    image = None
    for block in re.findall(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', h, re.S):
        try:
            data = json.loads(block)
        except Exception:
            continue
        for node in data.get("@graph", []) if isinstance(data, dict) else []:
            if node.get("@type") == "Recipe":
                im = node.get("image")
                if isinstance(im, dict):
                    image = im.get("url")
                elif isinstance(im, list) and im:
                    image = im[0] if isinstance(im[0], str) else im[0].get("url")
                elif isinstance(im, str):
                    image = im
    m = re.search(r"Source:\s*(.*?)</div>", re.sub(r"\s+", " ", h))
    return image, (text(m.group(1))[:300] if m else None)


def one(row):
    m = re.match(r"https://www\.myplate\.gov/recipes/([^/?#]+)", row.get("sourceUrl") or "")
    if not m:
        return {"title": row["title"], "error": "no myplate source"}
    slug = m.group(1)
    h = page(slug)
    if h is None:
        return {"slug": slug, "title": row["title"], "error": "archive fetch failed"}
    image, credit = parse(h)
    return {"slug": slug, "title": row["title"], "sourceUrl": row["sourceUrl"], "image": image, "credit": credit}


def main():
    os.makedirs(PAGES, exist_ok=True)
    rows = catalog()
    print(f"[census] {len(rows)} catalog recipes", file=sys.stderr)
    results = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        for i, r in enumerate(pool.map(one, rows), 1):
            results.append(r)
            if i % 50 == 0:
                print(f"[census] {i}/{len(rows)}", file=sys.stderr)
    failed = [r for r in results if "error" in r]
    ok = [r for r in results if "error" not in r]
    photos = [
        {
            "slug": r["slug"],
            "title": r["title"],
            "sourceUrl": r["sourceUrl"],
            "credit": r["credit"],
            "archivedImage": "https://web.archive.org/web/2025id_/" + r["image"],
        }
        for r in ok
        if r["image"] and is_federal(r["credit"])
    ]
    photos.sort(key=lambda p: p["slug"])
    summary = {
        "catalog": len(rows),
        "pagesRead": len(ok),
        "withPhoto": sum(1 for r in ok if r["image"]),
        "federalCreditWithPhoto": len(photos),
        "unreadable": sorted(r.get("slug", r["title"]) for r in failed),
    }
    json.dump({"generated": time.strftime("%Y-%m-%d"), "summary": summary, "photos": photos},
              open(OUT, "w"), indent=1, ensure_ascii=False)
    print(f"[census] {json.dumps(summary)[:400]}", file=sys.stderr)
    if failed:
        print(f"[census] {len(failed)} page(s) unreadable; re-run to retry them (cached pages are kept)",
              file=sys.stderr)


if __name__ == "__main__":
    main()

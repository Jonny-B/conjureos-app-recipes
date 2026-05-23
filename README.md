# Recipes — an app for ConjureOS

Point your phone camera at the inside of your fridge. Get three recipes you can actually make tonight.

The first Phase 12a anchor app for [ConjureOS](https://github.com/Jonny-B/ConjureOS). Built as a standalone Vite + React + TypeScript project, imported into ConjureOS via the Phase 8 bundler.

## How it works

1. **Capture** — phone camera or photo upload of your fridge interior.
2. **Identify** — Claude (Sonnet on BYK, Haiku on hosted free tier) returns a JSON list of visible ingredients with confidence scores. Low-confidence items render as "is this here?" prompts.
3. **Confirm** — you edit the list: add what the model missed, remove false positives, dismiss low-confidence guesses.
4. **Generate** — second AI call returns three recipes with varied difficulty (easy / medium / hard), constrained to your confirmed ingredients plus 1-2 common pantry additions.
5. **Save** — selected recipes land in `/home/Documents/Recipes/<slug>.md` as markdown with YAML frontmatter (title, difficulty, cookTime, date, ingredients, source). Browseable in ConjureOS's Files app or with any markdown editor.

## Permissions

Declared in `package.json` under `conjureos.permissions`:

- `ai.complete` — multimodal vision call + recipe generation
- `vfs.read` — list previously saved recipes
- `vfs.write` — save new recipes to `/home/Documents/Recipes/` + cache nutrition lookups

## Nutrition data (USDA FoodData Central)

Each generated recipe gets a per-serving macros strip (`~520 cal · 32g P · 18g F · 48g C · est.`) from the [USDA FoodData Central API](https://fdc.nal.usda.gov/api-guide.html). Ingredient quantities are parsed locally, looked up against FDC's `Foundation` + `SR Legacy` datasets, and aggregated. Cached to the app's VFS folder so repeat ingredients (eggs, olive oil, garlic) only hit the network once per user, ever.

**The bundled build ships with `DEMO_KEY`** — usable out of the box but rate-limited to 30 requests/hour per IP. The aggressive cache means most users won't hit the limit after their first few cooks. If you want the full 1000 req/hour limit:

1. Get a free key at [api.data.gov/signup](https://api.data.gov/signup/) (instant).
2. Set `VITE_USDA_API_KEY=your-key` in a `.env` file at the project root.
3. `npm run build` — the key gets baked into the bundle. ZIP and re-import.

Accuracy is ~±25-40% on totals — fine for "should I cook this?" but not medical-grade. The strip displays `rough` instead of `est.` when fewer than 70% of ingredients matched.

## Development

```bash
npm install
npm run dev
```

The dev server runs the UI but mocks the AI and VFS bridges (they only exist inside ConjureOS). For full-fidelity testing, build a ZIP and import it into ConjureOS.

## Import into ConjureOS

```bash
npm run build
# zip the dist/ directory
# in ConjureOS: launcher → Import project… → drop the ZIP
```

The Phase 8 bundler handles the ingest. Author + repository fields from `package.json` surface on the installed app's manifest.

## License

MIT — see [LICENSE](LICENSE).

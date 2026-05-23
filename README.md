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
- `vfs.write` — save new recipes to `/home/Documents/Recipes/`

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

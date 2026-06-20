/**
 * build-bundle.mjs: build this app into the single store-ready HTML using
 * ConjureOS's real @bundle pipeline (esbuild + jspm importmap, via
 * @conjureos/pack), the EXACT path the App Store publish uses.
 *
 * `conj-pack dev` is an esbuild dev server with mocked bridges; it does NOT
 * exercise this pipeline, so bundle-time / runtime differences (JSON imports,
 * encoding, externalized deps, srcdoc execution) slip past it. Run this and
 * smoke-test the output BEFORE publishing:
 *
 *   npm run build
 *   then open dist/recipes.html in a browser and check the console.
 *
 * Mirrors ConjureOS scripts/bundle-app.ts so local output matches CI output.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@conjureos/pack/node";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, "dist", "recipes.html");

const STRIP = new Set(["node_modules", "dist", ".git", ".github", ".vscode", ".cache", ".devserve"]);
const BINARY = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".eot",
]);

function walk(root, dir, files) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = relative(root, abs).split(sep).join("/");
    if (rel.split("/").some((s) => STRIP.has(s))) continue;
    if (name.endsWith(".conj")) continue;
    const st = statSync(abs);
    if (st.isDirectory()) {
      walk(root, abs, files);
      continue;
    }
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
    files[rel] = BINARY.has(ext)
      ? new Uint8Array(readFileSync(abs))
      : readFileSync(abs, "utf8");
  }
}

const files = {};
walk(ROOT, ROOT, files);
console.log(`[build] ${Object.keys(files).length} source files`);
const result = await bundle(files, { projectName: "Recipes" });
for (const w of result.warnings ?? []) console.warn(`[build] warning: ${w.text}`);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, result.html);
console.log(`[build] wrote ${OUT} (${(result.html.length / 1024 / 1024).toFixed(2)} MB)`);

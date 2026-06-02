import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { readFileSync } from "node:fs";

// Inject the package.json version at build time so the running app can
// display it in the Info popover. Read once at config-load; bump `version`
// in package.json before building to see the new value in-app.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const APP_VERSION = pkg.version as string;

// Two build outputs from the same source:
//   - `npm run build`        → dist/index.html, JS + CSS as separate files.
//                              Standard Vite output. What the Phase 8
//                              bundler ingests when this app is imported
//                              via ZIP at runtime.
//   - `npm run build:inline` → dist/index.html, fully self-contained
//                              (JS + CSS inlined into one HTML file).
//                              What ConjureOS embeds as a DEFAULT_APPS
//                              entry — the kernel's srcdoc iframe needs
//                              one HTML string with everything inside.
//
// The split lives in a Vite mode flag so the two builds don't clobber
// each other's settings. `vite build --mode inline` activates the
// single-file path.
export default defineConfig(({ mode }) => {
  const inline = mode === "inline";
  return {
    define: {
      __APP_VERSION__: JSON.stringify(APP_VERSION),
    },
    plugins: [
      react(),
      // Only active in inline mode. Walks <link rel="stylesheet"> and
      // <script src> in the built HTML and inlines their contents.
      ...(inline ? [viteSingleFile()] : []),
    ],
    server: {
      port: 5180,
      strictPort: false,
    },
    build: {
      target: "es2022",
      // Never minify: ConjureOS lets users (and the in-OS AI) view + modify
      // installed app source, so the published build must stay readable.
      minify: false,
      // Sourcemaps make sense in the separate-files build (dev / debug)
      // but bloat the inline output by 2-3× with no upside (the embedded
      // HTML doesn't get served as a static asset; it's a string
      // constant inside the ConjureOS bundle).
      sourcemap: !inline,
      // Inline-build hints. Defaults are fine when not inlining.
      ...(inline
        ? {
            assetsInlineLimit: 100_000_000, // inline every asset regardless of size
            cssCodeSplit: false,
            rollupOptions: {
              output: {
                inlineDynamicImports: true,
              },
            },
          }
        : {}),
    },
  };
});

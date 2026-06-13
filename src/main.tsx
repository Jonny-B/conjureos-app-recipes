import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// ConjureOS "Modern Whimsy" design tokens + primitives. Imported first so the
// --cui-* tokens are defined before styles.css re-points the app's own
// variables at them. This is a VENDORED copy of @conjureos/ui's dist/ui.css
// (a CSS-only package), imported by RELATIVE path on purpose: ConjureOS's
// @bundle externalizes every BARE import to the jspm ESM CDN, which can't serve
// a CSS-only package — a relative import gets inlined into the bundle instead.
// Re-sync from the @conjureos/ui devDependency when its tokens change:
//   node node_modules/@conjureos/ui/scripts/build.mjs
//   cp node_modules/@conjureos/ui/dist/ui.css src/conjureos-ui.css
import "./conjureos-ui.css";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

// Activate the Modern Whimsy tokens. They're scoped to `.cui-ui`, and the whole
// app's palette resolves through that class being on <body>. Local `conj-pack
// dev` gets it from index.html, but ConjureOS @bundle generates its own HTML
// shell and drops the body class — so set it at runtime so the bundled build
// picks up the tokens too. Without this, every var(--cui-*) is undefined and
// the app renders unstyled (black text, no backgrounds).
document.body.classList.add("cui-ui");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

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
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

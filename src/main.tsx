import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// ConjureOS "Modern Whimsy" design tokens + primitives. Imported first so the
// --cui-* tokens are defined before styles.css re-points the app's own
// variables at them. Self-contained in the bundle (the standalone/bundler
// consumption path) so the app looks like ConjureOS without the shell URL.
import "@conjureos/ui/dist/ui.css";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

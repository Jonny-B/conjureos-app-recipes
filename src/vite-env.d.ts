/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The USDA proxy endpoint, baked in at build time. Non-secret — just a
   *  function URL. REQUIRED for any production build (build / build:inline):
   *  if unset, nutrition disables itself rather than defaulting to a hardcoded
   *  environment. The local Vite dev server falls back to the dev project.
   *  See resolveProxyUrl in features/nutrition.ts. */
  readonly VITE_USDA_PROXY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Injected at build time by `define` in vite.config.ts. Stringified
 *  `version` from package.json. Available in any module without import. */
declare const __APP_VERSION__: string;

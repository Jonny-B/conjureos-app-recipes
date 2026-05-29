/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Override the USDA proxy endpoint at build time (e.g. point at the
   *  prod ConjureOS project). Defaults to the dev project in nutrition.ts.
   *  Non-secret — it's just a function URL. */
  readonly VITE_USDA_PROXY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Injected at build time by `define` in vite.config.ts. Stringified
 *  `version` from package.json. Available in any module without import. */
declare const __APP_VERSION__: string;

/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_USDA_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Injected at build time by `define` in vite.config.ts. Stringified
 *  `version` from package.json. Available in any module without import. */
declare const __APP_VERSION__: string;

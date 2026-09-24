// Image imports. Both bundlers (conj-pack dev and the store's bundle()) load
// these as data: URLs, so the default export is a string usable as a src or
// in a CSS url(). The store bundle inlines assets up to 256 KB; past that it
// splits them out to a separate file this app's single-HTML publish drops, so
// keep every image well under it.
declare module "*.webp" {
  const src: string;
  export default src;
}

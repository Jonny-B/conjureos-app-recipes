/**
 * "Save to my recipes" copies a catalog recipe into the library, so on the All
 * list the same dish would show twice. The saved copy has no link back to the
 * catalog row, so the match is the one the open recipe already uses for "In
 * your recipes": the title, ignoring case. Only the catalog twin is dropped.
 */
export function withoutSavedTwins<T extends { title: string }>(catalog: T[], saved: { title: string }[]): T[] {
  if (saved.length === 0) return catalog;
  const have = new Set(saved.map((s) => s.title.trim().toLowerCase()));
  return catalog.filter((c) => !have.has(c.title.trim().toLowerCase()));
}

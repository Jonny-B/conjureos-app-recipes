/**
 * Recipes hidden this session because their author was blocked. The server
 * leaves a blocked author out of chefFeed and getShared on the next read; this
 * set makes the recipe on screen go at once, before any read comes back.
 */
const hidden = new Set<string>();

export function hideRecipe(id: string): void {
  hidden.add(id);
}

export function isRecipeHidden(id: string): boolean {
  return hidden.has(id);
}

/** Drop the hidden ids (after an unblock, so the next read can show them). */
export function clearHiddenRecipes(): void {
  hidden.clear();
}

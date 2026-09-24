/**
 * Swap ONE meal in a week plan, and nothing else (ConjureOS #620).
 *
 * The planner is asked to keep every other meal (`pinnedIds`), but the list the
 * user sees is not left to the server's say-so: a pin it drops (a keeper that
 * now fails an avoid rule, a saved recipe whose tokens came back empty) or a
 * response that ignores the pins entirely would otherwise replace meals the
 * user never rejected. So the keepers are taken from the plan on screen, and
 * the response contributes at most one new meal, placed in the slot the
 * rejected one held.
 */
export function spliceReroll<T extends { id: string }>(
  previous: readonly T[],
  rejectedId: string,
  returned: readonly T[],
): T[] {
  const at = previous.findIndex((p) => p.id === rejectedId);
  const keep = previous.filter((p) => p.id !== rejectedId);
  const keepIds = new Set(keep.map((k) => k.id));
  const fresh = returned.find((r) => r.id !== rejectedId && !keepIds.has(r.id));
  if (fresh) keep.splice(at < 0 ? keep.length : at, 0, fresh);
  return keep;
}

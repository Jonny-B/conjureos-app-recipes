import { serverErrorCode } from "./refusal";

/**
 * What a person reads when something failed. The kernel carries a remote
 * action's non-2xx body inside the Error message ("Remote action failed
 * (HTTP 413): {"error":"image_quota_exceeded"}"), which is for the console,
 * not the screen. Our own sentences (no status, no JSON) pass through as they
 * are; the raw text goes to the console.
 */
const BY_CODE: Record<string, string> = {
  banned: "Your access to Recipes has been removed.",
  image_quota_exceeded: "You have reached your photo limit. Remove a photo or try again later.",
  terms_required: "Accept the Recipes terms first, then try again.",
  not_found: "That recipe is not available any more.",
  rate_limited: "That was too many tries in a short time. Try again in a minute.",
  too_many_reports: "You have sent a lot of reports in a short time. Try again later.",
  too_many_blocked: "Your block list is full. Unblock someone first.",
};

const GENERIC = "Something went wrong. Try again.";

export function plainError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  const code = serverErrorCode(e);
  const looksRaw = /HTTP\s*\d{3}|Remote action failed|[{}]|"error"|^TypeError|Failed to fetch|NetworkError|unknown_action/i.test(raw);
  if (!looksRaw && raw.trim()) return raw;
  try {
    console.warn("[recipes] request failed:", raw);
  } catch {
    /* no console */
  }
  if (code && BY_CODE[code]) return BY_CODE[code]!;
  if (/Failed to fetch|NetworkError/i.test(raw)) return "Could not reach Recipes. Check your connection and try again.";
  const status = /HTTP\s*(\d{3})/i.exec(raw)?.[1];
  if (status === "401") return "Sign in to ConjureOS to do that.";
  if (status === "403") return "You are not allowed to do that.";
  if (status === "413") return "That file is too large. Try a smaller one.";
  if (status === "429") return BY_CODE.rate_limited!;
  return GENERIC;
}

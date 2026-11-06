/**
 * What recipes-db says when it will not take a piece of content (ConjureOS
 * Phase 68). Two 422 bodies:
 *
 *   { error: "text_not_allowed", field, term, code, message }
 *   { error: "image_not_allowed", field: "imageUrl", message }
 *
 * `message` is finished copy and is shown as is. The kernel carries a remote
 * action's non-2xx body inside the Error message as
 * "Remote action failed (HTTP 422): <body cut at 200 characters>", so a long
 * message can arrive cut. When the body will not parse whole, the line is
 * rebuilt here from the field, and it still ends with the support line.
 */

export const SUPPORT_LINE = "Think this is a mistake? Write to support@conjureos.com.";
const IMAGE_LINE = "Upload the picture from your device or camera instead of linking to it.";

/** What each server field is called to a person. */
const FIELD_WORD: Record<string, string> = {
  title: "title",
  summary: "summary",
  category: "category",
  tags: "tags",
  ingredients: "ingredients",
  instructions: "steps",
  blog: "story",
  displayName: "name",
  bio: "bio",
  username: "username",
};

/** The line for a refusal whose message did not arrive whole. */
export function fallbackLine(field: string, kind: "text" | "image"): string {
  if (kind === "image") return IMAGE_LINE;
  const word = FIELD_WORD[field] ?? "text";
  return `Something in the ${word} is not allowed here. Change it and try again. ${SUPPORT_LINE}`;
}

export class RecipeRefusal extends Error {
  readonly field: string;
  readonly term: string | undefined;
  readonly code: string | undefined;
  readonly kind: "text" | "image";
  /** The plain line to show beside the field. Same as `message`. */
  readonly line: string;
  constructor(field: string, line: string, kind: "text" | "image", term?: string, code?: string) {
    super(line);
    this.name = "RecipeRefusal";
    this.field = field;
    this.line = line;
    this.kind = kind;
    this.term = term;
    this.code = code;
  }
}

function bodyText(err: unknown): string {
  const e = err as { message?: unknown; body?: unknown } | null;
  if (e && typeof e.body === "object" && e.body) return JSON.stringify(e.body);
  const m = typeof e?.message === "string" ? e.message : typeof err === "string" ? err : "";
  const i = m.indexOf("{");
  return i >= 0 ? m.slice(i) : "";
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** The refusal an error carries, or null when it is some other failure. */
export function refusalFrom(err: unknown): RecipeRefusal | null {
  if (err instanceof RecipeRefusal) return err;
  const text = bodyText(err);
  if (!text) return null;
  let kindWord: string | undefined;
  let field: string | undefined;
  let term: string | undefined;
  let code: string | undefined;
  let message: string | undefined;
  try {
    const b = JSON.parse(text) as Record<string, unknown>;
    kindWord = str(b.error);
    field = str(b.field);
    term = str(b.term);
    code = str(b.code);
    message = str(b.message);
  } catch {
    // Cut mid-body: read what is whole.
    kindWord = /"error"\s*:\s*"([a-z_]+)"/.exec(text)?.[1];
    field = /"field"\s*:\s*"([A-Za-z]+)"/.exec(text)?.[1];
    code = /"code"\s*:\s*"([a-z]+)"/.exec(text)?.[1];
    const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
    if (m) {
      try {
        message = JSON.parse(`"${m}"`) as string;
      } catch {
        message = undefined;
      }
    }
  }
  if (kindWord !== "text_not_allowed" && kindWord !== "image_not_allowed") return null;
  const kind = kindWord === "image_not_allowed" ? "image" : "text";
  const f = field ?? (kind === "image" ? "imageUrl" : "");
  // Only a message that arrived whole (it ends with the support line, or it is
  // the photo line) is trusted; anything else is rebuilt.
  const whole = message && (kind === "image" || message.endsWith(SUPPORT_LINE)) ? message : undefined;
  return new RecipeRefusal(f, whole ?? fallbackLine(f, kind), kind, term, code);
}

/** The error code a recipes-db failure carries ("too_many_reports"), if any. */
export function serverErrorCode(err: unknown): string | null {
  const text = bodyText(err);
  const m = /"error"\s*:\s*"([a-z_]+)"/.exec(text);
  return m ? m[1]! : null;
}

/** A plain line for a failed Report. */
export function reportErrorLine(err: unknown): string {
  switch (serverErrorCode(err)) {
    case "too_many_reports":
      return "You have sent several reports in a short time. Try again later.";
    case "not_found":
      return "This recipe is not available to report.";
    case "cannot_report_self":
      return "You cannot report your own recipe.";
    case "bad_category":
      return "Pick a reason and try again.";
    case "banned":
      return "Your access to Recipes has been removed.";
    default:
      return "Your report could not be sent. Try again.";
  }
}

/** A plain line for a failed Block or Unblock. */
export function blockErrorLine(err: unknown): string {
  switch (serverErrorCode(err)) {
    case "cannot_block_self":
      return "You cannot block yourself.";
    case "too_many_blocked":
      return "Your blocked list is full. Unblock someone first.";
    case "not_found":
      return "This author is not available to block.";
    default:
      return "That did not go through. Try again.";
  }
}

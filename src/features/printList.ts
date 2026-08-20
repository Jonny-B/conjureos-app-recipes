/**
 * Printing the shopping list.
 *
 * Rather than restyling the live app for `@media print` — which means fighting
 * a dark theme, hiding chrome one selector at a time, and hoping no future
 * layout change leaks onto the page — this builds a small, purpose-made
 * document and prints THAT. Full control, no leakage, and what you see in the
 * print preview is a paper shopping list rather than a screenshot of an app.
 *
 * Mechanically: the doc goes into an offscreen `srcdoc` iframe and we call
 * `print()` on it. That works inside the ConjureOS app sandbox because the
 * sandbox carries `allow-same-origin` (so we can reach `contentWindow`) and
 * `allow-modals` (so `print()` isn't blocked); a nested frame inherits both.
 * Anywhere that doesn't hold — an embedder with tighter flags, or a WebView
 * with no print support — we fall back to `window.print()`, which the app's
 * `@media print` rules still handle acceptably.
 */

export interface PrintItem {
  name: string;
  quantity?: string;
  quantityNote?: string;
  /** Already in the cart — printed struck through, not dropped. */
  checked?: boolean;
}

export interface PrintGroup {
  aisleName: string;
  items: PrintItem[];
}

export interface PrintListOptions {
  /** Aisle-grouped items, already in walking order. */
  groups: PrintGroup[];
  /** Meal titles, printed as a short reference block under the list. */
  meals: string[];
  /** Plan date, pre-formatted for display. */
  dateLabel: string;
  /** Family name when the plan is shared, else null. */
  familyName?: string | null;
  /** Store the list was grouped for. */
  storeName?: string | null;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );

/**
 * Deliberately plain: black on white, generous tick boxes, two columns on
 * anything wider than a phone-sized sheet. `break-inside: avoid` keeps an
 * aisle's heading from being orphaned at the foot of a page.
 */
const STYLES = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 12pt; line-height: 1.35; padding: 0;
  }
  header { border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 14px; }
  h1 { font-size: 17pt; margin: 0 0 3px; }
  .sub { font-size: 9.5pt; color: #444; }
  .cols { column-count: 2; column-gap: 26px; }
  @media (max-width: 500px) { .cols { column-count: 1; } }
  .group { break-inside: avoid; page-break-inside: avoid; margin: 0 0 12px; }
  .group h2 {
    font-size: 9.5pt; text-transform: uppercase; letter-spacing: 0.07em;
    margin: 0 0 5px; padding-bottom: 2px; border-bottom: 1px solid #999;
  }
  ul { list-style: none; margin: 0; padding: 0; }
  li {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 3px 0; break-inside: avoid; page-break-inside: avoid;
  }
  .box {
    flex: 0 0 auto; width: 12px; height: 12px; margin-top: 3px;
    border: 1.4px solid #000; border-radius: 2px;
  }
  .name { font-size: 11pt; }
  .qty { font-size: 9pt; color: #555; margin-left: 5px; white-space: nowrap; }
  li.done .name { text-decoration: line-through; color: #666; }
  li.done .box { background: #000; }
  .meals { margin-top: 8px; border-top: 1px solid #999; padding-top: 8px; break-inside: avoid; }
  .meals h2 {
    font-size: 9.5pt; text-transform: uppercase; letter-spacing: 0.07em; margin: 0 0 4px;
  }
  .meals p { margin: 0; font-size: 10pt; color: #333; }
  .empty { font-size: 11pt; color: #444; }
  @page { margin: 14mm; }
  @media print { html, body { width: 100%; } }
`;

const renderGroup = (g: PrintGroup): string => `
  <section class="group">
    <h2>${esc(g.aisleName)}</h2>
    <ul>
      ${g.items
        .map((it) => {
          const qty = [it.quantity, it.quantityNote].filter(Boolean).join(" · ");
          return `<li class="${it.checked ? "done" : ""}">
            <span class="box"></span>
            <span><span class="name">${esc(it.name)}</span>${
              qty ? `<span class="qty">${esc(qty)}</span>` : ""
            }</span>
          </li>`;
        })
        .join("")}
    </ul>
  </section>`;

/** The standalone print document, as HTML. Exported so it can be rendered and
 * checked on its own — the print dialog itself isn't scriptable. */
export const buildPrintDocument = (o: PrintListOptions): string => {
  const count = o.groups.reduce((n, g) => n + g.items.length, 0);
  const subParts = [
    o.dateLabel,
    `${count} item${count === 1 ? "" : "s"}`,
    o.storeName || null,
    o.familyName || null,
  ].filter(Boolean) as string[];

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shopping list — ${esc(o.dateLabel)}</title>
<style>${STYLES}</style></head>
<body>
  <header>
    <h1>Shopping list</h1>
    <div class="sub">${esc(subParts.join(" · "))}</div>
  </header>
  ${
    count === 0
      ? `<p class="empty">Nothing to buy — this week is covered by what you already have.</p>`
      : `<div class="cols">${o.groups.filter((g) => g.items.length > 0).map(renderGroup).join("")}</div>`
  }
  ${
    o.meals.length > 0
      ? `<div class="meals"><h2>This week's meals</h2><p>${esc(o.meals.join(" · "))}</p></div>`
      : ""
  }
</body></html>`;
};

/**
 * Open the print dialog on a freshly built shopping list. Resolves once the
 * dialog has been handed off (printing itself is the browser's business).
 */
export function printShoppingList(options: PrintListOptions): void {
  const html = buildPrintDocument(options);

  let frame: HTMLIFrameElement | null = null;
  const cleanup = () => {
    if (frame) {
      frame.remove();
      frame = null;
    }
  };

  try {
    frame = document.createElement("iframe");
    // Offscreen rather than display:none — a zero-size/hidden frame is treated
    // as having no layout by some engines, which can print a blank page.
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText =
      "position:fixed;right:0;bottom:0;width:210mm;height:297mm;border:0;opacity:0;pointer-events:none;";
    frame.srcdoc = html;

    frame.onload = () => {
      const win = frame?.contentWindow;
      if (!win) {
        cleanup();
        window.print();
        return;
      }
      try {
        // Tear down once the dialog closes; the timeout covers browsers that
        // never fire afterprint (older WebKit) so the frame can't accumulate.
        win.addEventListener("afterprint", cleanup, { once: true });
        window.setTimeout(cleanup, 60_000);
        win.focus();
        win.print();
      } catch {
        cleanup();
        window.print();
      }
    };

    document.body.append(frame);
  } catch {
    cleanup();
    window.print();
  }
}

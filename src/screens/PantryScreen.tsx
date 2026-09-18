/**
 * The Pantry — home, and the screen that has to say "this is not just a recipe
 * app" before you read a word of it.
 *
 * Three blocks, in the order the promise makes sense:
 *
 *   1. SCAN. Camera-first, not a text field. Two buttons rather than one, and
 *      the difference is real: whichever you press becomes the fallback
 *      location for anything the vision pass could not place from the scene.
 *   2. USE THESE UP. What is closest to being thrown out, soonest first, each
 *      one a door into the planner pre-seeded with it. This is the waste
 *      reduction the app is actually for; everything else is packaging.
 *   3. WHAT YOU HAVE. Grouped by where it is kept, square rows, hairline
 *      dividers, and every row editable — amount, location, use-by date.
 *
 * A scan NEVER writes straight through. Results land in a review sheet where
 * every line can be corrected or dropped first, because AI that cannot be
 * corrected reads as a gimmick the first time it is wrong.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type {
  CapturedPhoto,
  Ingredient,
  PantryItem,
  PantryLocation,
  Recipe,
  SavedRecipe,
} from "../types";
import {
  addPantryItem,
  addPantryItems,
  updatePantryItem,
  removePantryItem,
  ingredientsFromPantry,
} from "../features/pantry";
import { identifyIngredients } from "../features/vision";
import { generateRecipes } from "../features/recipes";
import { getCatalog, toRecipe, loadRecipeBody } from "../features/catalog";
import { computeCoverage } from "../features/scaling";
import {
  atRisk,
  byWasteRisk,
  locationOf,
  remainingFor,
  remainingLabel,
  riskOf,
  todayISO,
  type Risk,
} from "../features/shelfLife";
import { CaptureScreen } from "./CaptureScreen";
import { RecipesScreen } from "./RecipesScreen";
import { RecipeRow } from "../components/RecipeRow";
import { ResumeCook } from "../components/ResumeCook";
import { loadCookSession, type CookSession } from "../features/cookSession";
import { listSavedRecipes } from "../features/storage";
import { Icon, type IconName } from "../icons";

interface Props {
  pantry: PantryItem[] | null;
  onChange: (items: PantryItem[]) => void;
  /** Start the guided cook for a recipe (savedRecipe null — the pantry cooks catalog/AI recipes). */
  onCook?: (recipe: Recipe, saved: SavedRecipe | null) => void;
  /** Open the week planner, pre-seeded with these ingredient names. */
  onPlanWeek?: (seed?: string[]) => void;
  /** Open the recipe library. */
  onBrowse?: () => void;
  catalogVersion?: number;
}

type Mode =
  | { kind: "list" }
  | { kind: "capture"; hint: PantryLocation }
  | { kind: "identifying" }
  | { kind: "review"; hint: PantryLocation };
type Gen = { kind: "idle" } | { kind: "generating" } | { kind: "recipes"; recipes: Recipe[] };

const LOCATIONS: { id: PantryLocation; label: string; icon: IconName }[] = [
  { id: "fridge", label: "Fridge", icon: "boxes-stacked" },
  { id: "pantry", label: "Pantry", icon: "boxes-stacked" },
  { id: "freezer", label: "Freezer", icon: "boxes-stacked" },
];

export function PantryScreen({ pantry, onChange, onCook, onPlanWeek, onBrowse, catalogVersion = 0 }: Props) {
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [scanned, setScanned] = useState<Ingredient[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [gen, setGen] = useState<Gen>({ kind: "idle" });

  // Retained so a failed identify doesn't cost the user their photos — see
  // CaptureScreen's initialPhotos. Cleared on success, so the next scan starts
  // from an empty tray rather than re-offering shots already used.
  const [lastPhotos, setLastPhotos] = useState<CapturedPhoto[]>([]);

  /**
   * Re-entrancy guard for the model calls on this screen.
   *
   * The button that starts a generation swaps the screen for a spinner, so it
   * LOOKS guarded — but the swap is a state update, and two taps inside the
   * same frame both get through and both bill a request. A ref settles it
   * synchronously, which is the property state can't offer here.
   */
  const aiInFlight = useRef(false);

  const onScanned = async (photos: CapturedPhoto[], hint: PantryLocation) => {
    if (aiInFlight.current) return;
    aiInFlight.current = true;
    setError(null);
    setLastPhotos(photos);
    setMode({ kind: "identifying" });
    try {
      const items = await identifyIngredients(photos);
      setScanned(items);
      setLastPhotos([]);
      setMode({ kind: "review", hint });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMode({ kind: "capture", hint });
    } finally {
      aiInFlight.current = false;
    }
  };

  const commitScanned = async (hint: PantryLocation) => {
    const include = scanned.filter((i) => i.confirmed);
    if (include.length === 0) {
      setMode({ kind: "list" });
      return;
    }
    const next = await addPantryItems(
      include.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        notes: i.notes,
        // The scene wins when the model could read it; otherwise the button
        // the user pressed is the best evidence we have about where they were
        // standing, and it beats the shelf-life table's generic guess.
        location: i.location ?? hint,
        expiresAt: i.expiresAt,
      })),
    );
    onChange(next);
    setScanned([]);
    setMode({ kind: "list" });
  };

  const inventWithAI = async () => {
    const ings = ingredientsFromPantry(pantry ?? []);
    if (ings.length === 0 || aiInFlight.current) return;
    aiInFlight.current = true;
    setError(null);
    setGen({ kind: "generating" });
    try {
      const recipes = await generateRecipes(ings);
      setGen({ kind: "recipes", recipes });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setGen({ kind: "idle" });
    } finally {
      aiInFlight.current = false;
    }
  };

  if (gen.kind === "generating") {
    return (
      <div className="center-spinner">
        <div className="spinner" />
        <div style={{ fontWeight: 500 }}>Cooking up ideas…</div>
        <div className="muted">Three recipes from what you have. ~10 seconds.</div>
      </div>
    );
  }
  if (gen.kind === "recipes") {
    return (
      <div className="browse-screen">
        <BackBar label="Back to my pantry" onBack={() => setGen({ kind: "idle" })} />
        <RecipesScreen
          recipes={gen.recipes}
          ingredients={ingredientsFromPantry(pantry ?? [])}
          onEditIngredients={() => setGen({ kind: "idle" })}
          onRestart={() => setGen({ kind: "idle" })}
          onCook={onCook ? (r) => onCook(r, null) : undefined}
        />
      </div>
    );
  }

  if (mode.kind === "capture") {
    const where = mode.hint;
    return (
      <div className="browse-screen">
        <BackBar label="Back to my pantry" onBack={() => setMode({ kind: "list" })} />
        {error && (
          <div className="status-banner error">
            <Icon name="triangle-exclamation" />
            <span>{error}</span>
          </div>
        )}
        <CaptureScreen
          onIdentify={(photos) => onScanned(photos, where)}
          initialPhotos={lastPhotos}
          title={where === "fridge" ? "Scan your fridge" : where === "freezer" ? "Scan your freezer" : "Scan a shelf"}
          emptyHint="Get the door open and the light on. Several photos are fine — I merge what appears twice."
          actionLabel={(n) => `Read ${n} photo${n === 1 ? "" : "s"} →`}
        />
      </div>
    );
  }

  if (mode.kind === "identifying") {
    return (
      <div className="center-spinner">
        <div className="spinner" />
        <div style={{ fontWeight: 500 }}>Reading your photos…</div>
        <div className="muted">You'll get to check the list before anything is saved.</div>
      </div>
    );
  }

  if (mode.kind === "review") {
    const hint = mode.hint;
    return (
      <ScanReview
        scanned={scanned}
        hint={hint}
        onPatch={(name, patch) =>
          setScanned((prev) => prev.map((i) => (i.name === name ? { ...i, ...patch } : i)))
        }
        onRemove={(name) => setScanned((prev) => prev.filter((i) => i.name !== name))}
        onBack={() => setMode({ kind: "list" })}
        onCommit={() => void commitScanned(hint)}
      />
    );
  }

  return (
    <PantryHome
      pantry={pantry}
      onChange={onChange}
      onCook={onCook}
      onPlanWeek={onPlanWeek}
      onBrowse={onBrowse}
      onScan={(hint) => {
        setError(null);
        setMode({ kind: "capture", hint });
      }}
      onInvent={inventWithAI}
      catalogVersion={catalogVersion}
    />
  );
}

// ── The home screen ──────────────────────────────────────────────────────

function PantryHome({
  pantry,
  onChange,
  onCook,
  onPlanWeek,
  onBrowse,
  onScan,
  onInvent,
  catalogVersion,
}: {
  pantry: PantryItem[] | null;
  onChange: (items: PantryItem[]) => void;
  onCook?: (recipe: Recipe, saved: SavedRecipe | null) => void;
  onPlanWeek?: (seed?: string[]) => void;
  onBrowse?: () => void;
  onScan: (hint: PantryLocation) => void;
  onInvent: () => void;
  catalogVersion: number;
}) {
  const [name, setName] = useState("");
  const [qty, setQty] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showMatches, setShowMatches] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /**
   * A cook left running, if there is one. There is no Cook tab in the bottom
   * bar — the guided cook is an overlay — so without this banner a persisted
   * session would survive and be unreachable. This is the home tab, so this is
   * where it belongs.
   */
  const [resumable, setResumable] = useState<CookSession | null>(null);
  const [savedRows, setSavedRows] = useState<SavedRecipe[]>([]);
  useEffect(() => {
    setResumable(loadCookSession());
    // Only so a resumed cook can re-attach to the library row it came from
    // ("I made this" needs the saved recipe, not just the recipe body).
    listSavedRecipes().then(setSavedRows).catch(() => setSavedRows([]));
  }, []);

  const items = pantry ?? [];
  const hasItems = items.length > 0;

  /**
   * One `now` for the whole render.
   *
   * Calling Date.now() per row would let a list straddle midnight mid-paint
   * and show two different answers for the same day, and it makes the memos
   * below re-run on every render for nothing.
   */
  const now = useMemo(() => Date.now(), [items]);

  /**
   * What to use up. At-risk items soonest-first; if nothing is at risk, the
   * longest-held few, because "what have I had the longest" is the honest
   * fallback and is exactly what addedAt already knows.
   */
  const useUp = useMemo(() => {
    const ordered = byWasteRisk(items, now);
    const risky = ordered.filter((i) => atRisk(i, now));
    return { rows: (risky.length ? risky : ordered).slice(0, 6), anyRisk: risky.length > 0 };
  }, [items, now]);

  /** The stock list, grouped by where it is kept. Empty groups are dropped. */
  const groups = useMemo(() => {
    const by = new Map<PantryLocation, PantryItem[]>();
    for (const it of byWasteRisk(items, now)) {
      const where = locationOf(it);
      const list = by.get(where);
      if (list) list.push(it);
      else by.set(where, [it]);
    }
    return LOCATIONS.map((l) => ({ ...l, items: by.get(l.id) ?? [] })).filter((g) => g.items.length > 0);
  }, [items, now]);

  const catalog = useMemo(() => getCatalog(), [catalogVersion]);
  const pantryIng = useMemo(() => ingredientsFromPantry(items), [items]);
  const matches = useMemo(() => {
    if (!pantryIng.length) return [];
    return catalog
      .map((c) => ({ c, cov: computeCoverage(c, pantryIng) }))
      .filter((x) => x.cov.have > 0)
      .sort((a, b) => b.cov.score - a.cov.score)
      .slice(0, 30);
  }, [catalog, pantryIng]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      onChange(await addPantryItem({ name, quantity: qty }));
      setName("");
      setQty("");
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    }
  };

  const patch = async (itemName: string, p: Partial<PantryItem>) => {
    setErr(null);
    try {
      onChange(await updatePantryItem(itemName, p));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const remove = async (itemName: string) => {
    setErr(null);
    try {
      onChange(await removePantryItem(itemName));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (pantry === null) {
    return <div className="center-spinner"><div className="spinner" /></div>;
  }

  return (
    <div className="browse-screen">
      {resumable && (
        <ResumeCook
          session={resumable}
          saved={savedRows}
          onResume={(r, s) => onCook?.(r, s)}
          onForget={() => setResumable(null)}
        />
      )}

      {/* The hero. A camera, not a form: the app's first ask is a photo. */}
      <section className="scan-hero">
        <h2 className="scan-hero-title">What's in your kitchen?</h2>
        <p className="scan-hero-sub muted">
          Point the camera at a shelf and it becomes a list. Everything else here works out from
          what you already have.
        </p>
        <div className="scan-hero-row">
          <button className="btn scan-hero-btn" onClick={() => onScan("fridge")}>
            <Icon name="camera" /> Scan fridge
          </button>
          <button className="btn secondary scan-hero-btn" onClick={() => onScan("pantry")}>
            <Icon name="camera" /> Scan a shelf
          </button>
        </div>
      </section>

      {err && (
        <div className="status-banner error">
          <Icon name="triangle-exclamation" />
          <span>{err}</span>
        </div>
      )}

      {!hasItems ? (
        <div className="empty-state">
          <Icon name="boxes-stacked" className="empty-icon" />
          <div>Nothing in here yet. Scan a shelf to fill it fast, or add items by hand.</div>
          <button className="btn secondary" onClick={() => setShowAdd(true)}>
            <Icon name="plus" /> Add by hand
          </button>
        </div>
      ) : (
        <>
          {/* Use these up — the point of the app, so it sits above the stock. */}
          <section className="useup">
            <div className="home-section-head">
              <h3>
                <Icon name="clock-rotate-left" /> {useUp.anyRisk ? "Use these up" : "Longest in here"}
              </h3>
              {onPlanWeek && (
                <button
                  className="link-btn"
                  onClick={() => onPlanWeek(useUp.rows.map((i) => i.name))}
                >
                  Plan around these
                </button>
              )}
            </div>
            <p className="useup-note muted">
              {useUp.anyRisk
                ? "Closest to being thrown out first. Tap one to plan a week around it."
                : "Nothing is near its date. These have simply been here longest."}
            </p>
            <div className="useup-rows">
              {useUp.rows.map((it) => (
                <UseUpRow
                  key={it.name}
                  item={it}
                  now={now}
                  onPlan={onPlanWeek ? () => onPlanWeek([it.name]) : undefined}
                />
              ))}
            </div>
          </section>

          {/* What you have, grouped by where it lives. */}
          <section className="home-section">
            <div className="home-section-head">
              <h3>What you have</h3>
              <button className="link-btn" onClick={() => setShowAdd((v) => !v)}>
                <Icon name="plus" /> Add by hand
              </button>
            </div>
            {groups.map((g) => (
              <div className="stock-group" key={g.id}>
                <div className="ing-group-label">
                  {g.label} · {g.items.length}
                </div>
                <div className="stock-list">
                  {g.items.map((it) => (
                    <StockRow
                      key={it.name}
                      item={it}
                      now={now}
                      open={expanded === it.name}
                      onToggle={() => setExpanded((cur) => (cur === it.name ? null : it.name))}
                      onPatch={(p) => void patch(it.name, p)}
                      onRemove={() => void remove(it.name)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </section>
        </>
      )}

      {showAdd && (
        <form className="add-ing-form" onSubmit={add}>
          <input
            type="text"
            placeholder="Add an ingredient (e.g. sour cream)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={50}
            autoFocus
          />
          <input
            type="text"
            placeholder="Amount (optional)"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            maxLength={40}
          />
          <button className="btn" type="submit" disabled={!name.trim()}>
            <Icon name="plus" /> Add
          </button>
        </form>
      )}

      {hasItems && (
        <div className="kitchen-make-section">
          <button className="btn secondary kitchen-make" onClick={() => setShowMatches((v) => !v)}>
            <Icon name="bowl-food" /> What can I make right now?
            <Icon name="chevron-down" className={showMatches ? "rot-flip" : ""} />
          </button>
          {showMatches && (
            <div className="kitchen-matches">
              <button className="btn secondary kitchen-invent" onClick={onInvent}>
                <Icon name="wand" /> Invent something from what I have
              </button>
              {matches.length > 0 ? (
                <div className="browse-list">
                  {matches.map(({ c, cov }) => (
                    <RecipeRow
                      key={c.id}
                      fi={{ kind: "catalog", id: c.id, recipe: c, favorite: false }}
                      cov={cov}
                      onOpen={async () => onCook?.(toRecipe(await loadRecipeBody(c)), null)}
                    />
                  ))}
                </div>
              ) : (
                <p className="muted">Add a few more items and matches will show here.</p>
              )}
            </div>
          )}
        </div>
      )}

      {hasItems && onPlanWeek && (
        <div className="home-nudge">
          <Icon name="calendar-days" />
          <div>
            <strong>Plan the week around this.</strong> Different dinners that between them use up
            what's above, and one shopping list for whatever's left.
          </div>
          <button className="btn" onClick={() => onPlanWeek()}>
            <Icon name="calendar-days" /> Plan my week
          </button>
        </div>
      )}

      {!hasItems && onBrowse && (
        <div className="home-nudge">
          <Icon name="utensils" />
          <div>
            <strong>Just browsing?</strong> The recipe library is still here — 1,120 of them, and
            every row shows how much of it you already own once your pantry has anything in it.
          </div>
          <button className="btn secondary" onClick={onBrowse}>
            <Icon name="magnifying-glass" /> Browse recipes
          </button>
        </div>
      )}
    </div>
  );
}

// ── Use these up ─────────────────────────────────────────────────────────

function UseUpRow({
  item,
  now,
  onPlan,
}: {
  item: PantryItem;
  now: number;
  onPlan?: () => void;
}) {
  const r = remainingFor(item, now);
  const risk = riskOf(item, now);
  const body = (
    <>
      <span className="useup-name">{item.name}</span>
      {item.quantity && <span className="useup-qty muted">{item.quantity}</span>}
      <RiskChip item={item} now={now} />
      {r?.basis === "estimate" && <span className="useup-basis faint">est.</span>}
      {risk === "expired" && <span className="visually-hidden">past its date</span>}
    </>
  );
  if (!onPlan) return <div className="useup-row">{body}</div>;
  return (
    <button type="button" className="useup-row" onClick={onPlan} title={`Plan a week around ${item.name}`}>
      {body}
      <Icon name="chevron-down" className="useup-go" />
    </button>
  );
}

const RISK_CLASS: Record<Risk, string> = {
  expired: "miss-chip",
  urgent: "miss-chip",
  soon: "short-chip",
  fine: "cov-chip",
};

/**
 * Beyond a month, "how long left" is not information anybody acts on, and on
 * an estimate it is not information at all — a chip reading "730 days left"
 * next to the black pepper is noise that makes the "2 days left" next to the
 * chicken harder to see. So the chip only appears when the answer matters.
 */
const CHIP_HORIZON_DAYS = 30;

function RiskChip({ item, now }: { item: PantryItem; now: number }) {
  const r = remainingFor(item, now);
  if (!r || r.days > CHIP_HORIZON_DAYS) return null;
  const risk = riskOf(item, now);
  return (
    <span className={`risk-chip ${RISK_CLASS[risk]}`} title={r.basis === "expiry" ? "From the date on the packet" : "Estimated from how long it's been here"}>
      {remainingLabel(r)}
    </span>
  );
}

// ── One row of stock, editable in place ──────────────────────────────────

function StockRow({
  item,
  now,
  open,
  onToggle,
  onPatch,
  onRemove,
}: {
  item: PantryItem;
  now: number;
  open: boolean;
  onToggle: () => void;
  onPatch: (p: Partial<PantryItem>) => void;
  onRemove: () => void;
}) {
  const [qty, setQty] = useState(item.quantity ?? "");
  const r = remainingFor(item, now);

  return (
    <div className={`stock-row${open ? " open" : ""}`}>
      <button type="button" className="stock-head" onClick={onToggle} aria-expanded={open}>
        <span className="stock-name">{item.name}</span>
        {item.quantity && <span className="stock-qty muted">{item.quantity}</span>}
        <RiskChip item={item} now={now} />
        <Icon name="chevron-down" className={`stock-caret${open ? " rot-flip" : ""}`} />
      </button>
      {open && (
        <div className="stock-edit">
          <label className="stock-field">
            <span className="stock-field-label">Amount</span>
            <input
              type="text"
              value={qty}
              placeholder="e.g. 1 pint"
              maxLength={40}
              onChange={(e) => setQty(e.target.value)}
              onBlur={() => qty.trim() !== (item.quantity ?? "") && onPatch({ quantity: qty.trim() || undefined })}
            />
          </label>

          <div className="stock-field">
            <span className="stock-field-label">Keep in</span>
            <div className="seg loc-seg" role="group" aria-label="Where this is kept">
              {LOCATIONS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className={`seg-btn${locationOf(item) === l.id ? " active" : ""}`}
                  aria-pressed={locationOf(item) === l.id}
                  onClick={() => onPatch({ location: l.id })}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>

          <label className="stock-field">
            <span className="stock-field-label">Use by</span>
            <input
              type="date"
              value={item.expiresAt ?? ""}
              min={todayISO(now)}
              onChange={(e) => onPatch({ expiresAt: e.target.value || undefined })}
            />
          </label>

          <p className="stock-basis faint">
            {r?.basis === "expiry"
              ? "Using the date you set."
              : r
                ? `No date set, so this is an estimate from how long it's been here${r.weak ? " (and I don't know this one, so it's a rough fortnight)" : ""}.`
                : "No date and no clock to work from."}
          </p>

          <div className="stock-actions">
            <button type="button" className="link-btn danger" onClick={onRemove}>
              <Icon name="trash-can" /> Remove from pantry
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Scan review: nothing is saved until this is agreed ───────────────────

function ScanReview({
  scanned,
  hint,
  onPatch,
  onRemove,
  onBack,
  onCommit,
}: {
  scanned: Ingredient[];
  hint: PantryLocation;
  onPatch: (name: string, patch: Partial<Ingredient>) => void;
  onRemove: (name: string) => void;
  onBack: () => void;
  onCommit: () => void;
}) {
  const included = scanned.filter((i) => i.confirmed);
  const dated = scanned.filter((i) => i.expiresAt).length;
  return (
    <div className="browse-screen">
      <BackBar label="Cancel" onBack={onBack} />
      <div>
        <h2 style={{ margin: 0 }}>Found {scanned.length} items</h2>
        <p className="muted">
          Everything here is editable. Uncheck what isn't yours, drop what it got wrong, fix an
          amount. Nothing reaches your pantry until you say so.
          {dated > 0 && ` I could read a date on ${dated} of them.`}
        </p>
      </div>
      <div className="ing-group">
        {scanned.map((ing) => (
          <div className={`ing-row ${ing.confirmed ? "confirmed" : "unconfirmed"}`} key={ing.name}>
            <button
              className="icon-btn"
              onClick={() => onPatch(ing.name, { confirmed: !ing.confirmed })}
              title={ing.confirmed ? "Exclude" : "Include"}
              aria-pressed={ing.confirmed}
            >
              <Icon name={ing.confirmed ? "check" : "circle"} />
            </button>
            <span className="name">{ing.name}</span>
            {ing.quantity && <span className="qty-pill">{ing.quantity}</span>}
            {ing.expiresAt && <span className="risk-chip short-chip">use by {ing.expiresAt}</span>}
            {(ing.location ?? hint) !== hint && (
              <span className="token-chip">{ing.location}</span>
            )}
            {ing.notes && <span className="notes">{ing.notes}</span>}
            <div className="actions">
              <button className="icon-btn" onClick={() => onRemove(ing.name)} title="Remove">
                <Icon name="xmark" />
              </button>
            </div>
          </div>
        ))}
      </div>
      <p className="faint">
        Anything without its own label goes in the {hint}. You can move it afterwards from the row.
      </p>
      <div className="capture-buttons" style={{ marginTop: 8 }}>
        <button className="btn" disabled={included.length === 0} onClick={onCommit}>
          <Icon name="plus" /> Add {included.length} to my pantry
        </button>
      </div>
    </div>
  );
}

function BackBar({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <div className="detail-actions">
      <button className="btn ghost" onClick={onBack}>
        <Icon name="chevron-down" className="back-caret" /> {label}
      </button>
    </div>
  );
}

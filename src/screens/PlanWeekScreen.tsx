import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  CapturedPhoto,
  Ingredient,
  MoodConstraints,
  PantryItem,
  Recipe,
  SavedRecipe,
  ShoppingListItem,
  WeekPlan,
} from "../types";
import { getCatalog } from "../features/catalog";
import { listSavedRecipes } from "../features/storage";
import { loadFavorites } from "../features/favorites";
import { ingredientsFromPantry } from "../features/pantry";
import {
  planWeek,
  interpretMood,
  seedConstraintsFromRecipe,
  buildOnHand,
  type PlanCandidate,
} from "../features/planWeek";
import { saveWeekPlan, listWeekPlans } from "../features/planStorage";
import { identifyIngredients } from "../features/vision";
import { sanitizeName } from "../features/vision";
import { prettyIngredient } from "../features/scaling";
import { CaptureScreen } from "./CaptureScreen";
import { Icon } from "../icons";

type Step = "mood" | "scan" | "review" | "shopping";
type MoodMode = "ingredients" | "seed" | "text";
type View = "list" | "build";

const STEPS: { id: Step; label: string }[] = [
  { id: "mood", label: "Mood" },
  { id: "scan", label: "Pantry" },
  { id: "review", label: "Meals" },
  { id: "shopping", label: "Shopping" },
];

const MOOD_META: Record<MoodMode, { title: string; sub: string; label: string }> = {
  ingredients: {
    title: "Pick ingredients",
    sub: "Build around a few",
    label: "Ingredients you want this week",
  },
  seed: { title: "From a recipe", sub: "Start from one you love", label: "Starting recipe" },
  text: { title: "Describe it", sub: "Say it in words", label: "Describe your week" },
};

function uniq(a: string[]): string[] {
  return [...new Set(a)];
}

function fmtDate(iso: string): string {
  // createdAt is an ISO string; show YYYY-MM-DD without pulling in a date lib.
  return iso.slice(0, 10);
}

export function PlanWeekScreen({
  pantry,
  catalogVersion = 0,
}: {
  pantry: PantryItem[] | null;
  /** Bumped by App when the catalog reloads from the DB, so the memo re-runs. */
  catalogVersion?: number;
}) {
  const [view, setView] = useState<View>("build");
  const [plans, setPlans] = useState<WeekPlan[]>([]);
  const [viewingPlan, setViewingPlan] = useState<WeekPlan | null>(null);

  const [step, setStep] = useState<Step>("mood");
  const [moodMode, setMoodMode] = useState<MoodMode>("ingredients");
  const [includeChips, setIncludeChips] = useState<string[]>([]);
  const [chipInput, setChipInput] = useState("");
  const [freeText, setFreeText] = useState("");
  const [mealCount, setMealCount] = useState(5);
  const [seed, setSeed] = useState<PlanCandidate | null>(null);
  const [seedQuery, setSeedQuery] = useState("");

  const [saved, setSaved] = useState<SavedRecipe[]>([]);
  const [favs, setFavs] = useState<Set<string>>(new Set());

  const [scanned, setScanned] = useState<Ingredient[]>([]);
  const [scanMode, setScanMode] = useState<"idle" | "capture" | "identifying">("idle");

  const [constraints, setConstraints] = useState<MoodConstraints | null>(null);
  const [plan, setPlan] = useState<WeekPlan | null>(null);
  const [excludeIds, setExcludeIds] = useState<string[]>([]);
  const [busy, setBusy] = useState<null | "mood" | "saving">(null);
  const [error, setError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [savedJustNow, setSavedJustNow] = useState(false);
  const [lastSaved, setLastSaved] = useState<WeekPlan | null>(null);

  // In-flow recipe preview (modal over the Review step).
  const [preview, setPreview] = useState<Recipe | null>(null);

  // Editable grocery list: lines the user removed (by canonical) + lines they added.
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [extras, setExtras] = useState<ShoppingListItem[]>([]);

  useEffect(() => {
    Promise.all([listSavedRecipes(), loadFavorites()]).then(([s, f]) => {
      setSaved(s);
      setFavs(f);
    });
    listWeekPlans().then((p) => {
      setPlans(p);
      if (p.length) setView("list"); // land on the library when plans exist
    });
  }, []);

  const candidates = useMemo<PlanCandidate[]>(() => {
    const catalog = getCatalog().map((c) => ({
      id: c.id,
      title: c.title,
      recipe: c,
      category: c.category,
      tags: c.tags,
      isFavorite: favs.has(c.id),
    }));
    const savedFav = saved
      .filter((r) => r.favorite)
      .map((r) => ({
        id: `saved:${r.slug}`,
        title: r.title,
        recipe: r,
        category: "saved",
        tags: [] as string[],
        isFavorite: true,
      }));
    return [...savedFav, ...catalog];
  }, [saved, favs, catalogVersion]);

  const onHand = useMemo<Ingredient[]>(
    () => buildOnHand(pantry ? ingredientsFromPantry(pantry) : [], scanned),
    [pantry, scanned],
  );

  const seedResults = useMemo(() => {
    const q = seedQuery.trim().toLowerCase();
    if (!q) return [];
    return candidates.filter((c) => c.title.toLowerCase().includes(q)).slice(0, 8);
  }, [seedQuery, candidates]);

  // Effective grocery list = plan list minus removed, plus user-added extras.
  const groceryList = useMemo<ShoppingListItem[]>(() => {
    if (!plan) return [];
    return [...plan.shoppingList.filter((i) => !removed.has(i.canonical)), ...extras];
  }, [plan, removed, extras]);

  // ── transitions ─────────────────────────────────────────────────────
  const addChip = (e: FormEvent) => {
    e.preventDefault();
    const n = sanitizeName(chipInput);
    setChipInput("");
    if (n && !includeChips.includes(n)) setIncludeChips((p) => [...p, n]);
  };

  const newPlan = () => {
    setStep("mood");
    setMoodMode("ingredients");
    setIncludeChips([]);
    setChipInput("");
    setFreeText("");
    setMealCount(5);
    setSeed(null);
    setSeedQuery("");
    setScanned([]);
    setConstraints(null);
    setPlan(null);
    setExcludeIds([]);
    setError(null);
    setSavedPath(null);
    setSavedJustNow(false);
    setLastSaved(null);
    setRemoved(new Set());
    setExtras([]);
    setViewingPlan(null);
    setView("build");
  };

  const goToScan = async () => {
    setError(null);
    let c: MoodConstraints = {
      includeIngredients: [...includeChips],
      cuisines: [],
      dietary: [],
      avoid: [],
      mealCount,
    };
    if (moodMode === "text" && freeText.trim()) {
      setBusy("mood");
      try {
        const ai = await interpretMood(freeText);
        c = {
          ...ai,
          mealCount,
          includeIngredients: uniq([...ai.includeIngredients, ...includeChips]),
        };
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(null);
        return;
      }
      setBusy(null);
    }
    if (moodMode === "seed" && seed) {
      const seeded = seedConstraintsFromRecipe(seed.recipe, seed.category, seed.tags);
      c = {
        ...c,
        includeIngredients: uniq([...(seeded.includeIngredients ?? []), ...includeChips]),
        cuisines: uniq([...(seeded.cuisines ?? []), ...c.cuisines]),
      };
    }
    setConstraints(c);
    setStep("scan");
  };

  const runPlan = (exclude: string[], c = constraints) => {
    if (!c) return;
    const p = planWeek({
      constraints: c,
      onHand,
      candidates,
      pinnedId: moodMode === "seed" ? seed?.id : undefined,
      excludeIds: exclude,
    });
    setPlan(p);
    setExcludeIds(exclude);
    // A fresh plan resets any prior grocery-list edits / save state.
    setRemoved(new Set());
    setExtras([]);
    setSavedPath(null);
    setSavedJustNow(false);
  };

  const onScanned = async (photos: CapturedPhoto[]) => {
    setScanMode("identifying");
    try {
      const items = await identifyIngredients(photos);
      setScanned((prev) => buildOnHand(prev, items));
      setScanMode("idle");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setScanMode("idle");
    }
  };

  const removePick = (id: string) => runPlan([...excludeIds, id]);

  const removeGroceryItem = (canonical: string) =>
    setRemoved((prev) => new Set(prev).add(canonical));

  const addGroceryItem = (raw: string) => {
    const name = raw.trim();
    if (!name) return;
    const canonical = name.toLowerCase();
    if (groceryList.some((i) => i.canonical === canonical)) return;
    setRemoved((prev) => {
      // if they'd removed a same-named line, un-remove instead of duplicating
      if (prev.has(canonical)) {
        const next = new Set(prev);
        next.delete(canonical);
        return next;
      }
      return prev;
    });
    if (!plan?.shoppingList.some((i) => i.canonical === canonical)) {
      setExtras((prev) => [...prev, { name, canonical, recipes: [], aisle: "Added by you" }]);
    }
  };

  const onSave = async () => {
    if (!plan) return;
    setBusy("saving");
    try {
      const edited: WeekPlan = { ...plan, shoppingList: groceryList };
      const { path } = await saveWeekPlan(edited);
      setLastSaved(edited);
      setSavedPath(path);
      setSavedJustNow(true);
      setTimeout(() => setSavedJustNow(false), 1000);
      listWeekPlans().then(setPlans);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const goToSavedPlan = () => {
    setViewingPlan(lastSaved);
    setView("list");
  };

  // ── render ───────────────────────────────────────────────────────────
  if (scanMode === "capture") {
    return (
      <div className="browse-screen">
        <button className="btn ghost" onClick={() => setScanMode("idle")} style={{ alignSelf: "flex-start" }}>
          <Icon name="chevron-down" className="back-caret" /> Back
        </button>
        <CaptureScreen onIdentify={onScanned} />
      </div>
    );
  }
  if (scanMode === "identifying") {
    return (
      <div className="center-spinner">
        <div className="spinner" />
        <div style={{ fontWeight: 500 }}>Reading your photos…</div>
      </div>
    );
  }

  // A saved plan, opened read-only from the library.
  if (viewingPlan) {
    return <PlanReadView plan={viewingPlan} onBack={() => setViewingPlan(null)} />;
  }

  // The library of saved plans + a "New plan" entry point.
  if (view === "list") {
    return (
      <PlansList
        plans={plans}
        onNew={newPlan}
        onOpen={(p) => setViewingPlan(p)}
      />
    );
  }

  return (
    <div className="browse-screen">
      <div className="browse-header">
        <h2>Plan my week</h2>
        {plans.length > 0 && (
          <button className="btn ghost" onClick={() => setView("list")}>
            <Icon name="calendar-days" /> My plans
          </button>
        )}
      </div>
      <StepDots step={step} />

      {error && (
        <div className="status-banner error">
          <Icon name="triangle-exclamation" />
          <span>{error}</span>
        </div>
      )}

      {step === "mood" && (
        <MoodStep
          mode={moodMode}
          setMode={setMoodMode}
          includeChips={includeChips}
          chipInput={chipInput}
          setChipInput={setChipInput}
          addChip={addChip}
          removeChip={(n) => setIncludeChips((p) => p.filter((x) => x !== n))}
          freeText={freeText}
          setFreeText={setFreeText}
          mealCount={mealCount}
          setMealCount={setMealCount}
          seed={seed}
          setSeed={setSeed}
          seedQuery={seedQuery}
          setSeedQuery={setSeedQuery}
          seedResults={seedResults}
          busy={busy === "mood"}
          onNext={goToScan}
        />
      )}

      {step === "scan" && (
        <ScanStep
          onHand={onHand}
          pantryCount={pantry?.length ?? 0}
          onScan={() => {
            setError(null);
            setScanMode("capture");
          }}
          onBack={() => setStep("mood")}
          onPlan={() => {
            runPlan([]);
            setStep("review");
          }}
        />
      )}

      {step === "review" && plan && (
        <ReviewStep
          plan={plan}
          onRemove={removePick}
          onPreview={setPreview}
          onBack={() => setStep("scan")}
          onNext={() => setStep("shopping")}
        />
      )}

      {step === "shopping" && plan && (
        <ShoppingStep
          items={groceryList}
          mealCount={plan.picks.length}
          saving={busy === "saving"}
          savedPath={savedPath}
          savedJustNow={savedJustNow}
          onAddItem={addGroceryItem}
          onRemoveItem={removeGroceryItem}
          onBack={() => setStep("review")}
          onSave={onSave}
          onGoToPlan={goToSavedPlan}
        />
      )}

      {preview && <RecipePreviewModal recipe={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

// ── Step dots ──────────────────────────────────────────────────────────

function StepDots({ step }: { step: Step }) {
  const idx = STEPS.findIndex((s) => s.id === step);
  return (
    <div className="plan-steps">
      {STEPS.map((s, i) => (
        <div key={s.id} className={`plan-step${i === idx ? " active" : ""}${i < idx ? " done" : ""}`}>
          <span className="plan-step-dot">{i < idx ? <Icon name="check" /> : i + 1}</span>
          {s.label}
        </div>
      ))}
    </div>
  );
}

// ── Saved-plans library ──────────────────────────────────────────────────

function PlansList({
  plans,
  onNew,
  onOpen,
}: {
  plans: WeekPlan[];
  onNew: () => void;
  onOpen: (p: WeekPlan) => void;
}) {
  return (
    <div className="browse-screen">
      <div className="browse-header">
        <h2>My plans</h2>
        <button className="btn" onClick={onNew}>
          <Icon name="plus" /> New plan
        </button>
      </div>

      {plans.length === 0 ? (
        <div className="empty-state">
          <Icon name="calendar-days" className="empty-icon" />
          <div>No saved plans yet. Tap “New plan” to build your week.</div>
        </div>
      ) : (
        <div className="plan-cards">
          {plans.map((pl, i) => (
            <button key={`${pl.createdAt}-${i}`} className="plan-saved-card" onClick={() => onOpen(pl)}>
              <div className="plan-saved-top">
                <span className="plan-saved-date">{fmtDate(pl.createdAt)}</span>
                <span className="pill">{pl.picks.length} meal{pl.picks.length === 1 ? "" : "s"}</span>
              </div>
              <div className="plan-saved-meals">
                {pl.picks.map((p) => p.title).join(" · ") || "Empty plan"}
              </div>
              <div className="plan-saved-foot">
                <Icon name="basket-shopping" /> {pl.shoppingList.length} item
                {pl.shoppingList.length === 1 ? "" : "s"} to buy
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PlanReadView({ plan, onBack }: { plan: WeekPlan; onBack: () => void }) {
  const byAisle = useMemo(() => groupByAisle(plan.shoppingList), [plan]);
  return (
    <div className="browse-screen">
      <div className="detail-actions">
        <button className="btn ghost" onClick={onBack}>
          <Icon name="chevron-down" className="back-caret" /> My plans
        </button>
      </div>
      <div className="browse-header">
        <h2>Week of {fmtDate(plan.createdAt)}</h2>
      </div>

      <div className="ing-group">
        <div className="ing-group-label">Meals</div>
        <div className="browse-list">
          {plan.picks.map((p) => (
            <div key={p.id} className="browse-item" style={{ cursor: "default" }}>
              <div className="title-block">
                <div className="title">{p.title}</div>
                <div className="meta">{p.haveCount}/{p.totalCount} on hand</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="ing-group">
        <div className="ing-group-label">Grocery list · {plan.shoppingList.length}</div>
        {plan.shoppingList.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>Nothing to buy.</div>
        ) : (
          byAisle.map(([aisle, items]) => (
            <div key={aisle} className="shopping-group">
              <div className="ing-group-label">{aisle}</div>
              {items.map((item) => (
                <div key={item.canonical} className="shopping-line">
                  <div className="shopping-line-main">
                    <span className="shopping-name">{item.name}</span>
                    {item.quantity && <span className="shopping-qty">{item.quantity}</span>}
                    {item.quantityNote && <span className="serves">{item.quantityNote}</span>}
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── Mood ───────────────────────────────────────────────────────────────

interface MoodProps {
  mode: MoodMode;
  setMode: (m: MoodMode) => void;
  includeChips: string[];
  chipInput: string;
  setChipInput: (v: string) => void;
  addChip: (e: FormEvent) => void;
  removeChip: (n: string) => void;
  freeText: string;
  setFreeText: (v: string) => void;
  mealCount: number;
  setMealCount: (n: number) => void;
  seed: PlanCandidate | null;
  setSeed: (c: PlanCandidate | null) => void;
  seedQuery: string;
  setSeedQuery: (v: string) => void;
  seedResults: PlanCandidate[];
  busy: boolean;
  onNext: () => void;
}

function MoodStep(p: MoodProps) {
  const ready =
    p.mode === "ingredients"
      ? p.includeChips.length > 0
      : p.mode === "seed"
      ? !!p.seed
      : p.freeText.trim().length > 0;
  return (
    <>
      <div className="muted" style={{ fontSize: 13 }}>
        What are you in the mood for this week? Choose how you want to start.
      </div>

      <div className="mood-picker">
        {(["ingredients", "seed", "text"] as MoodMode[]).map((m) => (
          <button
            key={m}
            className={`mood-opt${p.mode === m ? " active" : ""}`}
            onClick={() => p.setMode(m)}
            aria-pressed={p.mode === m}
          >
            <span className="mood-opt-title">{MOOD_META[m].title}</span>
            <span className="mood-opt-sub">{MOOD_META[m].sub}</span>
          </button>
        ))}
      </div>

      <div className="mood-panel">
        <div className="mood-panel-label">{MOOD_META[p.mode].label}</div>

        {p.mode === "ingredients" && (
          <div className="ing-group">
            <form className="add-ing-form" onSubmit={p.addChip}>
              <input
                type="text"
                placeholder="Add an ingredient you want this week…"
                value={p.chipInput}
                onChange={(e) => p.setChipInput(e.target.value)}
                maxLength={50}
              />
              <button className="btn secondary" type="submit" disabled={!p.chipInput.trim()}>
                <Icon name="plus" /> Add
              </button>
            </form>
            <div className="cov-strip" style={{ marginTop: 4 }}>
              {p.includeChips.map((c) => (
                <button key={c} className="token-chip want" onClick={() => p.removeChip(c)} title="Remove">
                  {c} <Icon name="xmark" />
                </button>
              ))}
              {p.includeChips.length === 0 && (
                <span className="muted" style={{ fontSize: 13 }}>No ingredients yet.</span>
              )}
            </div>
          </div>
        )}

        {p.mode === "seed" && (
          <div className="ing-group">
            {p.seed ? (
              <div className="browse-item" style={{ cursor: "default" }}>
                <div className="title-block">
                  <div className="title">{p.seed.title}</div>
                  <div className="meta">seed recipe</div>
                </div>
                <button className="btn ghost" onClick={() => p.setSeed(null)}>
                  Change
                </button>
              </div>
            ) : (
              <>
                <div className="browse-filter">
                  <Icon name="magnifying-glass" />
                  <input
                    type="text"
                    placeholder="Search a recipe to start from…"
                    value={p.seedQuery}
                    onChange={(e) => p.setSeedQuery(e.target.value)}
                  />
                </div>
                <div className="browse-list">
                  {p.seedResults.map((c) => (
                    <div key={c.id} className="browse-item" onClick={() => p.setSeed(c)}>
                      <div className="title-block">
                        <div className="title">{c.title}</div>
                        <div className="meta">{c.category}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {p.mode === "text" && (
          <textarea
            className="create-input"
            placeholder={"e.g. Quick weeknight dinners, lots of chicken and veg, nothing too spicy. Maybe a pasta night."}
            value={p.freeText}
            onChange={(e) => p.setFreeText(e.target.value)}
            rows={4}
            maxLength={1000}
          />
        )}
      </div>

      <div className="scale-row">
        <span className="muted" style={{ fontSize: 13 }}>How many meals?</span>
        <div className="serving-stepper">
          <button className="icon-btn" onClick={() => p.setMealCount(Math.max(1, p.mealCount - 1))} disabled={p.mealCount <= 1}>
            −
          </button>
          <span className="serving-count">{p.mealCount}</span>
          <button className="icon-btn" onClick={() => p.setMealCount(Math.min(7, p.mealCount + 1))} disabled={p.mealCount >= 7}>
            +
          </button>
        </div>
      </div>

      <div className="capture-buttons" style={{ justifyContent: "flex-start" }}>
        <button className="btn" disabled={!ready || p.busy} onClick={p.onNext}>
          {p.busy ? "Reading your mood…" : "Next: check my pantry →"}
        </button>
      </div>
    </>
  );
}

// ── Scan ───────────────────────────────────────────────────────────────

function ScanStep({
  onHand,
  pantryCount,
  onScan,
  onBack,
  onPlan,
}: {
  onHand: Ingredient[];
  pantryCount: number;
  onScan: () => void;
  onBack: () => void;
  onPlan: () => void;
}) {
  return (
    <>
      <div className="muted" style={{ fontSize: 13 }}>
        I'll build the week around what you already have, then put everything else on one grocery list.
        Your pantry has {pantryCount} item{pantryCount === 1 ? "" : "s"}. Add a fresh fridge scan if you like.
      </div>

      <div className="capture-buttons" style={{ justifyContent: "flex-start" }}>
        <button className="btn secondary" onClick={onScan}>
          <Icon name="camera" /> Scan my fridge
        </button>
      </div>

      <div className="ing-group">
        <div className="ing-group-label">On hand · {onHand.length}</div>
        <div className="cov-strip">
          {onHand.map((i) => (
            <span key={i.name} className="token-chip on-hand">
              {i.name}
              {i.quantity ? ` · ${i.quantity}` : ""}
            </span>
          ))}
          {onHand.length === 0 && <span className="muted" style={{ fontSize: 13 }}>Nothing yet. Add pantry items or scan.</span>}
        </div>
      </div>

      <div className="detail-actions">
        <button className="btn ghost" onClick={onBack}>
          <Icon name="chevron-down" className="back-caret" /> Back
        </button>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={onPlan}>
          <Icon name="calendar-days" /> Plan my week
        </button>
      </div>
    </>
  );
}

// ── Review ─────────────────────────────────────────────────────────────

function ReviewStep({
  plan,
  onRemove,
  onPreview,
  onBack,
  onNext,
}: {
  plan: WeekPlan;
  onRemove: (id: string) => void;
  onPreview: (r: Recipe) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <>
      <div className="muted" style={{ fontSize: 13 }}>
        Here's your week. Each meal adds what you don't already have to one shared grocery list — tap a
        meal to see the full recipe, or swap any you don't fancy.
      </div>

      {plan.warnings.map((w, i) => (
        <div key={i} className="shortage-banner">
          <Icon name="circle-info" />
          <div className="shortage-banner-text">{w}</div>
        </div>
      ))}
      {plan.shortfall > 0 && (
        <div className="status-banner">
          <Icon name="circle-info" />
          <span>
            Only found {plan.picks.length} good match{plan.picks.length === 1 ? "" : "es"}. Loosen the
            mood or add pantry items for more.
          </span>
        </div>
      )}

      <div className="recipes-grid">
        {plan.picks.map((pick) => (
          <article key={pick.id} className="recipe-card recipe-card--static">
            <div className="row">
              <h3>{pick.title}</h3>
            </div>
            <div className="cov-strip">
              <span className={`cov-chip${pick.totalCount === pick.haveCount ? " complete" : ""}`}>
                {pick.haveCount}/{pick.totalCount} on hand
              </span>
            </div>
            {pick.pantryCovered.length > 0 && (
              <div>
                <h4>From your pantry</h4>
                <div className="cov-strip">
                  {pick.pantryCovered.map((t) => (
                    <span key={t} className="token-chip on-hand">{prettyIngredient(t)}</span>
                  ))}
                </div>
              </div>
            )}
            {pick.marginalNew.length > 0 && (
              <div>
                <h4>Adds to grocery list</h4>
                <div className="cov-strip">
                  {pick.marginalNew.map((t) => (
                    <span key={t} className="token-chip to-buy">{prettyIngredient(t)}</span>
                  ))}
                </div>
              </div>
            )}
            <div className="row" style={{ marginTop: "auto" }}>
              <button className="btn ghost" onClick={() => onPreview(pick.recipe)}>
                <Icon name="magnifying-glass" /> View recipe
              </button>
              <button className="btn ghost" onClick={() => onRemove(pick.id)}>
                <Icon name="rotate" /> Swap out
              </button>
            </div>
          </article>
        ))}
      </div>

      <div className="detail-actions">
        <button className="btn ghost" onClick={onBack}>
          <Icon name="chevron-down" className="back-caret" /> Back
        </button>
        <div style={{ flex: 1 }} />
        <button className="btn" disabled={plan.picks.length === 0} onClick={onNext}>
          <Icon name="basket-shopping" /> See grocery list
        </button>
      </div>
    </>
  );
}

// ── Recipe preview modal (in-flow, no navigation away) ───────────────────

function RecipePreviewModal({ recipe, onClose }: { recipe: Recipe; onClose: () => void }) {
  return (
    <div className="recipe-modal-backdrop" onClick={onClose}>
      <div
        className="recipe-modal"
        role="dialog"
        aria-modal="true"
        aria-label={recipe.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="recipe-modal-head">
          <h3>{recipe.title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="xmark" />
          </button>
        </div>
        <div className="recipe-modal-body">
          <div className="guided-meta" style={{ marginTop: 0 }}>
            <span className={`pill ${recipe.difficulty}`}>{recipe.difficulty}</span>
            <span className="pill">{recipe.cookTime} min</span>
            <span className="pill">{recipe.servings} serving{recipe.servings === 1 ? "" : "s"}</span>
          </div>
          {recipe.summary && <p className="summary">{recipe.summary}</p>}
          <section>
            <h4>Ingredients</h4>
            <ul>
              {recipe.ingredients.map((ing, i) => (
                <li key={i}>{ing}</li>
              ))}
            </ul>
          </section>
          <section>
            <h4>Instructions</h4>
            <ol>
              {recipe.instructions.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </section>
        </div>
        <div className="recipe-modal-foot">
          <button className="btn" onClick={onClose}>Back to my week</button>
        </div>
      </div>
    </div>
  );
}

// ── Shopping ───────────────────────────────────────────────────────────

function groupByAisle(list: ShoppingListItem[]): [string, ShoppingListItem[]][] {
  const m = new Map<string, ShoppingListItem[]>();
  for (const item of list) {
    const arr = m.get(item.aisle) ?? [];
    arr.push(item);
    m.set(item.aisle, arr);
  }
  return [...m.entries()];
}

function ShoppingStep({
  items,
  mealCount,
  saving,
  savedPath,
  savedJustNow,
  onAddItem,
  onRemoveItem,
  onBack,
  onSave,
  onGoToPlan,
}: {
  items: ShoppingListItem[];
  mealCount: number;
  saving: boolean;
  savedPath: string | null;
  savedJustNow: boolean;
  onAddItem: (name: string) => void;
  onRemoveItem: (canonical: string) => void;
  onBack: () => void;
  onSave: () => void;
  onGoToPlan: () => void;
}) {
  const [newItem, setNewItem] = useState("");
  const byAisle = useMemo(() => groupByAisle(items), [items]);

  const add = (e: FormEvent) => {
    e.preventDefault();
    onAddItem(newItem);
    setNewItem("");
  };

  return (
    <>
      <div className="muted" style={{ fontSize: 13 }}>
        Your grocery list for {mealCount} meal{mealCount === 1 ? "" : "s"}, deduped so shared
        ingredients are bought once. Add or remove anything before you save.
      </div>

      <form className="add-ing-form" onSubmit={add}>
        <input
          type="text"
          placeholder="Add something to the list…"
          value={newItem}
          onChange={(e) => setNewItem(e.target.value)}
          maxLength={60}
        />
        <button className="btn secondary" type="submit" disabled={!newItem.trim()}>
          <Icon name="plus" /> Add
        </button>
      </form>

      {items.length === 0 ? (
        <div className="empty-state">
          <Icon name="check" className="empty-icon" />
          <div>Nothing to buy. Your week is fully covered by what you have.</div>
        </div>
      ) : (
        byAisle.map(([aisle, list]) => (
          <div key={aisle} className="shopping-group">
            <div className="ing-group-label">{aisle}</div>
            {list.map((item) => (
              <div key={item.canonical} className="shopping-line">
                <div className="shopping-line-main">
                  <span className="shopping-name">{item.name}</span>
                  {item.quantity && <span className="shopping-qty">{item.quantity}</span>}
                  {item.quantityNote && <span className="serves">{item.quantityNote}</span>}
                </div>
                <div className="shopping-line-end">
                  <div className="shopping-for">
                    {item.recipes.map((r) => (
                      <span key={r.id} className="pill">{r.title}</span>
                    ))}
                  </div>
                  <button
                    className="icon-btn shopping-remove"
                    onClick={() => onRemoveItem(item.canonical)}
                    aria-label={`Remove ${item.name}`}
                    title="Remove"
                  >
                    <Icon name="xmark" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))
      )}

      <div className="detail-actions">
        <button className="btn ghost" onClick={onBack}>
          <Icon name="chevron-down" className="back-caret" /> Back
        </button>
        <div style={{ flex: 1 }} />
        {savedPath ? (
          savedJustNow ? (
            <span className="muted" style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 5 }}>
              <Icon name="check" /> Saved to plans
            </span>
          ) : (
            <button className="btn" onClick={onGoToPlan}>
              <Icon name="calendar-days" /> Go to plan
            </button>
          )
        ) : (
          <button className="btn" disabled={saving} onClick={onSave}>
            {saving ? "Saving…" : "Save this plan"}
          </button>
        )}
      </div>
    </>
  );
}

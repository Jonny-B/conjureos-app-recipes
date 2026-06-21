import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  CapturedPhoto,
  Ingredient,
  MoodConstraints,
  PantryItem,
  SavedRecipe,
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
import { saveWeekPlan } from "../features/planStorage";
import { identifyIngredients } from "../features/vision";
import { sanitizeName } from "../features/vision";
import { prettyIngredient } from "../features/scaling";
import { CaptureScreen } from "./CaptureScreen";
import { Icon } from "../icons";

type Step = "mood" | "scan" | "review" | "shopping";
type MoodMode = "ingredients" | "seed" | "text";

const STEPS: { id: Step; label: string }[] = [
  { id: "mood", label: "Mood" },
  { id: "scan", label: "Pantry" },
  { id: "review", label: "Meals" },
  { id: "shopping", label: "Shopping" },
];

function uniq(a: string[]): string[] {
  return [...new Set(a)];
}

export function PlanWeekScreen({
  pantry,
  catalogVersion = 0,
}: {
  pantry: PantryItem[] | null;
  /** Bumped by App when the catalog reloads from the DB, so the memo re-runs. */
  catalogVersion?: number;
}) {
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

  useEffect(() => {
    Promise.all([listSavedRecipes(), loadFavorites()]).then(([s, f]) => {
      setSaved(s);
      setFavs(f);
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

  // ── transitions ─────────────────────────────────────────────────────
  const addChip = (e: FormEvent) => {
    e.preventDefault();
    const n = sanitizeName(chipInput);
    setChipInput("");
    if (n && !includeChips.includes(n)) setIncludeChips((p) => [...p, n]);
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

  const onSave = async () => {
    if (!plan) return;
    setBusy("saving");
    try {
      const { path } = await saveWeekPlan(plan);
      setSavedPath(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
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

  return (
    <div className="browse-screen">
      <div className="browse-header">
        <h2>Plan my week</h2>
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
          onBack={() => setStep("scan")}
          onNext={() => setStep("shopping")}
        />
      )}

      {step === "shopping" && plan && (
        <ShoppingStep
          plan={plan}
          saving={busy === "saving"}
          savedPath={savedPath}
          onBack={() => setStep("review")}
          onSave={onSave}
        />
      )}
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
        What are you in the mood for this week? Pick a few ingredients, start from a recipe you love,
        or just describe it.
      </div>

      <div className="mood-modes">
        {(["ingredients", "seed", "text"] as MoodMode[]).map((m) => (
          <button
            key={m}
            className={`nav-btn${p.mode === m ? " active" : ""}`}
            onClick={() => p.setMode(m)}
          >
            {m === "ingredients" ? "Pick ingredients" : m === "seed" ? "From a recipe" : "Describe it"}
          </button>
        ))}
      </div>

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
        I'll build the week around what you already have. Your pantry has {pantryCount} item
        {pantryCount === 1 ? "" : "s"}. Add a fresh fridge scan if you like.
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
  onBack,
  onNext,
}: {
  plan: WeekPlan;
  onRemove: (id: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <>
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
                <h4>Adds to the list</h4>
                <div className="cov-strip">
                  {pick.marginalNew.map((t) => (
                    <span key={t} className="token-chip to-buy">{prettyIngredient(t)}</span>
                  ))}
                </div>
              </div>
            )}
            <div className="row" style={{ marginTop: "auto" }}>
              <span />
              <button className="btn ghost" onClick={() => onRemove(pick.id)}>
                <Icon name="xmark" /> Swap out
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
          <Icon name="basket-shopping" /> See shopping list
        </button>
      </div>
    </>
  );
}

// ── Shopping ───────────────────────────────────────────────────────────

function ShoppingStep({
  plan,
  saving,
  savedPath,
  onBack,
  onSave,
}: {
  plan: WeekPlan;
  saving: boolean;
  savedPath: string | null;
  onBack: () => void;
  onSave: () => void;
}) {
  const byAisle = useMemo(() => {
    const m = new Map<string, typeof plan.shoppingList>();
    for (const item of plan.shoppingList) {
      const arr = m.get(item.aisle) ?? [];
      arr.push(item);
      m.set(item.aisle, arr);
    }
    return [...m.entries()];
  }, [plan]);

  return (
    <>
      <div className="muted" style={{ fontSize: 13 }}>
        One list for {plan.picks.length} meals, deduped so shared ingredients are bought once.
      </div>

      {plan.shoppingList.length === 0 ? (
        <div className="empty-state">
          <Icon name="check" className="empty-icon" />
          <div>Nothing to buy. Your week is fully covered by what you have.</div>
        </div>
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
                <div className="shopping-for">
                  {item.recipes.map((r) => (
                    <span key={r.id} className="pill">{r.title}</span>
                  ))}
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
          <span className="muted" style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 5 }}>
            <Icon name="check" /> Saved to your plans
          </span>
        ) : (
          <button className="btn" disabled={saving} onClick={onSave}>
            {saving ? "Saving…" : "Save this plan"}
          </button>
        )}
      </div>
    </>
  );
}

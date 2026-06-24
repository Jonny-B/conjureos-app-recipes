import { useEffect, useState } from "react";
import type { PantryItem, Recipe, RecipeSource, SavedRecipe } from "./types";
import { HomeScreen } from "./screens/HomeScreen";
import { RecipesBrowseScreen } from "./screens/RecipesBrowseScreen";
import { PantryScreen } from "./screens/PantryScreen";
import { PlanWeekScreen } from "./screens/PlanWeekScreen";
import { GuidedCook } from "./screens/GuidedCook";
import { RecipesScreen } from "./screens/RecipesScreen";
import { RecipeRow } from "./components/RecipeRow";
import { generateFromDescription } from "./features/recipes";
import { registerActions } from "./bridge/actions";
import { ensureCatalogLoaded } from "./features/catalog";
import { loadPantry, ingredientsFromPantry } from "./features/pantry";
import { listSavedRecipes, markMade, saveRecipe, setSavedRating } from "./features/storage";
import { Icon } from "./icons";
import { APP_VERSION } from "./version";

type Tab = "home" | "recipes" | "cook" | "plan";
type CookMode = "launcher" | "kitchen" | "describe" | "choose";
/** What's loaded into the guided cook. `saved` set when it's a library recipe. */
interface CookTarget {
  recipe: Recipe;
  saved: SavedRecipe | null;
}

const TABS: { id: Tab; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "recipes", label: "Recipes" },
  { id: "cook", label: "Cook" },
  { id: "plan", label: "Plan" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [recipeSource, setRecipeSource] = useState<RecipeSource>("all");
  const [cookMode, setCookMode] = useState<CookMode>("launcher");
  const [cookTarget, setCookTarget] = useState<CookTarget | null>(null);
  // The tab the guided cook was launched from, so Back returns there.
  const [cookOrigin, setCookOrigin] = useState<Tab>("cook");
  const [pantry, setPantry] = useState<PantryItem[] | null>(null);
  const [catalogVersion, setCatalogVersion] = useState(0);

  useEffect(() => {
    registerActions().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[recipes] action registration failed:", err);
    });
    loadPantry().then(setPantry).catch(() => setPantry([]));
    ensureCatalogLoaded()
      .then((changed) => changed && setCatalogVersion((v) => v + 1))
      .catch(() => {});
  }, []);

  // Every "cook this" doorway routes here: load the recipe into the guided cook
  // and switch to the Cook tab.
  const startCook = (recipe: Recipe, saved: SavedRecipe | null = null) => {
    setCookOrigin(tab);
    setCookTarget({ recipe, saved });
    setTab("cook");
  };
  const endCook = () => {
    setCookTarget(null);
    setTab(cookOrigin);
  };
  const openKitchen = () => {
    setCookMode("kitchen");
    setTab("cook");
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>
          <Icon name="utensils" className="brand-icon" />
          Recipes
        </h1>
        <div className="header-spacer" />
        <nav className="app-nav">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`nav-btn${tab === t.id ? " active" : ""}`}
              onClick={() => {
                // Leaving a guided cook via the nav always returns to a real
                // tab view (the launcher / last pane), never a stale recipe.
                setCookTarget(null);
                setTab(t.id);
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="app-body">
        {tab === "home" && (
          <HomeScreen
            pantry={pantry}
            onNavigate={setTab}
            onViewFavorites={() => {
              setRecipeSource("favorites");
              setTab("recipes");
            }}
            onOpenKitchen={openKitchen}
            onCook={startCook}
            catalogVersion={catalogVersion}
          />
        )}
        {tab === "recipes" && (
          <RecipesBrowseScreen
            source={recipeSource}
            onSourceChange={setRecipeSource}
            pantry={pantry}
            onCook={startCook}
            catalogVersion={catalogVersion}
          />
        )}
        {tab === "cook" && (
          <>
            {/* CookTab stays mounted (just hidden) under the guided cook so the
                describe results / choose search / scan progress survive the
                "pick → cook → back to pick another" detour. */}
            <div hidden={!!cookTarget}>
              <CookTab
                mode={cookMode}
                onModeChange={setCookMode}
                pantry={pantry}
                onPantryChange={setPantry}
                onCook={startCook}
                catalogVersion={catalogVersion}
              />
            </div>
            {cookTarget && (
              <GuidedCook
                recipe={cookTarget.recipe}
                pantry={pantry}
                savedRecipe={cookTarget.saved}
                onBack={endCook}
                onMade={() => (cookTarget.saved ? markMade(cookTarget.saved).then(() => {}) : Promise.resolve())}
                onSave={(r) => saveRecipe(r)}
                onRate={(saved, rating) => setSavedRating(saved, rating).then(() => {})}
              />
            )}
          </>
        )}
        {tab === "plan" && <PlanWeekScreen pantry={pantry} catalogVersion={catalogVersion} />}
      </main>
      <footer className="app-version">v{APP_VERSION}</footer>
    </div>
  );
}

/**
 * Cook is the doing. Its launcher offers three ways in — cook from your kitchen
 * (the hero scan/pantry loop), describe a dish for the AI, or pick a saved
 * recipe — each leading to the guided, step-by-step cook.
 */
function CookTab({
  mode,
  onModeChange,
  pantry,
  onPantryChange,
  onCook,
  catalogVersion,
}: {
  mode: CookMode;
  onModeChange: (m: CookMode) => void;
  pantry: PantryItem[] | null;
  onPantryChange: (items: PantryItem[]) => void;
  onCook: (recipe: Recipe, saved: SavedRecipe | null) => void;
  catalogVersion: number;
}) {
  const back = () => onModeChange("launcher");
  if (mode === "kitchen")
    return (
      <PantryScreen
        pantry={pantry}
        onChange={onPantryChange}
        onBack={back}
        onCook={onCook}
        catalogVersion={catalogVersion}
      />
    );
  if (mode === "describe") return <DescribePane pantry={pantry} onBack={back} onCook={onCook} />;
  if (mode === "choose") return <ChoosePane onBack={back} onCook={onCook} />;

  return (
    <div className="cook-launcher">
      <LauncherCard
        icon="carrot"
        title="From my kitchen"
        sub="Scan your fridge or use your pantry, then cook what you can make"
        onClick={() => onModeChange("kitchen")}
      />
      <LauncherCard
        icon="wand"
        title="Describe a dish"
        sub="Tell the AI what you fancy and it writes you a recipe"
        onClick={() => onModeChange("describe")}
      />
      <LauncherCard
        icon="heart"
        title="Favorite recipes"
        sub="Pick one of your saved recipes and cook it step by step"
        onClick={() => onModeChange("choose")}
      />
    </div>
  );
}

function LauncherCard({
  icon,
  title,
  sub,
  onClick,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  title: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button className="launch-card" onClick={onClick}>
      <span className="launch-icon"><Icon name={icon} /></span>
      <span className="launch-text">
        <span className="launch-title">{title}</span>
        <span className="launch-sub">{sub}</span>
      </span>
      <Icon name="chevron-down" className="launch-caret" />
    </button>
  );
}

/** Describe a dish → AI writes recipes → pick one → guided cook. */
function DescribePane({
  pantry,
  onBack,
  onCook,
}: {
  pantry: PantryItem[] | null;
  onBack: () => void;
  onCook: (recipe: Recipe, saved: SavedRecipe | null) => void;
}) {
  const [text, setText] = useState("");
  const [useHave, setUseHave] = useState(false);
  const [state, setState] = useState<
    { kind: "input" } | { kind: "generating" } | { kind: "recipes"; recipes: Recipe[] }
  >({ kind: "input" });
  const [error, setError] = useState<string | null>(null);

  const hasPantry = !!(pantry && pantry.length);
  const seed = () => (useHave && hasPantry ? ingredientsFromPantry(pantry ?? []) : undefined);

  const go = async () => {
    if (!text.trim()) return;
    setError(null);
    setState({ kind: "generating" });
    try {
      const recipes = await generateFromDescription(text, seed());
      setState({ kind: "recipes", recipes });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState({ kind: "input" });
    }
  };

  if (state.kind === "generating")
    return <FullscreenSpinner label="Writing your recipe…" sub="Three takes on your idea. ~10 seconds." />;

  if (state.kind === "recipes")
    return (
      <div className="browse-screen">
        <BackBar label="Describe again" onBack={() => setState({ kind: "input" })} />
        <RecipesScreen
          recipes={state.recipes}
          ingredients={seed() ?? []}
          onEditIngredients={() => setState({ kind: "input" })}
          onRestart={() => setState({ kind: "input" })}
          onCook={(r) => onCook(r, null)}
        />
      </div>
    );

  return (
    <div className="describe-pane">
      <BackBar label="Cook" onBack={onBack} />
      <h2>Describe a dish</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        What are you in the mood for? An ingredient, a cuisine, a craving — I'll write a recipe for it.
      </p>
      <textarea
        className="describe-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. something cozy with chicken and rice, ready in 30 minutes"
        maxLength={400}
        rows={3}
      />
      <label className={`describe-toggle${hasPantry ? "" : " disabled"}`}>
        <input
          type="checkbox"
          checked={useHave && hasPantry}
          disabled={!hasPantry}
          onChange={(e) => setUseHave(e.target.checked)}
        />
        Use what's in my kitchen
        {!hasPantry && <span className="faint"> — scan or add items first</span>}
      </label>
      {error && (
        <div className="status-banner error">
          <Icon name="triangle-exclamation" />
          <span>{error}</span>
        </div>
      )}
      <button className="btn" disabled={!text.trim()} onClick={go}>
        <Icon name="wand" /> Create recipe
      </button>
    </div>
  );
}

/** Pick a saved recipe to cook. */
function ChoosePane({
  onBack,
  onCook,
}: {
  onBack: () => void;
  onCook: (recipe: Recipe, saved: SavedRecipe | null) => void;
}) {
  const [saved, setSaved] = useState<SavedRecipe[]>([]);
  const [q, setQ] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    listSavedRecipes()
      .then((s) => {
        setSaved(s);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const filtered = saved
    .filter((r) => !q || r.title.toLowerCase().includes(q.toLowerCase()))
    // Favorites first, then most-recently saved.
    .sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite));

  return (
    <div className="browse-screen">
      <BackBar label="Cook" onBack={onBack} />
      <h2>Favorite recipes</h2>
      <div className="browse-filter">
        <Icon name="magnifying-glass" />
        <input type="text" placeholder="Search your recipes…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {!loaded ? (
        <div className="center-spinner"><div className="spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <Icon name="bowl-food" className="empty-icon" />
          <div>
            {saved.length === 0
              ? "No saved recipes yet. Add some in the Recipes tab, then cook them here."
              : "No saved recipes match that search."}
          </div>
        </div>
      ) : (
        <div className="browse-list">
          {filtered.map((r) => (
            <RecipeRow
              key={r.path}
              fi={{ kind: "saved", recipe: r, favorite: !!r.favorite }}
              onOpen={() => onCook(r, r)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FullscreenSpinner({ label, sub }: { label: string; sub?: string }) {
  return (
    <div className="center-spinner">
      <div className="spinner" />
      <div style={{ fontWeight: 500 }}>{label}</div>
      {sub && <div className="muted" style={{ fontSize: 13 }}>{sub}</div>}
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


import { useEffect, useState } from "react";
import type { PantryItem, Recipe, RecipeSource, SavedRecipe } from "./types";
import { HomeScreen } from "./screens/HomeScreen";
import { RecipesBrowseScreen } from "./screens/RecipesBrowseScreen";
import { StudioScreen } from "./screens/StudioScreen";
import { AdminScreen } from "./screens/AdminScreen";
import { PantryScreen } from "./screens/PantryScreen";
import { PlansScreen } from "./screens/PlansScreen";
import { GuidedCook } from "./screens/GuidedCook";
import { RecipesScreen } from "./screens/RecipesScreen";
import { generateFromDescription } from "./features/recipes";
import { registerActions } from "./bridge/actions";
import { vfs } from "./bridge/vfs";
import { joinFamily } from "./bridge/recipesApi";
import { ensureCatalogLoaded } from "./features/catalog";
import { loadPantry, ingredientsFromPantry } from "./features/pantry";
import { markMade, saveRecipe } from "./features/storage";
import { useWhoami } from "./hooks/useWhoami";
import { useRole } from "./hooks/useRole";
import { Icon } from "./icons";
import type { IconName } from "./icons";
import { APP_VERSION } from "./version";

type Tab = "home" | "recipes" | "cook" | "plan" | "studio" | "admin";
type CookMode = "kitchen" | "describe";
/** A plans sub-screen to open from the header cog (available on any tab). */
export type PlansIntent = "family" | "stores" | "new";
/** An action a screen contributes to the header settings sheet. */
export interface CogItem {
  key: string;
  label: string;
  icon: IconName;
  onClick: () => void;
  danger?: boolean;
}

const TAB_TITLE: Record<Tab, string> = {
  home: "Home",
  recipes: "Recipes",
  cook: "Cook",
  plan: "Plans",
  studio: "Studio",
  admin: "Admin",
};
/** What's loaded into the guided cook. `saved` set when it's a library recipe. */
interface CookTarget {
  recipe: Recipe;
  saved: SavedRecipe | null;
}

// "cook" is no longer a bottom-bar tab — the two cooking entry points (from my
// kitchen / describe a dish) live on Home now, and the guided cook is reached by
// tapping a recipe. It stays a routable screen (below), just off the nav.
const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "home", label: "Home", icon: "house" },
  { id: "recipes", label: "Recipes", icon: "utensils" },
  { id: "plan", label: "Plans", icon: "calendar-days" },
];

export function App() {
  const who = useWhoami();
  // Role comes from recipes-db (derived from the minted identity token) — the
  // server is authoritative; these tabs are just the reveal (Studio for
  // chef/admin, Admin for admin). Every write re-checks the role server-side.
  const { role, email: myEmail, loading: roleLoading, err: roleErr } = useRole();
  const tabs = [...TABS];
  // Studio (chef blog authoring) is open to chefs AND admins — admins see all
  // role surfaces. The recipes-db chefUpsert re-verifies the role server-side.
  if (role === "chef" || role === "admin")
    tabs.push({ id: "studio" as Tab, label: "Studio", icon: "wand" as IconName });
  if (role === "admin") tabs.push({ id: "admin" as Tab, label: "Admin", icon: "sliders" as IconName });
  const [tab, setTab] = useState<Tab>("home");
  const [recipeSource, setRecipeSource] = useState<RecipeSource>("all");
  const [cookMode, setCookMode] = useState<CookMode>("kitchen");
  const [cookTarget, setCookTarget] = useState<CookTarget | null>(null);
  // The tab the guided cook was launched from, so Back returns there.
  const [cookOrigin, setCookOrigin] = useState<Tab>("cook");
  const [pantry, setPantry] = useState<PantryItem[] | null>(null);
  const [catalogVersion, setCatalogVersion] = useState(0);
  // A family invite code handed over by the ConjureOS shell (from a
  // `?joinFamily=` link) via a VFS file → prompt to join.
  const [pendingJoin, setPendingJoin] = useState<string | null>(null);
  // Header settings cog: a sheet with Family + Stores (any tab), plus whatever
  // plan actions the Plans screen contributes for the plan in view.
  const [cogOpen, setCogOpen] = useState(false);
  const [plansIntent, setPlansIntent] = useState<PlansIntent | null>(null);
  const [cogExtras, setCogExtras] = useState<CogItem[]>([]);
  const goPlans = (intent: PlansIntent) => {
    setCookTarget(null);
    setTab("plan");
    setPlansIntent(intent);
    setCogOpen(false);
  };

  useEffect(() => {
    const HANDOFF = "/home/Documents/Recipes/.family-invite.json";
    const check = async () => {
      try {
        if (!(await vfs.exists(HANDOFF))) return;
        const raw = await vfs.read(HANDOFF);
        await vfs.rm(HANDOFF).catch(() => {});
        const parsed = JSON.parse(raw) as { code?: string; ts?: number };
        const code = (parsed.code ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
        // Ignore a stale handoff (>10 min) — the shell writes it right before it
        // opens us, so a fresh one is seconds old.
        if (code && (!parsed.ts || Date.now() - parsed.ts < 10 * 60 * 1000)) setPendingJoin(code);
      } catch {
        /* no handoff / unreadable — nothing to redeem */
      }
    };
    void check();
    // Also re-check when the app regains focus, in case it was already open when
    // the shell wrote the handoff.
    const onVis = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

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
  const openDescribe = () => {
    setCookMode("describe");
    setTab("cook");
  };

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand-mark">
          <Icon name="utensils" />
        </span>
        <span className="topbar-title">{TAB_TITLE[tab]}</span>
        <button className="topbar-cog" aria-label="Settings" onClick={() => setCogOpen(true)}>
          <Icon name="gear" />
        </button>
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
            onDescribe={openDescribe}
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
                pantry={pantry}
                onPantryChange={setPantry}
                onCook={startCook}
                onExit={() => setTab("home")}
                catalogVersion={catalogVersion}
              />
            </div>
            {cookTarget && (
              <GuidedCook
                recipe={cookTarget.recipe}
                pantry={pantry}
                saved={!!cookTarget.saved}
                onBack={endCook}
                onMade={() => (cookTarget.saved ? markMade(cookTarget.saved).then(() => {}) : Promise.resolve())}
                onSave={(r) => saveRecipe(r).then(() => {})}
              />
            )}
          </>
        )}
        {tab === "plan" && (
          <PlansScreen
            pantry={pantry}
            catalogVersion={catalogVersion}
            intent={plansIntent}
            onIntentConsumed={() => setPlansIntent(null)}
            onCogItems={setCogExtras}
          />
        )}
        {tab === "studio" && <StudioScreen />}
        {tab === "admin" && <AdminScreen myEmail={myEmail} />}
      </main>
      <nav className="tabbar">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`tab${tab === t.id ? " active" : ""}`}
            aria-label={t.label}
            aria-current={tab === t.id ? "page" : undefined}
            onClick={() => {
              // Leaving a guided cook via the nav always returns to a real
              // tab view (the launcher / last pane), never a stale recipe.
              setCookTarget(null);
              setTab(t.id);
            }}
          >
            <span className="tab-icon">
              <Icon name={t.icon} />
            </span>
            <span className="tab-label">{t.label}</span>
          </button>
        ))}
      </nav>
      <footer className="app-version">
        v{APP_VERSION}
        {!roleLoading &&
          (myEmail
            ? ` · ${myEmail} · ${role}`
            : ` · host:${who ? (who.signedIn ? who.email ?? "anon" : "out") : "?"} · ${
                roleErr ? `backend: ${roleErr.slice(0, 60)}` : "not signed in"
              }`)}
      </footer>
      {cogOpen && (
        <div className="sheet-overlay" onClick={() => setCogOpen(false)}>
          <div className="settings-sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-handle" />
            <button className="sheet-item" onClick={() => goPlans("family")}>
              <Icon name="user" /> Family
            </button>
            <button className="sheet-item" onClick={() => goPlans("stores")}>
              <Icon name="store" /> Grocery stores
            </button>
            {cogExtras.length > 0 && <div className="sheet-sep" />}
            {cogExtras.map((it) => (
              <button
                key={it.key}
                className={`sheet-item${it.danger ? " danger" : ""}`}
                onClick={() => {
                  it.onClick();
                  setCogOpen(false);
                }}
              >
                <Icon name={it.icon} /> {it.label}
              </button>
            ))}
            <button className="sheet-item sheet-cancel" onClick={() => setCogOpen(false)}>
              Close
            </button>
          </div>
        </div>
      )}
      {pendingJoin && (
        <FamilyJoinPrompt
          code={pendingJoin}
          onClose={() => setPendingJoin(null)}
          onJoined={() => {
            setPendingJoin(null);
            setCookTarget(null);
            setTab("plan");
          }}
        />
      )}
    </div>
  );
}

/**
 * Shown when the shell hands over a family invite code (from a `?joinFamily=`
 * link). Confirm → join → land on the Plans tab with the new family.
 */
function FamilyJoinPrompt({
  code,
  onClose,
  onJoined,
}: {
  code: string;
  onClose: () => void;
  onJoined: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joinedName, setJoinedName] = useState<string | null>(null);

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const fam = await joinFamily(code);
      setJoinedName(fam.name);
      setTimeout(onJoined, 1100);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setError(
        /family_limit/i.test(m)
          ? "You're already in 3 families — the max."
          : /not_found/i.test(m)
            ? "That invite link isn't valid anymore."
            : "Couldn't join. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="join-overlay" role="dialog" aria-modal="true">
      <div className="join-card">
        {joinedName ? (
          <>
            <span className="join-badge"><Icon name="check" /></span>
            <h3>Joined {joinedName}!</h3>
            <p className="muted">Opening your family plans…</p>
          </>
        ) : (
          <>
            <span className="join-badge"><Icon name="user" /></span>
            <h3>Join a family?</h3>
            <p className="muted">
              You've been invited. Join to share plans and shopping lists that sync live.
            </p>
            {error && <div className="fam-error" style={{ textAlign: "center" }}>{error}</div>}
            <div className="join-actions">
              <button className="btn ghost" onClick={onClose} disabled={busy}>Not now</button>
              <button className="btn" onClick={join} disabled={busy}>{busy ? "Joining…" : "Join"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The two cooking flows, launched from Home: cook from your kitchen (scan /
 * pantry loop) or describe a dish for the AI. Back exits to Home. The guided,
 * step-by-step cook is layered over this by App when a recipe is chosen.
 */
function CookTab({
  mode,
  pantry,
  onPantryChange,
  onCook,
  onExit,
  catalogVersion,
}: {
  mode: CookMode;
  pantry: PantryItem[] | null;
  onPantryChange: (items: PantryItem[]) => void;
  onCook: (recipe: Recipe, saved: SavedRecipe | null) => void;
  onExit: () => void;
  catalogVersion: number;
}) {
  if (mode === "describe") return <DescribePane pantry={pantry} onBack={onExit} onCook={onCook} />;
  return (
    <PantryScreen
      pantry={pantry}
      onChange={onPantryChange}
      onBack={onExit}
      onCook={onCook}
      catalogVersion={catalogVersion}
    />
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
      <BackBar label="Home" onBack={onBack} />
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


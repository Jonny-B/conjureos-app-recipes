import { useEffect, useState } from "react";
import type { PantryItem, Recipe, RecipeSource, SavedRecipe } from "./types";
import { RecipesBrowseScreen } from "./screens/RecipesBrowseScreen";
import { StudioScreen } from "./screens/StudioScreen";
import { AdminScreen } from "./screens/AdminScreen";
import { PantryScreen } from "./screens/PantryScreen";
import { PlansScreen } from "./screens/PlansScreen";
import { GuidedCook } from "./screens/GuidedCook";
import { registerActions } from "./bridge/actions";
import { vfs } from "./bridge/vfs";
import { joinFamily } from "./bridge/recipesApi";
import { ensureCatalogLoaded } from "./features/catalog";
import { loadPantry } from "./features/pantry";
import { markMade, unmarkMade, saveRecipe } from "./features/storage";
import { useWhoami } from "./hooks/useWhoami";
import { useRole } from "./hooks/useRole";
import { Icon } from "./icons";
import type { IconName } from "./icons";
import { AppearanceSheet } from "./components/AppearanceSheet";
import { APP_VERSION } from "./version";

/**
 * The four pillars, in the order the promise makes sense: what you HAVE, what
 * you'll COOK with it, what you still need to BUY, and the library you pick
 * from. Pantry is home — "not just a recipe app" has to be the first thing you
 * see, and a screen that opens on recipe rows cannot say it.
 *
 * `studio` and `admin` are role-gated and appended to the bar at runtime.
 * There is no `cook` tab: the guided cook is an overlay driven by `cookTarget`
 * (below), so Back returns you to whichever tab you left, with its state intact.
 */
type Tab = "pantry" | "plan" | "list" | "recipes" | "studio" | "admin";
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

/** Where the ConjureOS shell drops an invite code for us (shell + native app). */
const HANDOFF_PATH = "/home/Documents/Recipes/.family-invite.json";
/** Older than this and the handoff is someone else's moment, not this one. */
const HANDOFF_TTL_MS = 60 * 60 * 1000;

const TAB_TITLE: Record<Tab, string> = {
  pantry: "Pantry",
  plan: "Plan",
  list: "List",
  recipes: "Recipes",
  studio: "Studio",
  admin: "Admin",
};
/** What's loaded into the guided cook. `saved` set when it's a library recipe. */
interface CookTarget {
  recipe: Recipe;
  saved: SavedRecipe | null;
}

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "pantry", label: "Pantry", icon: "boxes-stacked" },
  { id: "plan", label: "Plan", icon: "calendar-days" },
  { id: "list", label: "List", icon: "list-check" },
  { id: "recipes", label: "Recipes", icon: "utensils" },
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
  const [tab, setTab] = useState<Tab>("pantry");
  const [recipeSource, setRecipeSource] = useState<RecipeSource>("all");
  /** Bumped when a family is joined from the invite prompt — see PlansScreen. */
  const [familyEpoch, setFamilyEpoch] = useState(0);
  const [cookTarget, setCookTarget] = useState<CookTarget | null>(null);
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
  // Appearance lives behind the cog rather than on a tab: it is set once and
  // then almost never, so it should not cost a slot in a four-tab bar.
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const goPlans = (intent: PlansIntent) => {
    setCookTarget(null);
    setTab("plan");
    setPlansIntent(intent);
    setCogOpen(false);
  };

  useEffect(() => {
    const check = async () => {
      try {
        if (!(await vfs.exists(HANDOFF_PATH))) return;
        const parsed = JSON.parse(await vfs.read(HANDOFF_PATH)) as { code?: string; ts?: number };
        const code = (parsed.code ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
        // An invite the shell handed over hours ago isn't what the user is
        // doing now — drop it rather than ambushing them with a stale prompt.
        if (!code || (parsed.ts && Date.now() - parsed.ts > HANDOFF_TTL_MS)) {
          await vfs.rm(HANDOFF_PATH).catch(() => {});
          return;
        }
        setPendingJoin(code);
      } catch {
        /* no handoff / unreadable — nothing to redeem */
      }
    };
    void check();
    // Re-check when the app comes back to the foreground, in case it was
    // already open (warm) when the shell wrote the handoff — in that case the
    // app never remounts, so the mount check above has already been and gone.
    // `focus` covers hosts where an offscreen→onscreen move doesn't fire
    // visibilitychange (notably the native app's warm WebView pool).
    const onVis = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, []);

  useEffect(() => {
    registerActions().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[pantry] action registration failed:", err);
    });
    loadPantry().then(setPantry).catch(() => setPantry([]));
    ensureCatalogLoaded()
      .then((changed) => changed && setCatalogVersion((v) => v + 1))
      .catch(() => {});
  }, []);

  /**
   * Every "cook this" doorway routes here.
   *
   * The guided cook used to be a TAB, which meant starting a cook unmounted
   * whatever you were looking at and Back had to remember where to put you
   * (`cookOrigin`). It's an overlay now: the tab underneath stays mounted and
   * merely hidden, so a scan half-confirmed on the Pantry tab, or a search
   * three screens into the library, is exactly where you left it.
   */
  const startCook = (recipe: Recipe, saved: SavedRecipe | null = null) => setCookTarget({ recipe, saved });
  const endCook = () => setCookTarget(null);

  const cooking = !!cookTarget;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand-mark">
          <Icon name="basket-shopping" />
        </span>
        <span className="topbar-title">{TAB_TITLE[tab]}</span>
        <button className="topbar-cog" aria-label="Settings" onClick={() => setCogOpen(true)}>
          <Icon name="gear" />
        </button>
      </header>
      <main className="app-body">
        {/* Each tab's content is HIDDEN, not unmounted, while the guided cook is
            open — see startCook. */}
        <div hidden={cooking}>
          {tab === "pantry" && (
            <PantryScreen
              pantry={pantry}
              onChange={setPantry}
              onCook={startCook}
              onPlanWeek={() => goPlans("new")}
              onBrowse={() => {
                setRecipeSource("all");
                setTab("recipes");
              }}
              catalogVersion={catalogVersion}
            />
          )}
          {/* Plan and List are two views of the SAME data, so they share one
              mounted screen: one backend load, one realtime subscription, one
              PlanWriter. Rendering them as two elements would double all three
              and let two writers race on the same shopping-list ticks. */}
          {(tab === "plan" || tab === "list") && (
            <PlansScreen
              focus={tab === "list" ? "list" : "plan"}
              pantry={pantry}
              catalogVersion={catalogVersion}
              intent={plansIntent}
              onIntentConsumed={() => setPlansIntent(null)}
              onCogItems={setCogExtras}
              familyEpoch={familyEpoch}
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
          {tab === "studio" && <StudioScreen />}
          {tab === "admin" && <AdminScreen myEmail={myEmail} />}
        </div>
        {cookTarget && (
          <GuidedCook
            // `key` remounts the cook when the recipe changes, so its
            // lazy state initializers re-read the stored session instead
            // of carrying the previous recipe's ticks into this one.
            key={cookTarget.saved?.path ?? cookTarget.recipe.title}
            recipe={cookTarget.recipe}
            pantry={pantry}
            saved={!!cookTarget.saved}
            savedPath={cookTarget.saved?.path ?? null}
            onBack={endCook}
            onMade={() => (cookTarget.saved ? markMade(cookTarget.saved).then(() => {}) : Promise.resolve())}
            // `cookTarget.saved` is the row as it was BEFORE the mark (we
            // never refresh it here), so its lastMadeAt is exactly the
            // value the undo needs to restore.
            onUnmade={
              cookTarget.saved
                ? () => unmarkMade(cookTarget.saved!).then(() => {})
                : undefined
            }
            onSave={(r) => saveRecipe(r).then(() => {})}
          />
        )}
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
            <button
              className="sheet-item"
              onClick={() => {
                setCogOpen(false);
                setAppearanceOpen(true);
              }}
            >
              <Icon name="palette" /> Appearance
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
      {appearanceOpen && <AppearanceSheet onClose={() => setAppearanceOpen(false)} />}
      {pendingJoin && (
        <FamilyJoinPrompt
          code={pendingJoin}
          // Declining consumes the invite; a failed attempt does NOT (the
          // handoff file survives, so the next launch offers it again rather
          // than making them ask for a fresh link over a dropped connection).
          onClose={() => {
            void vfs.rm(HANDOFF_PATH).catch(() => {});
            setPendingJoin(null);
          }}
          onJoined={() => {
            void vfs.rm(HANDOFF_PATH).catch(() => {});
            setPendingJoin(null);
            setCookTarget(null);
            setTab("plan");
            // setTab alone is a no-op when Plan is already the open tab, so the
            // new family's plans wouldn't appear until the user navigated away
            // and back. Bump the epoch so PlansScreen reloads either way.
            setFamilyEpoch((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

/**
 * Shown when the shell hands over a family invite code (from a `?joinFamily=`
 * link). Confirm → join → land on the Plan tab with the new family.
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

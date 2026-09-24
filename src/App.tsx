import { useEffect, useState } from "react";
import type { Recipe, RecipeSource, SavedRecipe } from "./types";
import { RecipesBrowseScreen } from "./screens/RecipesBrowseScreen";
import { StudioScreen } from "./screens/StudioScreen";
import { AdminScreen } from "./screens/AdminScreen";
import { GuidedCook } from "./screens/GuidedCook";
import { registerActions } from "./bridge/actions";
import { ensureCatalogLoaded } from "./features/catalog";
import { markMade, unmarkMade, saveRecipe } from "./features/storage";
import { useWhoami } from "./hooks/useWhoami";
import { useRole } from "./hooks/useRole";
import { Icon } from "./icons";
import type { IconName } from "./icons";
import { AppearanceSheet } from "./components/AppearanceSheet";
import { TermsSheet } from "./components/TermsSheet";
import { Splash } from "./components/Splash";
import { registerTermsOpener } from "./features/terms";
import { APP_VERSION } from "./version";

/**
 * Recipes: a library you add to, browse, and cook from. That is the whole app.
 *
 * WHAT USED TO BE HERE AND IS NOW SOMEWHERE ELSE. This app briefly carried a
 * pantry, a week planner, a shopping list, grocery-store aisle layouts and
 * shared families. All of that is Conjure Pantry now — a separate app in its
 * own repo (`conjureos-pantry`, store slug `pantry`), which owns those
 * mechanics properly instead of bolting them onto a recipe library.
 *
 * The split is the point: Pantry does not author recipes and this app does not
 * track what is in your fridge. Pantry finds recipes through ConjureOS's
 * structural discovery — it declares the SHAPE it wants and the kernel matches
 * it against this app's declared `returns`. So the way to serve Pantry better
 * is to keep `listRecipes` and `getRecipe` honest, NOT to add a pantry back.
 *
 * ONE SCREEN, and a tab bar only when a role earns one. A normal user sees the
 * library and nothing else, because a tab bar with one tab is furniture. Studio
 * (chef authoring) and Admin appear for the roles that have them, and the
 * server re-checks the role on every write. The guided cook is an overlay
 * rather than a tab, so Back returns you to whatever you were looking at with
 * its state intact.
 */
type Tab = "recipes" | "studio" | "admin";

/** The longest the opening screen waits for the catalog before stepping aside. */
const SPLASH_MAX_MS = 6000;

const TAB_TITLE: Record<Tab, string> = {
  recipes: "Recipes",
  studio: "Studio",
  admin: "Admin",
};

/** What's loaded into the guided cook. `saved` set when it's a library recipe. */
interface CookTarget {
  recipe: Recipe;
  saved: SavedRecipe | null;
}

export function App() {
  const who = useWhoami();
  // Role comes from recipes-db (derived from the minted identity token) — the
  // server is authoritative; these tabs are just the reveal (Studio for
  // chef/admin, Admin for admin). Every write re-checks the role server-side.
  const { role, email: myEmail, loading: roleLoading, err: roleErr, banned } = useRole();
  const tabs: { id: Tab; label: string; icon: IconName }[] = [];
  // Only worth drawing a bar when there is more than one thing in it.
  if (role === "chef" || role === "admin") {
    tabs.push({ id: "recipes", label: "Recipes", icon: "utensils" });
    tabs.push({ id: "studio", label: "Studio", icon: "wand" });
  }
  if (role === "admin") tabs.push({ id: "admin", label: "Admin", icon: "sliders" });

  const [tab, setTab] = useState<Tab>("recipes");
  const [recipeSource, setRecipeSource] = useState<RecipeSource>("all");
  const [cookTarget, setCookTarget] = useState<CookTarget | null>(null);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [cogOpen, setCogOpen] = useState(false);
  // The opening screen, up until the catalog has loaded (or SPLASH_MAX_MS).
  const [splash, setSplash] = useState<"up" | "leaving" | "gone">("up");
  // Appearance lives behind the cog rather than on a tab: it is set once and
  // then almost never.
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  /**
   * The Recipes terms sheet. `resolve` is set when a save is waiting on the
   * answer (features/terms.ts's gate); unset when it was opened to read.
   */
  const [terms, setTerms] = useState<null | { resolve?: (ok: boolean) => void }>(null);
  useEffect(() => {
    registerTermsOpener(() => new Promise<boolean>((resolve) => setTerms({ resolve })));
    return () => registerTermsOpener(null);
  }, []);

  useEffect(() => {
    registerActions().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[recipes] action registration failed:", err);
    });
    ensureCatalogLoaded()
      .then((changed) => changed && setCatalogVersion((v) => v + 1))
      .catch(() => {})
      .finally(() => setSplash((s) => (s === "up" ? "leaving" : s)));
    // Never hold the app hostage to a slow network: past this the browse
    // screen's own loading state takes over.
    const cap = setTimeout(() => setSplash((s) => (s === "up" ? "leaving" : s)), SPLASH_MAX_MS);
    return () => clearTimeout(cap);
  }, []);
  // Unmount once the fade (styles.css .splash, 0.35s) has played.
  useEffect(() => {
    if (splash !== "leaving") return;
    const t = setTimeout(() => setSplash("gone"), 400);
    return () => clearTimeout(t);
  }, [splash]);

  /**
   * Every "cook this" doorway routes here. The guided cook is an OVERLAY: the
   * screen underneath stays mounted and merely hidden, so a search three
   * screens into the library is exactly where you left it.
   */
  const startCook = (recipe: Recipe, saved: SavedRecipe | null = null) =>
    setCookTarget({ recipe, saved });
  const endCook = () => setCookTarget(null);

  const cooking = !!cookTarget;

  return (
    <div className={`app${tabs.length > 1 ? " app--rail" : ""}`}>
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
        {banned && (
          // Server-side every action already refuses; this says so instead of
          // letting each screen fail on its own.
          <div className="empty-state banned-notice">
            <Icon name="circle-info" className="empty-icon" />
            <h2>Your access to Recipes has been removed</h2>
            <div>
              An administrator removed your access to Recipes. Your ConjureOS account and your other apps are not
              affected.
            </div>
          </div>
        )}
        {/* Hidden, not unmounted, while the guided cook is open — see startCook. */}
        <div hidden={cooking || banned}>
          {tab === "recipes" && (
            <RecipesBrowseScreen
              source={recipeSource}
              onSourceChange={setRecipeSource}
              onCook={startCook}
              catalogVersion={catalogVersion}
              isAdmin={role === "admin"}
            />
          )}
          {tab === "studio" && <StudioScreen />}
          {tab === "admin" && <AdminScreen myEmail={myEmail} />}
        </div>
        {cookTarget && (
          <GuidedCook
            // `key` remounts the cook when the recipe changes, so its lazy state
            // initializers re-read the stored session instead of carrying the
            // previous recipe's ticks into this one.
            key={cookTarget.saved?.path ?? cookTarget.recipe.title}
            recipe={cookTarget.recipe}
            saved={!!cookTarget.saved}
            savedPath={cookTarget.saved?.path ?? null}
            onBack={endCook}
            onMade={() =>
              cookTarget.saved ? markMade(cookTarget.saved).then(() => {}) : Promise.resolve()
            }
            // `cookTarget.saved` is the row as it was BEFORE the mark (we never
            // refresh it here), so its lastMadeAt is exactly the value the undo
            // needs to restore.
            onUnmade={
              cookTarget.saved ? () => unmarkMade(cookTarget.saved!).then(() => {}) : undefined
            }
            onSave={(r) => saveRecipe(r).then(() => {})}
          />
        )}
      </main>
      {tabs.length > 1 && (
        <nav className="tabbar">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`tab${tab === t.id ? " active" : ""}`}
              aria-label={t.label}
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => {
                // Leaving a guided cook via the nav always returns to a real
                // view, never a stale recipe.
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
      )}
      {splash !== "gone" && <Splash leaving={splash === "leaving"} />}
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
          <div
            className="settings-sheet"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-handle" />
            <button
              className="sheet-item"
              onClick={() => {
                setCogOpen(false);
                setAppearanceOpen(true);
              }}
            >
              <Icon name="palette" /> Appearance
            </button>
            <button
              className="sheet-item"
              onClick={() => {
                setCogOpen(false);
                setTerms({});
              }}
            >
              <Icon name="circle-info" /> Recipe terms
            </button>
            <button className="sheet-item sheet-cancel" onClick={() => setCogOpen(false)}>
              Close
            </button>
          </div>
        </div>
      )}
      {appearanceOpen && <AppearanceSheet onClose={() => setAppearanceOpen(false)} />}
      {terms && (
        <TermsSheet
          asking={!!terms.resolve}
          onClose={(ok) => {
            terms.resolve?.(ok);
            setTerms(null);
          }}
        />
      )}
    </div>
  );
}

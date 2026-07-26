/**
 * Thin wrapper around `window.__conjureos.ai.complete` with a dev-mode
 * mock so the UI is iterable outside ConjureOS via `npm run dev`.
 *
 * The host bridge is gated on the `ai.complete` permission declared in
 * package.json's `conjureos.permissions`. ConjureOS routes the call to
 * the user's BYK key (Sonnet at `capable` tier) or — when they have no
 * key — to the hosted free-tier proxy, which forces Haiku regardless of
 * tier hint. Vision works on both; quality is sharper on Sonnet.
 *
 * The image attachment shape (mediaType + data) was added to the iframe
 * AI bridge in ConjureOS 0.5.29, specifically for this app.
 */

export type ModelTier = "cheap" | "capable" | "epic";

export interface ChatImage {
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  /** Raw base64 — no `data:image/...;base64,` prefix. */
  data: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  images?: ChatImage[];
}

export interface CompleteRequest {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  tier?: ModelTier;
}

declare global {
  /**
   * Shared shape across bridge modules. Each module (ai, actions, etc.)
   * augments this interface with its own sub-property; TypeScript merges
   * the declarations so `window.__conjureos.ai` and `window.__conjureos.actions`
   * both exist on the same object without a conflict.
   */
  interface ConjureosBridge {
    ai?: {
      complete: (req: CompleteRequest) => Promise<{ content: string }>;
    };
  }
  interface Window {
    __conjureos?: ConjureosBridge;
  }
}

const bridge = () => window.__conjureos?.ai?.complete;

export function isBridgeAvailable(): boolean {
  return typeof bridge() === "function";
}

export async function complete(req: CompleteRequest): Promise<string> {
  const fn = bridge();
  if (fn) {
    const res = await fn(req);
    return res.content;
  }
  return mockComplete(req);
}

/**
 * Dev-mode mock — returns deterministic-shaped output so the UI can be
 * developed against `npm run dev`. NOT a substitute for end-to-end
 * testing inside ConjureOS; the real model output will differ.
 */
async function mockComplete(req: CompleteRequest): Promise<string> {
  await new Promise((r) => setTimeout(r, 600));
  // Grocery aisle mapper (store layout → item placements). Extracts the aisle
  // ids + item names from the prompt and round-robins them so the store-sort
  // flow is demonstrable under `npm run dev`. Real placements come from the model.
  if (req.system.includes("map grocery items to the aisles")) {
    const body = req.messages.map((m) => m.content).join("\n");
    const aisleIds = [...body.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    const items = [...body.matchAll(/^- (.+)$/gm)].map((m) => m[1]!.trim());
    const out: Record<string, string> = {};
    if (aisleIds.length) items.forEach((it, i) => (out[it] = aisleIds[i % aisleIds.length]!));
    return JSON.stringify(out);
  }
  // Plan My Week mood interpreter. Returns deterministic structured
  // constraints so the planner is iterable under `npm run dev`.
  if (req.system.includes("meal-plan mood interpreter")) {
    return JSON.stringify({
      includeIngredients: ["chicken", "pasta"],
      cuisines: ["comfort food"],
      dietary: [],
      avoid: [],
      mealCount: 5,
    });
  }
  // Custom-recipe reviewer call (text-only, "recipe reviewer" system). Echoes
  // back a cleaned-looking single recipe so the dev tidy button does something.
  if (req.system.includes("recipe reviewer")) {
    return JSON.stringify({
      title: "Your Tidied Recipe",
      difficulty: "easy",
      cookTime: 25,
      servings: 2,
      summary: "A simple, comforting dish that comes together in about 25 minutes.",
      ingredients: ["2 cups tomatoes", "1 tbsp olive oil", "salt + pepper to taste"],
      instructions: ["Prep the ingredients.", "Cook over medium heat until done.", "Season and serve."],
    });
  }

  // Custom-recipe structuring call (text-only, "recipe formatter" system).
  if (req.system.includes("recipe formatter")) {
    return JSON.stringify({
      title: "Your Tidied Recipe",
      difficulty: "easy",
      cookTime: 25,
      servings: 2,
      summary: "A simple, comforting dish that comes together in about 25 minutes.",
      ingredients: ["2 cups of your main ingredient", "1 tbsp olive oil", "salt + pepper to taste"],
      instructions: [
        "Prep your ingredients as described.",
        "Cook over medium heat until done.",
        "Season and serve.",
      ],
    });
  }

  // Snap-a-recipe transcriber (vision, "recipe transcriber" system). Returns a
  // single structured recipe so the photo-to-recipe flow is iterable in dev.
  // Must come before the generic image branch below (which returns ingredients).
  if (req.system.includes("recipe transcriber")) {
    return JSON.stringify({
      title: "Grandma's Tomato Soup",
      difficulty: "easy",
      cookTime: 30,
      servings: 4,
      summary: "A cozy blended tomato soup finished with a swirl of cream.",
      ingredients: [
        "1 onion, diced",
        "2 cloves garlic, minced",
        "2 tbsp butter",
        "1 (28 oz) can tomatoes",
        "1 cup stock",
        "splash of cream",
        "salt + pepper",
      ],
      instructions: [
        "Sweat the onion and garlic in the butter until soft.",
        "Add the tomatoes and stock; simmer for 20 minutes.",
        "Blend until smooth.",
        "Finish with a splash of cream, season, and serve.",
      ],
    });
  }

  const hasImages = req.messages.some((m) => m.images && m.images.length > 0);
  if (hasImages) {
    return JSON.stringify({
      ingredients: [
        { name: "eggs", confidence: 0.95, notes: "carton, ~6 left" },
        { name: "spinach", confidence: 0.88, notes: "fresh, opened" },
        { name: "red bell pepper", confidence: 0.72 },
        { name: "feta cheese", confidence: 0.65, notes: "small block" },
        { name: "milk", confidence: 0.55 },
        { name: "garlic", confidence: 0.45 },
      ],
    });
  }
  return JSON.stringify({
    recipes: [
      {
        title: "Spinach & Feta Scramble",
        difficulty: "easy",
        cookTime: 10,
        servings: 2,
        summary: "Classic 10-minute scramble — wilted greens, briny cheese.",
        ingredients: ["3 eggs", "1 cup spinach", "30g feta", "1 tsp olive oil", "salt + pepper"],
        instructions: [
          "Heat oil in a non-stick pan over medium.",
          "Add spinach; wilt for 30 seconds.",
          "Beat eggs with salt and pepper; pour over the spinach.",
          "Crumble feta over the top; fold gently until set.",
          "Serve immediately.",
        ],
      },
      {
        title: "Roasted Pepper Frittata",
        difficulty: "medium",
        cookTime: 25,
        servings: 4,
        summary: "Restaurant-feel weeknight bake. Serve with toast.",
        ingredients: ["6 eggs", "1 red bell pepper", "50g feta", "1/4 cup milk", "2 cloves garlic"],
        instructions: [
          "Preheat oven to 200°C / 400°F.",
          "Slice the pepper thinly; mince the garlic.",
          "Sauté pepper + garlic in an oven-safe pan for 4 minutes.",
          "Whisk eggs with milk + salt; pour over the vegetables.",
          "Crumble feta on top; transfer to oven for 12-15 minutes until set.",
          "Cool 2 minutes; slice and serve.",
        ],
      },
      {
        title: "Shakshuka with Feta",
        difficulty: "hard",
        cookTime: 40,
        servings: 4,
        summary: "Spiced tomato base, eggs poached in the sauce. Worth the extra time.",
        ingredients: ["4 eggs", "1 red bell pepper", "50g feta", "2 cloves garlic", "1 can tomatoes", "1 tsp cumin", "1 tsp paprika", "spinach handful"],
        instructions: [
          "Sauté diced pepper and garlic in olive oil until soft.",
          "Add cumin and paprika; bloom for 30 seconds.",
          "Pour in tomatoes; simmer until reduced, ~10 minutes.",
          "Stir in spinach.",
          "Make 4 wells in the sauce; crack an egg into each.",
          "Cover; cook on low until whites are set but yolks runny, 6-8 minutes.",
          "Scatter feta over the top; serve with crusty bread.",
        ],
      },
    ],
  });
}

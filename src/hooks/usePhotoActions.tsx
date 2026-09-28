import { useEffect, useRef, useState } from "react";
import type { Recipe } from "../types";
import { preparePhoto } from "../features/capture";
import { uploadRecipeImage } from "../bridge/recipesApi";
import {
  aiPhotoCost,
  enhanceRecipePhoto,
  generateRecipePhoto,
  isAiEnhanceAvailable,
  isAiPhotoAvailable,
  photoFromUrl,
} from "../features/aiPhoto";
import { ensureTermsAccepted } from "../features/terms";

/**
 * The three ways a recipe gets its photo, in one place, so every surface
 * that sets one (the editor, the open recipe, Admin → Recipes) offers the
 * same choices and behaves the same way:
 *
 *   - **Upload** a photo as it is.
 *   - **Upload & enhance**: upload it, then have the AI retouch it into a
 *     professional-looking shot of the SAME dish (ConjureOS `ai.image.edit`),
 *     stamped "AI-enhanced". **Enhance** does the same to the photo already
 *     on the recipe.
 *   - **Generate** one from scratch from the title and ingredients, stamped
 *     "AI-generated".
 *
 * Each surface only says how a finished URL is saved (`apply`). The ORIGINAL
 * of an enhanced photo is kept in `original` so it is one tap away: an
 * edit model can "improve" the food itself, and the person photographed
 * their own dinner.
 */
export type PhotoOp = "uploading" | "enhancing" | "generating" | "removing";

export interface PhotoSubject {
  recipe: Pick<Recipe, "title" | "ingredients">;
  category?: string | null;
}

export function usePhotoActions({
  subject,
  apply,
}: {
  /** Read at click time, so it reflects the latest edits. */
  subject: () => PhotoSubject;
  /** Save the new photo (null removes it); `ai` marks an AI-made/altered one. */
  apply: (url: string | null, ai: boolean) => Promise<void> | void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pendingEnhance = useRef(false);
  const [busy, setBusy] = useState<PhotoOp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [original, setOriginal] = useState<string | null>(null);
  const canGenerate = isAiPhotoAvailable();
  const canEnhance = isAiEnhanceAvailable();
  const [generateCost, setGenerateCost] = useState<number | null>(null);
  const [enhanceCost, setEnhanceCost] = useState<number | null>(null);
  useEffect(() => {
    if (canGenerate) void aiPhotoCost("image.generate").then(setGenerateCost);
    if (canEnhance) void aiPhotoCost("image.edit").then(setEnhanceCost);
  }, [canGenerate, canEnhance]);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  /** Terms before any busy state, so nothing looks started before "I accept". */
  const termsFirst = async (): Promise<boolean> => {
    try {
      await ensureTermsAccepted();
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };

  const enhance = async (photo: { mediaType: string; base64: string }, originalUrl: string) => {
    setBusy("enhancing");
    try {
      const { url } = await enhanceRecipePhoto(photo, subject().recipe);
      setOriginal(originalUrl);
      await apply(url, true);
    } catch (e) {
      // The original is already in place, so a failed enhance loses nothing.
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so choosing the same file again re-fires onChange.
    e.target.value = "";
    const andEnhance = pendingEnhance.current;
    pendingEnhance.current = false;
    if (!file) return;
    setError(null);
    setBusy("uploading");
    let photo: { mediaType: string; base64: string };
    let url: string;
    try {
      photo = await preparePhoto(file);
      url = await uploadRecipeImage(photo.mediaType, photo.base64);
      setOriginal(null);
      await apply(url, false);
    } catch (err) {
      fail(err);
      setBusy(null);
      return;
    }
    if (andEnhance) await enhance(photo, url);
    else setBusy(null);
  };

  const upload = () => {
    pendingEnhance.current = false;
    inputRef.current?.click();
  };

  const uploadAndEnhance = async () => {
    setError(null);
    if (!(await termsFirst())) return;
    pendingEnhance.current = true;
    inputRef.current?.click();
  };

  /** Enhance the photo the recipe already has. */
  const enhanceExisting = async (url: string) => {
    setError(null);
    if (!(await termsFirst())) return;
    setBusy("enhancing");
    let photo: { mediaType: string; base64: string };
    try {
      photo = await photoFromUrl(url);
    } catch (e) {
      fail(e);
      setBusy(null);
      return;
    }
    await enhance(photo, url);
  };

  const generate = async () => {
    const { recipe, category } = subject();
    if (!recipe.title.trim()) {
      setError("Give the recipe a title first, so the image has something to show.");
      return;
    }
    setError(null);
    if (!(await termsFirst())) return;
    setBusy("generating");
    try {
      const { url } = await generateRecipePhoto(recipe, category);
      setOriginal(null);
      await apply(url, true);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setError(null);
    setBusy("removing");
    try {
      setOriginal(null);
      await apply(null, false);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  /** Put the un-enhanced original back. */
  const restoreOriginal = async () => {
    if (!original) return;
    const url = original;
    setError(null);
    setBusy("uploading");
    try {
      await apply(url, false);
      setOriginal(null);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept="image/jpeg,image/png,image/webp,image/gif"
      hidden
      onChange={(e) => void onFile(e)}
    />
  );

  return {
    busy,
    error,
    original,
    canGenerate,
    canEnhance,
    generateCost,
    enhanceCost,
    fileInput,
    upload,
    uploadAndEnhance,
    enhanceExisting,
    generate,
    remove,
    restoreOriginal,
  };
}

/** What to say while a photo operation runs. */
export function photoBusyText(op: PhotoOp): string {
  switch (op) {
    case "uploading":
      return "Uploading…";
    case "enhancing":
      return "Enhancing your photo — this can take up to a minute. It will be marked “AI-enhanced”.";
    case "generating":
      return "Generating a photo — this can take up to a minute. It will be marked “AI-generated”.";
    case "removing":
      return "Removing the photo…";
  }
}

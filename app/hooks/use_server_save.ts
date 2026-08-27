import { useImportString } from "app/hooks/use_import";
import { DEFAULT_IMPORT_OPTIONS } from "app/lib/convert";
import { geojsonToString } from "app/lib/convert/local/geojson";
import { usePersistence } from "app/lib/persistence/context";
import { atom, useAtomValue, useSetAtom } from "jotai";
import debounce from "lodash/debounce";
import { useCallback, useEffect, useMemo } from "react";
import toast from "react-hot-toast";
import { dataAtom } from "state/jotai";

export type SaveStatus = "idle" | "unsaved" | "saving" | "saved" | "error";

export const saveStatusAtom = atom<SaveStatus>("idle");
export const lastSavedAtAtom = atom<Date | null>(null);

export interface VersionInfo {
  filename: string;
  timestamp: string;
  size: number;
  featureCount: number;
}

/** Debounce delay (in milliseconds) after the user stops modifying map features */
export const DEBOUNCE_DELAY_MS = 2500;

// In-flight guard and cache
let isSaving = false;
let pendingContent: string | null = null;
let lastSavedContent: string | null = null;
let hasInitializedBaseline = false;

// Callbacks registered by active components to receive save state updates
type StateUpdater = (status: SaveStatus, date?: Date) => void;
const listeners = new Set<StateUpdater>();

function notifyState(status: SaveStatus, date?: Date) {
  for (const listener of listeners) {
    listener(status, date);
  }
}

/**
 * Saves GeoJSON content to the server.
 * Uses a simple `isSaving` in-flight lock:
 * If an HTTP request is already in progress, any subsequent edit is queued in `pendingContent`
 * and executed once the current request completes.
 */
async function saveToServer(content: string) {
  if (!content) {
    return;
  }

  // If content is already identical to what was saved, skip
  if (lastSavedContent === content) {
    notifyState("saved");
    return;
  }

  // If a save request is currently in-flight, queue this content
  if (isSaving) {
    pendingContent = content;
    notifyState("unsaved");
    return;
  }

  isSaving = true;
  notifyState("saving");

  try {
    const response = await fetch("/api/save", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ geojson: content }),
    });

    if (!response.ok) {
      const err = await response
        .json()
        .catch(() => ({ error: "Server error" }));
      throw new Error(err.error || `HTTP ${response.status}`);
    }

    const savedDate = new Date();
    lastSavedContent = content;
    notifyState("saved", savedDate);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Save error:", err);
    notifyState("error");
    toast.error(
      err instanceof Error
        ? `Failed to save: ${err.message}`
        : "Failed to save changes to server",
    );
  } finally {
    isSaving = false;

    // If new changes were made while the save request was in-flight, save them now
    if (pendingContent && pendingContent !== lastSavedContent) {
      const next = pendingContent;
      pendingContent = null;
      void saveToServer(next);
    }
  }
}

/**
 * Initializes the baseline content cache without triggering an auto-save.
 */
export function setSavedBaseline(content: string) {
  lastSavedContent = content;
  hasInitializedBaseline = true;
  notifyState("saved", new Date());
}

/**
 * Centralized background auto-save listener.
 * Mount ONCE inside PlacemarkPlay.
 */
export function AutoSaveListener() {
  const data = useAtomValue(dataAtom);
  const setSaveStatus = useSetAtom(saveStatusAtom);
  const setLastSavedAt = useSetAtom(lastSavedAtAtom);

  useEffect(() => {
    const updater: StateUpdater = (status, date) => {
      setSaveStatus(status);
      if (date) {
        setLastSavedAt(date);
      }
    };
    listeners.add(updater);
    return () => {
      listeners.delete(updater);
    };
  }, [setSaveStatus, setLastSavedAt]);

  const debouncedAutoSave = useMemo(
    () =>
      debounce((content: string) => {
        void saveToServer(content);
      }, DEBOUNCE_DELAY_MS),
    [],
  );

  useEffect(() => {
    if (data.featureMap.size === 0) {
      return;
    }

    const currentContent = geojsonToString(data.featureMap, {
      indent: true,
      truncate: true,
      winding: "RFC7946",
    });

    // Establish initial baseline on first data load
    if (!hasInitializedBaseline) {
      setSavedBaseline(currentContent);
      return;
    }

    // Trigger debounced save only when content changed
    if (currentContent !== lastSavedContent) {
      notifyState("unsaved");
      debouncedAutoSave(currentContent);
    }
  }, [data.featureMap, debouncedAutoSave]);

  return null;
}

/**
 * Hook to access save status and manual save/rollback actions.
 */
export function useServerSave() {
  const data = useAtomValue(dataAtom);
  const saveStatus = useAtomValue(saveStatusAtom);
  const setSaveStatus = useSetAtom(saveStatusAtom);
  const setLastSavedAt = useSetAtom(lastSavedAtAtom);
  const doImportString = useImportString();
  const rep = usePersistence();
  const transact = rep.useTransact();

  useEffect(() => {
    const updater: StateUpdater = (status, date) => {
      setSaveStatus(status);
      if (date) {
        setLastSavedAt(date);
      }
    };
    listeners.add(updater);
    return () => {
      listeners.delete(updater);
    };
  }, [setSaveStatus, setLastSavedAt]);

  const manualSave = useCallback(
    async (geojsonContent?: string) => {
      const content =
        geojsonContent ??
        geojsonToString(data.featureMap, {
          indent: true,
          truncate: true,
          winding: "RFC7946",
        });

      if (!content || data.featureMap.size === 0) {
        return;
      }

      await saveToServer(content);
    },
    [data.featureMap],
  );

  const fetchVersions = useCallback(async (): Promise<VersionInfo[]> => {
    const res = await fetch("/api/versions");
    if (!res.ok) {
      throw new Error(`Failed to fetch versions: ${res.statusText}`);
    }
    const body = await res.json();
    return body.versions || [];
  }, []);

  const rollback = useCallback(
    async (filename: string) => {
      notifyState("saving");
      const toastId = toast.loading("Restoring version…");

      try {
        const res = await fetch("/api/rollback", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ filename }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Server error" }));
          throw new Error(err.error || `HTTP ${res.status}`);
        }

        const body = await res.json();

        // Clear any pending save
        pendingContent = null;

        // Clear existing features and import restored features
        await transact({
          note: `Rollback to ${filename}`,
          deleteFeatures: Array.from(data.featureMap.keys()),
          deleteFolders: Array.from(data.folderMap.keys()),
        });

        await doImportString(
          body.geojson,
          {
            ...DEFAULT_IMPORT_OPTIONS,
            type: "geojson",
          },
          () => {},
          "vvc.geojson",
        );

        lastSavedContent = body.geojson;
        notifyState("saved", new Date());

        toast.success("Version restored successfully", { id: toastId });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("Rollback error:", err);
        notifyState("error");
        toast.error(
          err instanceof Error
            ? `Rollback failed: ${err.message}`
            : "Rollback failed",
          { id: toastId },
        );
      }
    },
    [transact, data.featureMap, data.folderMap, doImportString],
  );

  return {
    saveStatus,
    manualSave,
    fetchVersions,
    rollback,
  };
}

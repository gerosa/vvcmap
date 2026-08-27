import {
  CheckIcon,
  ExclamationTriangleIcon,
  ReloadIcon,
} from "@radix-ui/react-icons";
import {
  lastSavedAtAtom,
  saveStatusAtom,
  useServerSave,
} from "app/hooks/use_server_save";
import clsx from "clsx";
import { useAtomValue } from "jotai";
import { Tooltip as T } from "radix-ui";
import { StyledTooltipArrow, TContent } from "./elements";

export function SaveStatus() {
  const saveStatus = useAtomValue(saveStatusAtom);
  const lastSavedAt = useAtomValue(lastSavedAtAtom);
  const { manualSave } = useServerSave();

  if (saveStatus === "idle") {
    return null;
  }

  const formattedTime = lastSavedAt
    ? lastSavedAt.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;

  return (
    <T.Root delayDuration={200}>
      <T.Trigger asChild>
        <button
          type="button"
          onClick={() => manualSave()}
          className={clsx(
            "flex items-center gap-1.5 px-2 py-0.5 text-xs rounded-full border transition-colors cursor-pointer select-none",
            saveStatus === "saving" &&
              "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800",
            saveStatus === "saved" &&
              "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800 hover:bg-emerald-100",
            saveStatus === "unsaved" &&
              "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800 hover:bg-amber-100",
            saveStatus === "error" &&
              "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:border-rose-800 hover:bg-rose-100",
          )}
        >
          {saveStatus === "saving" && (
            <>
              <ReloadIcon className="w-3 h-3 animate-spin" />
              <span>Saving…</span>
            </>
          )}
          {saveStatus === "saved" && (
            <>
              <CheckIcon className="w-3.5 h-3.5" />
              <span>Saved</span>
            </>
          )}
          {saveStatus === "unsaved" && (
            <>
              <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
              <span>Unsaved changes</span>
            </>
          )}
          {saveStatus === "error" && (
            <>
              <ExclamationTriangleIcon className="w-3 h-3" />
              <span>Save error</span>
            </>
          )}
        </button>
      </T.Trigger>
      <TContent>
        <StyledTooltipArrow />
        {saveStatus === "saving" && "Saving changes to server…"}
        {saveStatus === "saved" &&
          (formattedTime
            ? `All changes saved to server (last saved ${formattedTime}). Click to save now.`
            : "All changes saved to server. Click to save now.")}
        {saveStatus === "unsaved" &&
          "Unsaved changes will be auto-saved shortly. Click to save immediately."}
        {saveStatus === "error" && "Error saving to server. Click to retry."}
      </TContent>
    </T.Root>
  );
}

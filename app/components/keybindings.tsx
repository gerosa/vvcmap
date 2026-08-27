import { useMapKeybindings } from "app/hooks/use_map_keybindings";
import { useOpenFiles } from "app/hooks/use_open_files";
import { useServerSave } from "app/hooks/use_server_save";
import { captureException } from "integrations/errors";
import { useHotkeys } from "integrations/hotkeys";
import { useSetAtom } from "jotai";
import { dialogAtom } from "state/jotai";

export function Keybindings() {
  const setDialogState = useSetAtom(dialogAtom);
  const { manualSave } = useServerSave();
  const openFiles = useOpenFiles();

  useMapKeybindings();

  useHotkeys(
    "/",
    (e) => {
      e.preventDefault();
      setDialogState({ type: "quickswitcher" });
    },
    [setDialogState],
  );

  useHotkeys(
    "meta+k, Ctrl+k",
    (e) => {
      e.preventDefault();
      setDialogState({ type: "quickswitcher" });
    },
    [setDialogState],
  );

  useHotkeys(
    "meta+shift+s, Ctrl+shift+s",
    (e) => {
      // Don't type a / in the input.
      e.preventDefault();
      setDialogState({
        type: "export",
      });
    },
    [setDialogState],
  );

  useHotkeys(
    "Shift+/",
    (e) => {
      // Don't type a / in the input.
      e.preventDefault();
      setDialogState((modalState) => {
        if (modalState) return modalState;
        return {
          type: "cheatsheet",
        };
      });
    },
    [setDialogState],
  );

  useHotkeys(
    "meta+s, Ctrl+s",
    (e) => {
      e.preventDefault();
      manualSave().catch((e) => captureException(e));
    },
    [manualSave],
  );

  useHotkeys(
    "meta+o, Ctrl+o",
    (e) => {
      e.preventDefault();
      openFiles().catch((e) => captureException(e));
    },
    [openFiles],
  );

  return null;
}

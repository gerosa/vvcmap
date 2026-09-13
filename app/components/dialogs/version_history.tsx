import { CounterClockwiseClockIcon, ResetIcon } from "@radix-ui/react-icons";
import { useQuery } from "@tanstack/react-query";
import { DialogHeader } from "app/components/dialog";
import { Button, Loading, TextWell } from "app/components/elements";
import { useServerSave, type VersionInfo } from "app/hooks/use_server_save";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(isoString: string): string {
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return isoString;
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return isoString;
  }
}

export function VersionHistoryDialog({ onClose }: { onClose: () => void }) {
  const { fetchVersions, rollback } = useServerSave();

  const {
    data: versions,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ["server-versions"],
    queryFn: fetchVersions,
    refetchOnWindowFocus: true,
  });

  const handleRollback = async (version: VersionInfo) => {
    // eslint-disable-next-line no-alert
    const confirmed = window.confirm(
      `Are you sure you want to restore the version from ${formatDate(
        version.timestamp,
      )}? Current state will be backed up before rollback.`,
    );
    if (!confirmed) return;

    await rollback(version.filename);
    onClose();
  };

  return (
    <>
      <DialogHeader
        title="Version History & Backups"
        titleIcon={CounterClockwiseClockIcon}
      />
      <TextWell>
        Every time changes are saved to <code>public/vvc.geojson</code>, an
        automatic timestamped snapshot is archived. You can inspect or restore
        any previous version below.
      </TextWell>

      <div className="mt-4">
        {isLoading ? (
          <div className="py-8 flex justify-center items-center">
            <Loading />
          </div>
        ) : isError ? (
          <TextWell variant="destructive">
            Failed to load versions:{" "}
            {error instanceof Error ? error.message : "Unknown error"}
          </TextWell>
        ) : !versions || versions.length === 0 ? (
          <div className="py-6 text-center text-sm text-gray-500 dark:text-gray-400 border border-dashed border-gray-200 dark:border-gray-700 rounded-md">
            No previous version snapshots found yet.
            <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">
              Snapshots will appear here automatically when edits are saved.
            </div>
          </div>
        ) : (
          <div className="max-h-72 overflow-y-auto placemark-scrollbar divide-y divide-gray-100 dark:divide-gray-800 border border-gray-200 dark:border-gray-700 rounded-md">
            {versions.map((version) => (
              <div
                key={version.filename}
                className="p-2.5 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors"
              >
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {formatDate(version.timestamp)}
                  </span>
                  <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <span>
                      {version.featureCount}{" "}
                      {version.featureCount === 1 ? "feature" : "features"}
                    </span>
                    <span>•</span>
                    <span>{formatBytes(version.size)}</span>
                  </div>
                </div>
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => handleRollback(version)}
                  title="Restore this version to the map"
                >
                  <ResetIcon className="w-3 h-3 mr-1" />
                  Restore
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 flex justify-end">
        <Button onClick={onClose}>Close</Button>
      </div>
    </>
  );
}

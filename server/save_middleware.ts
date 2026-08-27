import type { IncomingMessage, ServerResponse } from "node:http";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Plugin, ViteDevServer } from "vite";

interface SaveRequestBody {
  geojson: string;
  name?: string;
}

interface RollbackRequestBody {
  filename: string;
}

export interface VersionInfo {
  filename: string;
  timestamp: string;
  size: number;
  featureCount: number;
}

function parseJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        if (!data.trim()) {
          resolve({} as T);
        } else {
          resolve(JSON.parse(data));
        }
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function getFeatureCount(geojsonStr: string): number {
  try {
    const parsed = JSON.parse(geojsonStr);
    if (parsed && Array.isArray(parsed.features)) {
      return parsed.features.length;
    }
    return 1;
  } catch {
    return 0;
  }
}

export function createSaveApiMiddleware(rootDirectory: string = process.cwd()) {
  const publicDir = path.resolve(rootDirectory, "public");
  const backupsDir = path.resolve(rootDirectory, "backups");
  const targetGeojsonPath = path.resolve(publicDir, "vvc.geojson");

  let saveMutex = Promise.resolve();

  return async function saveApiMiddleware(
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ) {
    const url = req.url?.split("?")[0];

    if (!url?.startsWith("/api/")) {
      return next();
    }

    try {
      // 1. SAVE ENDPOINT
      if (req.method === "POST" && url === "/api/save") {
        const body = await parseJsonBody<SaveRequestBody>(req);
        if (!body.geojson) {
          return sendJson(res, 400, {
            error: "Missing 'geojson' in request body",
          });
        }

        // Validate JSON
        let featureCount = 0;
        try {
          featureCount = getFeatureCount(body.geojson);
        } catch {
          return sendJson(res, 400, { error: "Invalid GeoJSON string" });
        }

        // Acquire server-side save lock to serialize file operations
        let releaseLock: () => void;
        const currentLock = new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
        const previousLock = saveMutex;
        saveMutex = previousLock.then(() => currentLock);

        await previousLock;

        try {
          await fs.mkdir(publicDir, { recursive: true });
          await fs.mkdir(backupsDir, { recursive: true });

          // Check if existing file should be backed up or if content is identical
          let backupFileName: string | null = null;
          try {
            const existingContent = await fs.readFile(targetGeojsonPath, "utf-8");
            if (existingContent.trim() === body.geojson.trim()) {
              console.log("[save-api] Content unchanged; skipped redundant write and backup.");
              return sendJson(res, 200, {
                success: true,
                timestamp: new Date().toISOString(),
                featureCount,
                backup: null,
                skipped: true,
              });
            }

            const timestampStr = new Date()
              .toISOString()
              .replace(/[:.]/g, "-");
            backupFileName = `vvc-${timestampStr}.geojson`;
            const backupPath = path.resolve(backupsDir, backupFileName);
            await fs.writeFile(backupPath, existingContent, "utf-8");
          } catch {
            // File may not exist yet, no backup needed
          }

          // Save new content
          await fs.writeFile(targetGeojsonPath, body.geojson, "utf-8");

          console.log(
            `[save-api] ✓ Saved ${featureCount} features to public/vvc.geojson${
              backupFileName ? ` (archived backup: ${backupFileName})` : " (initial save)"
            }`,
          );

          return sendJson(res, 200, {
            success: true,
            timestamp: new Date().toISOString(),
            featureCount,
            backup: backupFileName,
          });
        } finally {
          releaseLock!();
        }
      }

      // 2. VERSIONS LIST ENDPOINT
      if (req.method === "GET" && url === "/api/versions") {
        await fs.mkdir(backupsDir, { recursive: true });
        const files = await fs.readdir(backupsDir);
        const geojsonFiles = files.filter((f) => f.endsWith(".geojson"));

        const versions: VersionInfo[] = [];

        for (const filename of geojsonFiles) {
          const filePath = path.resolve(backupsDir, filename);
          try {
            const stats = await fs.stat(filePath);
            const content = await fs.readFile(filePath, "utf-8");
            const featureCount = getFeatureCount(content);

            // Extract ISO timestamp from filename if available, fallback to mtime
            let timestamp = stats.mtime.toISOString();
            const match = filename.match(/^vvc-(pre-rollback-)?(\d{4}-\d{2}-\d{2}T[\d-]+Z?)\.geojson$/);
            if (match) {
              const formatted = match[2]
                .replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})(.*)$/, "$1:$2:$3$4");
              timestamp = formatted;
            }

            versions.push({
              filename,
              timestamp,
              size: stats.size,
              featureCount,
            });
          } catch {
            // Ignore unreadable files
          }
        }

        // Sort descending by timestamp
        versions.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        console.log(`[save-api] Listed ${versions.length} backup version(s).`);
        return sendJson(res, 200, { versions });
      }

      // 3. ROLLBACK ENDPOINT
      if (req.method === "POST" && url === "/api/rollback") {
        const body = await parseJsonBody<RollbackRequestBody>(req);
        if (!body.filename) {
          return sendJson(res, 400, {
            error: "Missing 'filename' in request body",
          });
        }

        // Security check: ensure filename is just a filename with no directory traversal
        const safeFilename = path.basename(body.filename);
        if (!safeFilename.endsWith(".geojson")) {
          return sendJson(res, 400, { error: "Invalid backup file type" });
        }

        const backupFilePath = path.resolve(backupsDir, safeFilename);
        const backupContent = await fs.readFile(backupFilePath, "utf-8");

        // Backup current file before rollback
        let preRollbackBackupFileName: string | null = null;
        try {
          const currentContent = await fs.readFile(targetGeojsonPath, "utf-8");
          const timestampStr = new Date().toISOString().replace(/[:.]/g, "-");
          preRollbackBackupFileName = `vvc-pre-rollback-${timestampStr}.geojson`;
          const preRollbackBackup = path.resolve(
            backupsDir,
            preRollbackBackupFileName,
          );
          await fs.writeFile(preRollbackBackup, currentContent, "utf-8");
        } catch {
          // If current file doesn't exist, ignore
        }

        // Write restored file
        await fs.writeFile(targetGeojsonPath, backupContent, "utf-8");

        const restoredCount = getFeatureCount(backupContent);
        console.log(
          `[save-api] ↩ Rollback: restored public/vvc.geojson from backups/${safeFilename} (${restoredCount} features)${
            preRollbackBackupFileName ? ` (saved pre-rollback snapshot: ${preRollbackBackupFileName})` : ""
          }`,
        );

        return sendJson(res, 200, {
          success: true,
          filename: safeFilename,
          geojson: backupContent,
          featureCount: restoredCount,
        });
      }

      // Unknown /api route
      return sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[save-api] ✗ Error handling request:", message);
      return sendJson(res, 500, { error: message });
    }
  };
}

export function saveMiddlewarePlugin(): Plugin {
  return {
    name: "save-api-middleware",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(createSaveApiMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(createSaveApiMiddleware());
    },
  };
}

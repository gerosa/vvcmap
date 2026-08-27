import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";
import { createSaveApiMiddleware } from "./save_middleware";
import type { IncomingMessage, ServerResponse } from "node:http";

class MockIncomingMessage extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string>;

  constructor(method: string, url: string) {
    super();
    this.method = method;
    this.url = url;
    this.headers = {};
  }
}

class MockServerResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";

  setHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  end(data?: string) {
    if (data) this.body = data;
    this.emit("finish");
  }
}

function runMiddleware(
  middleware: ReturnType<typeof createSaveApiMiddleware>,
  req: MockIncomingMessage,
  res: MockServerResponse,
  bodyData?: string,
): Promise<{ statusCode: number; json: any }> {
  return new Promise((resolve, reject) => {
    res.on("finish", () => {
      try {
        const json = res.body ? JSON.parse(res.body) : null;
        resolve({ statusCode: res.statusCode, json });
      } catch (err) {
        reject(err);
      }
    });

    middleware(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      () => {
        resolve({ statusCode: res.statusCode, json: null });
      },
    );

    if (bodyData !== undefined) {
      req.emit("data", Buffer.from(bodyData));
    }
    req.emit("end");
  });
}

describe("saveApiMiddleware", () => {
  let tempDir: string;
  let middleware: ReturnType<typeof createSaveApiMiddleware>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vvcmap-test-"));
    middleware = createSaveApiMiddleware(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("saves GeoJSON and creates a backup of previous version", async () => {
    const sampleGeoJSON1 = JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { id: "L01", nome: "Test Lot 1" },
          geometry: { type: "Point", coordinates: [-40.6, -19.9] },
        },
      ],
    });

    const sampleGeoJSON2 = JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { id: "L01", nome: "Test Lot 1 Updated" },
          geometry: { type: "Point", coordinates: [-40.6, -19.9] },
        },
        {
          type: "Feature",
          properties: { id: "L02", nome: "Test Lot 2" },
          geometry: { type: "Point", coordinates: [-40.61, -19.91] },
        },
      ],
    });

    // 1. Initial save
    const req1 = new MockIncomingMessage("POST", "/api/save");
    const res1 = new MockServerResponse();
    const result1 = await runMiddleware(
      middleware,
      req1,
      res1,
      JSON.stringify({ geojson: sampleGeoJSON1 }),
    );

    expect(result1.statusCode).toBe(200);
    expect(result1.json.success).toBe(true);
    expect(result1.json.featureCount).toBe(1);

    // Verify file written to public/vvc.geojson
    const savedContent = await fs.readFile(
      path.join(tempDir, "public", "vvc.geojson"),
      "utf-8",
    );
    expect(JSON.parse(savedContent).features[0].properties.nome).toBe(
      "Test Lot 1",
    );

    // 2. Second save with changes -> should trigger a backup of version 1
    const req2 = new MockIncomingMessage("POST", "/api/save");
    const res2 = new MockServerResponse();
    const result2 = await runMiddleware(
      middleware,
      req2,
      res2,
      JSON.stringify({ geojson: sampleGeoJSON2 }),
    );

    expect(result2.statusCode).toBe(200);
    expect(result2.json.success).toBe(true);
    expect(result2.json.featureCount).toBe(2);
    expect(result2.json.backup).toBeTruthy();

    // 3. Check versions list
    const reqVersions = new MockIncomingMessage("GET", "/api/versions");
    const resVersions = new MockServerResponse();
    const versionsResult = await runMiddleware(
      middleware,
      reqVersions,
      resVersions,
    );

    expect(versionsResult.statusCode).toBe(200);
    expect(versionsResult.json.versions.length).toBe(1);
    expect(versionsResult.json.versions[0].featureCount).toBe(1);

    // 4. Rollback to backup version
    const backupFilename = versionsResult.json.versions[0].filename;
    const reqRollback = new MockIncomingMessage("POST", "/api/rollback");
    const resRollback = new MockServerResponse();
    const rollbackResult = await runMiddleware(
      middleware,
      reqRollback,
      resRollback,
      JSON.stringify({ filename: backupFilename }),
    );

    expect(rollbackResult.statusCode).toBe(200);
    expect(rollbackResult.json.success).toBe(true);
    expect(rollbackResult.json.featureCount).toBe(1);

    // Check restored file on disk
    const restoredContent = await fs.readFile(
      path.join(tempDir, "public", "vvc.geojson"),
      "utf-8",
    );
    expect(JSON.parse(restoredContent).features[0].properties.nome).toBe(
      "Test Lot 1",
    );
  });

  it("skips duplicate backup when saving identical content very close", async () => {
    const geojson = JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { id: "L01" },
          geometry: { type: "Point", coordinates: [-40.6, -19.9] },
        },
      ],
    });

    // First save
    const req1 = new MockIncomingMessage("POST", "/api/save");
    const res1 = new MockServerResponse();
    const res1Data = await runMiddleware(middleware, req1, res1, JSON.stringify({ geojson }));
    expect(res1Data.statusCode).toBe(200);

    // Second save immediately with identical content
    const req2 = new MockIncomingMessage("POST", "/api/save");
    const res2 = new MockServerResponse();
    const res2Data = await runMiddleware(middleware, req2, res2, JSON.stringify({ geojson }));
    expect(res2Data.statusCode).toBe(200);
    expect(res2Data.json.skipped).toBe(true);
    expect(res2Data.json.backup).toBeNull();

    // Verify backups directory has 0 backup files (no spurious duplicates)
    const backups = await fs.readdir(path.join(tempDir, "backups"));
    expect(backups.filter((f) => f.endsWith(".geojson")).length).toBe(0);
  });

  it("serializes concurrent save requests with mutex lock without file corruption", async () => {
    const createGeoJson = (name: string) =>
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { id: "L01", nome: name },
            geometry: { type: "Point", coordinates: [-40.6, -19.9] },
          },
        ],
      });

    // Fire 3 saves concurrently
    const promises = [
      runMiddleware(
        middleware,
        new MockIncomingMessage("POST", "/api/save"),
        new MockServerResponse(),
        JSON.stringify({ geojson: createGeoJson("Version 1") }),
      ),
      runMiddleware(
        middleware,
        new MockIncomingMessage("POST", "/api/save"),
        new MockServerResponse(),
        JSON.stringify({ geojson: createGeoJson("Version 2") }),
      ),
      runMiddleware(
        middleware,
        new MockIncomingMessage("POST", "/api/save"),
        new MockServerResponse(),
        JSON.stringify({ geojson: createGeoJson("Version 3") }),
      ),
    ];

    const results = await Promise.all(promises);
    for (const r of results) {
      expect(r.statusCode).toBe(200);
      expect(r.json.success).toBe(true);
    }

    // Final content should be valid JSON
    const finalContent = await fs.readFile(
      path.join(tempDir, "public", "vvc.geojson"),
      "utf-8",
    );
    const parsed = JSON.parse(finalContent);
    expect(parsed.type).toBe("FeatureCollection");
    expect(parsed.features[0].properties.nome).toBe("Version 3");
  });
});

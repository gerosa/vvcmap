import { describe, expect, it, vi } from "vitest";

vi.mock("app/lib/worker", () => {
  return {};
});

import { DEBOUNCE_DELAY_MS } from "./use_server_save";

describe("use_server_save settings", () => {
  it("defines appropriate debounce delay to prevent rapid consecutive saves", () => {
    expect(DEBOUNCE_DELAY_MS).toBeGreaterThanOrEqual(1000);
  });
});

import { describe, expect, it } from "vitest";
import { app } from "./index";

describe("Worker API", () => {
  it("reports a healthy service", async () => {
    const response = await app.request("http://local.test/api/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "music-library",
      status: "ok",
    });
  });

  it("returns JSON for unknown API routes", async () => {
    const response = await app.request("http://local.test/api/missing");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "not_found",
    });
  });
});

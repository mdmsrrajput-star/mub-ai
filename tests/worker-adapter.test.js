import test from "node:test";
import assert from "node:assert/strict";
import { invokeVercelHandler } from "../api/_lib/vercel-adapter.js";

test("adapter maps URL query, headers, method, and Worker env to a Vercel-style handler", async () => {
  const request = new Request("https://mub-test.workers.dev/api/example?symbol=BTCUSDT", {
    method: "GET",
    headers: { "x-paper-key": "test-key" }
  });
  const response = await invokeVercelHandler(async (req, res, env) => {
    assert.equal(req.method, "GET");
    assert.equal(req.query.symbol, "BTCUSDT");
    assert.equal(req.headers["x-paper-key"], "test-key");
    assert.equal(env.PAPER_WRITE_KEY, "server-secret");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: true });
  }, request, { PAPER_WRITE_KEY: "server-secret" });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true });
});

test("adapter parses JSON request bodies and preserves handler status", async () => {
  const request = new Request("https://mub-test.workers.dev/api/example", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "start", amount: 1 })
  });
  const response = await invokeVercelHandler(async (req, res) => {
    assert.deepEqual(req.body, { action: "start", amount: 1 });
    return res.status(201).json({ ok: true, created: true });
  }, request, {});

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true, created: true });
});

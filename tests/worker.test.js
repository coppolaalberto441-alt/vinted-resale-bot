import test from "node:test";
import assert from "node:assert/strict";
import { dispatchGithubWorkflow, isSetupCommand, resaleEstimate, shouldDispatch, topicColor } from "../src/index.js";

test("recognizes setup commands with an optional bot username", () => {
  assert.equal(isSetupCommand("/setup"), true);
  assert.equal(isSetupCommand(" /setup@vingtoBot "), true);
  assert.equal(isSetupCommand("/setup-now"), false);
  assert.equal(isSetupCommand("setup"), false);
});

test("topic colors repeat only after all six Telegram colors", () => {
  const colors = Array.from({ length: 6 }, (_, index) => topicColor(index));
  assert.equal(new Set(colors).size, 6);
  assert.equal(topicColor(6), topicColor(0));
});

test("dispatches the scanner workflow on main and records success", async () => {
  const writes = [];
  const env = {
    GITHUB_ACTIONS_TOKEN: "test-token",
    DB: {
      prepare() {
        return {
          bind(...values) {
            writes.push(values);
            return { run: async () => ({ success: true }) };
          }
        };
      }
    }
  };
  let request;
  await dispatchGithubWorkflow(env, async (url, options) => {
    request = { url, options };
    return new Response(null, { status: 204 });
  });

  assert.match(request.url, /vinted-scan\.yml\/dispatches$/);
  assert.equal(request.options.method, "POST");
  assert.deepEqual(JSON.parse(request.options.body), { ref: "main" });
  assert.equal(request.options.headers.authorization, "Bearer test-token");
  assert.equal(writes[0][0], "last_dispatch_at");
});

test("fails when GitHub rejects the workflow dispatch", async () => {
  const env = { GITHUB_ACTIONS_TOKEN: "test-token" };
  await assert.rejects(
    dispatchGithubWorkflow(env, async () => new Response("denied", { status: 403 })),
    /HTTP 403: denied/
  );
});

test("throttles duplicate cron events until the five-minute window", () => {
  const now = Date.parse("2026-10-04T20:30:00.000Z");
  assert.equal(shouldDispatch("2026-10-04T20:26:00.000Z", now), false);
  assert.equal(shouldDispatch("2026-10-04T20:25:00.000Z", now), true);
  assert.equal(shouldDispatch(null, now), true);
});

test("estimates a realistic resale range below the active median", () => {
  assert.deepEqual(resaleEstimate(100, 45), {
    low: 75,
    high: 90,
    profitLow: 30,
    profitHigh: 45
  });
  assert.deepEqual(resaleEstimate(40, 15), {
    low: 30,
    high: 36,
    profitLow: 15,
    profitHigh: 21
  });
  assert.equal(resaleEstimate(0, 10), null);
});

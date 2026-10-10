import test from "node:test";
import assert from "node:assert/strict";
import { dispatchGithubWorkflow, isSetupCommand, productCategory, resaleEstimate, selectDeals, shouldDispatch, topicColor } from "../src/index.js";
import { makeCover, shouldRefreshHourly } from '../src/index.js';
import worker from '../src/index.js';
import { assessDeals, diagnosticText } from '../src/index.js';
import { isFreshCatalog, scanUnhealthy } from '../src/index.js';

test('catalog freshness and failure thresholds use bounded UTC timestamps', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  assert.equal(isFreshCatalog('2026-10-09T11:50:00Z', now), true);
  assert.equal(isFreshCatalog('2026-10-09T11:40:00Z', now), false);
  assert.equal(isFreshCatalog('2026-10-09T13:00:00Z', now), false);
  assert.equal(isFreshCatalog(null, now), false);
  assert.equal(scanUnhealthy({ completed_at: '2026-10-09T11:55:00Z', consecutive_failures: 2 }, now), false);
  assert.equal(scanUnhealthy({ completed_at: '2026-10-09T11:55:00Z', consecutive_failures: 3 }, now), true);
  assert.equal(scanUnhealthy({ completed_at: '2026-10-09T11:55:00Z', last_healthy_at: '2026-10-09T11:30:00Z' }, now), true);
});

test('each rejected item has one concrete reason without changing the deal selection', () => {
  const items = [{ title: 'Felpa', price: 0 }, { title: 'Solo modello', price: 2 },
    { title: 'Giacca', price: 3 }, ...[5, 80, 100].map(price => ({ title: 'Felpa', price }))];
  const result = assessDeals(items);
  assert.deepEqual(result.counts, { invalid_price: 1, unknown_category: 1, few_comparables: 1, above_threshold: 2 });
  assert.equal(result.deals.length, 1);
  assert.equal(Object.values(result.counts).reduce((a, b) => a + b, 0) + result.deals.length, items.length);
  assert.deepEqual(selectDeals(items), result.deals);
});

test('status distinguishes partial and stale scans and never presents old quota as live', () => {
  const summary = { completed_at: '2026-10-08T12:00:00Z', expected_brands: 40,
    results: [{ query: 'Nike', items: 50, published: 2, diagnostics: { unknown_category: 3 } }], failed_brands: ['Stone Island'] };
  const usage = { day: '2026-10-07', rowsWritten: 100000, checked_at: '2026-10-07T12:00:00Z' };
  const text = diagnosticText(summary, 5, usage, false, '', Date.parse('2026-10-08T12:05:00Z'));
  assert.match(text, /Scansione parziale/);
  assert.match(text, /1\/40/);
  assert.match(text, /in coda: 5/);
  assert.match(text, /verifica aggiornata non disponibile/);
  assert.match(diagnosticText(summary, 0, null, false, '', Date.parse('2026-10-08T13:00:00Z')), /riepilogo vecchio/);
  assert.match(diagnosticText(summary, 0, null, true, 'Nike'), /Categoria non riconosciuta: 3/);
});

test('scan summary requires authentication and adds a server-side timestamp', async () => {
  const writes = [];
  const env = { INGEST_SECRET: 'test', DB: { prepare() { return { first: async () => null, bind(...values) { writes.push(values); return { run: async () => ({ success: true }) }; } }; } } };
  const unauth = await worker.fetch(new Request('https://test/scan-summary', { method: 'POST' }), env, {});
  assert.equal(unauth.status, 401);
  assert.equal(writes.length, 0);
  const response = await worker.fetch(new Request('https://test/scan-summary', { method: 'POST', headers: { authorization: 'Bearer test' }, body: JSON.stringify({ results: [], failed_brands: ['Nike'] }) }), env, {});
  assert.equal(response.status, 200);
  assert.equal(writes[0][0], 'last_scan_summary');
  assert.ok(Number.isFinite(Date.parse(JSON.parse(writes[0][1]).completed_at)));
});

test('exhausted D1 returns a controlled error even when error logging cannot write', async () => {
  let writes = 0;
  const env = { INGEST_SECRET: 'test', DB: { prepare() {
    return { bind() { return this; }, async first() {
      throw new Error("D1_ERROR: Your account has exceeded D1's free tier daily row write limit");
    }, async run() { writes++; throw new Error('unavailable'); } };
  } } };
  const response = await worker.fetch(new Request('https://test/ingest', {
    method: 'POST', headers: { authorization: 'Bearer test' },
    body: JSON.stringify({ scans: [{ query: 'Timberland', items: [] }] })
  }), env, {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'quota_exhausted');
  assert.equal(writes, 0);
});

test('three same-category comparables suffice and maglioncino is recognized', () => {
  const deals = selectDeals([5, 80, 100, 110].map(price => ({ title: 'Felpa', price })));
  assert.equal(deals.length, 1);
  assert.equal(productCategory({ title: 'Maglioncino Stone Island' }), 'knitwear');
  assert.equal(productCategory({ title: 'Smanicato puffer' }), 'jacket');
});

test('cover stops before inference when the free daily budget is exhausted', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  let message;
  globalThis.fetch = async (_url, options) => {
    message = JSON.parse(options.body);
    return Response.json({ ok: true, result: {} });
  };
  try {
    const env = {
      DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
      AI: { run: async () => { called = true; } }, TELEGRAM_BOT_TOKEN: 'test'
    };
    await makeCover(env, new Uint8Array([1]), 'test-photo', { chat_id: 1 });
    assert.equal(called, false);
    assert.match(message.text, /Limite gratuito/);
  } finally { globalThis.fetch = originalFetch; }
});

test('refreshes profile hourly while search dispatch remains every five minutes', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  assert.equal(shouldRefreshHourly('2026-10-07T11:55:00Z', now), false);
  assert.equal(shouldRefreshHourly('2026-10-07 11:55:00', now), false);
  assert.equal(shouldRefreshHourly('2026-10-07T11:00:00Z', now), true);
  assert.equal(shouldDispatch('2026-10-07T11:55:00Z', now), true);
});

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

test("estimates one quick-sale price below the active median", () => {
  assert.deepEqual(resaleEstimate(100, 45), {
    quickSale: 75,
    profit: 30
  });
  assert.deepEqual(resaleEstimate(40, 15), {
    quickSale: 30,
    profit: 15
  });
  assert.equal(resaleEstimate(0, 10), null);
});

test("uses same-category listings as price comparables", () => {
  const items = [
    ...[48, 50, 60, 70, 80].map((price) => ({ title: "Sneakers modello", price })),
    ...[200, 220, 240, 260, 280].map((price) => ({ title: "Giacca modello", price }))
  ];
  assert.deepEqual(selectDeals(items), []);
  items[0].price = 25;
  const deals = selectDeals(items);
  assert.equal(deals.length, 1);
  assert.equal(deals[0].median, 60);
});

test("never compares a t-shirt price with hoodies from the same brand", () => {
  const items = [
    { title: "T-shirt logo", price: 10 },
    { title: "T-shirt bianca", price: 12 },
    { title: "T-shirt nera", price: 14 },
    { title: "Felpa cappuccio", price: 70 },
    { title: "Hoodie zip", price: 80 },
    { title: "Felpa logo", price: 90 }
  ];
  assert.deepEqual(selectDeals(items), []);
  assert.equal(productCategory({ title: "Maglietta vintage" }), "tshirt");
  assert.equal(productCategory({ title: "Piumino invernale" }), "jacket");
});

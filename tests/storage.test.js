import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { ingestProfile, ingestBrand, sendDiagnostic } from '../src/index.js';

test('Telegram status and brand rejection report read real storage without database writes', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sqlite.exec("INSERT INTO telegram_groups(chat_id,title) VALUES('1','Test')");
  const summary = { completed_at: new Date().toISOString(), expected_brands: 40, failed_brands: [],
    results: [{ query: 'Stone Island', items: 50, published: 3, diagnostics: { unknown_category: 7 } }] };
  sqlite.prepare('INSERT INTO state VALUES(?,?)').run('last_scan_summary', JSON.stringify(summary));
  let writes = 0;
  const env = { TELEGRAM_BOT_TOKEN: 'test', DB: { prepare(sql) {
    const statement = { bind(...params) { return {
      async first() { return sqlite.prepare(sql).get(...params); },
      async all() { return { results: sqlite.prepare(sql).all(...params) }; },
      async run() { writes++; return sqlite.prepare(sql).run(...params); }
    }; } };
    return Object.assign(statement, statement.bind());
  } } };
  const originalFetch = globalThis.fetch;
  const messages = [];
  globalThis.fetch = async (_url, options) => { messages.push(JSON.parse(options.body)); return Response.json({ ok: true, result: {} }); };
  try {
    await sendDiagnostic(env, { chat: { id: 1 }, message_thread_id: 77, text: '/stato' }, false);
    await sendDiagnostic(env, { chat: { id: 1 }, text: '/scarti@vingtoBot Stone Island' }, true);
    assert.equal(messages[0].message_thread_id, 77);
    assert.match(messages[0].text, /Notifiche confermate in questa scansione: 3/);
    assert.match(messages[1].text, /Categoria non riconosciuta: 7/);
    assert.equal(writes, 0);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('excess offers survive the next empty scan, with no repeated hourly status writes', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sqlite.exec("INSERT INTO brand_state VALUES('Test',1,CURRENT_TIMESTAMP)");
  let queries = 0;
  let statusWrites = 0;
  const env = { TELEGRAM_BOT_TOKEN: 'test', CHANNEL_ID: '1', DB: { prepare(sql) {
    const statement = { bind(...params) {
      assert.ok(params.length <= 100);
      return {
        async first() { queries++; return sqlite.prepare(sql).get(...params); },
        async all() { queries++; return { results: sqlite.prepare(sql).all(...params) }; },
        async run() {
          queries++;
          if (sql.startsWith('INSERT INTO brand_state')) statusWrites++;
          return sqlite.prepare(sql).run(...params);
        }
      };
    } };
    return Object.assign(statement, statement.bind());
  } } };
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return Response.json({ ok: true, result: {} });
  };
  try {
    const items = [...Array(5).fill(5), ...Array(8).fill(100)].map((price, i) => ({
      id: String(i + 1), title: 'Felpa', price, url: `https://www.vinted.it/items/${i + 1}`
    }));
    await ingestBrand(env, { query: 'Test', items }, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM pending_deals').get().n, 5);
    assert.ok(queries < 50);
    queries = 0;
    await ingestBrand(env, { query: 'Test', items: [] }, 1);
    assert.equal(sent.length, 1);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM pending_deals').get().n, 4);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM seen_items').get().n, 1);
    assert.equal(statusWrites, 0);
    assert.ok(queries < 50);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('100 listings fit the free per-request query and parameter limits and hourly refresh skips rewrites', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  let queries = 0;
  const env = { DB: { prepare(sql) {
    const statement = { bind(...params) {
      assert.ok(params.length <= 100);
      return {
        async first() { queries++; return sqlite.prepare(sql).get(...params); },
        async run() { queries++; return sqlite.prepare(sql).run(...params); }
      };
    } };
    return Object.assign(statement, statement.bind());
  } } };
  try {
    const items = Array.from({ length: 100 }, (_, i) => ({
      id: String(i + 1), title: 'Maglietta Nike', price: 20,
      url: `https://www.vinted.it/items/${i + 1}`, favourites: 3,
      published_at: '2026-09-01T12:00:00Z'
    }));
    assert.deepEqual(await ingestProfile(env, items), { active: 100 });
    assert.ok(queries < 50);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM user_listings').get().n, 100);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM user_listing_snapshots').get().n, 100);
    const before = queries;
    assert.deepEqual(await ingestProfile(env, items), { skipped: true });
    assert.equal(queries - before, 1);
  } finally { sqlite.close(); }
});

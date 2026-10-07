import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { ingestProfile } from '../src/index.js';

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

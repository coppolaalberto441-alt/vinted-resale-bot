import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../brands.json' with { type: 'json' };
import { verifiedBrandItem } from '../src/brand-match.js';
import { assessDeals } from '../src/index.js';
import { ingestBrand } from '../src/index.js';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

test('all 40 brands reject foreign and missing declared brands, including keyword spam', () => {
  for (const { query } of config.brands) {
    assert.ok(verifiedBrandItem({ brand: query }, query));
    assert.equal(verifiedBrandItem({ brand: 'Nike', title: query }, query), null);
    assert.equal(verifiedBrandItem({ title: query }, query), null);
  }
  assert.ok(verifiedBrandItem({ details: 'Jaded London · L · Buone' }, 'Jaded London'));
  assert.equal(verifiedBrandItem({ brand: 'Adidas', details: 'Jaded London · L · Buone' }, 'Jaded London'), null);
  assert.ok(verifiedBrandItem({ brand: 'Stüssy' }, 'Stussy'));
  assert.ok(verifiedBrandItem({ brand: 'Carhartt WIP' }, 'Carhartt'));
  assert.ok(verifiedBrandItem({ brand: 'Arte' }, 'Arte Antwerp'));
  assert.ok(verifiedBrandItem({ brand: 'PESO' }, 'Peso Clothing'));
  assert.equal(verifiedBrandItem({ brand: 'Nike x Stussy' }, 'Stussy'), null);
});

test('selection compares brands separately and allows a 30 percent discount, not every cheap item', () => {
  const items = [15, 25, 30, 35].map((price, i) => ({ id: String(i), brand: 'Jaded London', title: 'Hoodie', price }));
  items.push(...[2, 3, 4].map(price => ({ brand: 'Nike', title: 'Hoodie', price })));
  assert.ok(assessDeals(items).deals.some(deal => deal.item.id === '0'));
  assert.equal(assessDeals([{ title: 'Hoodie', brand: 'Jaded London', price: 15 }]).deals.length, 0);
});

test('extra comparisons provide evidence but cannot become old alert candidates', () => {
  const candidate = { id: '10317680949', brand: 'Jaded London', title: 'Hoodie', price: 15, total: 16.45 };
  const peers = [25, 30, 40].map((price, i) => ({ id: String(i), brand: 'Jaded London', title: 'Hoodie', price }));
  peers.push({ id: 'old-cheap', brand: 'Jaded London', title: 'Hoodie', price: 1 });
  const result = assessDeals([candidate], peers);
  assert.deepEqual(result.deals.map(deal => deal.item.id), ['10317680949']);
});

test('real ingestion verifies old-reader brands before queueing, statistics and Telegram', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sqlite.exec("INSERT INTO brand_state VALUES('Jaded London',1,CURRENT_TIMESTAMP)");
  let queries = 0;
  const env = { TELEGRAM_BOT_TOKEN: 'test', CHANNEL_ID: '1', DB: { prepare(sql) {
    const statement = { bind(...params) { assert.ok(params.length <= 100); return {
      async first() { queries++; return sqlite.prepare(sql).get(...params); },
      async all() { queries++; return { results: sqlite.prepare(sql).all(...params) }; },
      async run() { queries++; return sqlite.prepare(sql).run(...params); }
    }; } };
    return Object.assign(statement, statement.bind());
  } } };
  const candidate = { id: '10317680949', title: 'Jaded London Hoodie', details: 'Jaded London · L · Buone', price: 15, total: 16.45, url: 'https://www.vinted.it/items/10317680949' };
  const foreign = { id: 'nike', title: 'Jaded London Hoodie Nike', brand: 'Nike', price: 1, url: 'https://www.vinted.it/items/nike' };
  sqlite.prepare('INSERT INTO pending_deals(item_id,brand,payload) VALUES(?,?,?)').run('nike','Jaded London',JSON.stringify({item:foreign,total:1,median:100}));
  const references = [25,30,40].map((price,i) => ({id:`peer${i}`,title:'Hoodie',brand:'Jaded London',price}));
  const saved = globalThis.fetch, sent = [];
  globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return Response.json({ ok: true, result: {} }); };
  try {
    const result = await ingestBrand(env, { query: 'Jaded London', items: [candidate, foreign, {id:'unknown',title:'Hoodie',price:1}], comparables: references, checked_at:new Date().toISOString() }, 1);
    assert.equal(result.published, 1);
    assert.equal(result.diagnostics.brand_mismatch, 1);
    assert.equal(result.diagnostics.brand_unknown, 1);
    assert.equal(sent[0].reply_markup.inline_keyboard[0][0].url, candidate.url);
    assert.deepEqual(sqlite.prepare('SELECT item_id FROM seen_items').all().map(row=>row.item_id),[candidate.id]);
    assert.equal(sqlite.prepare('SELECT listings FROM brand_observations').get().listings, 1);
    const cache = JSON.parse(sqlite.prepare("SELECT value FROM state WHERE key='resale_catalog:Jaded London'").get().value);
    assert.ok(cache.items.every(item=>item.brand==='Jaded London'));
    assert.equal(cache.items.length,4);
    assert.ok(queries < 50);
  } finally { globalThis.fetch=saved; sqlite.close(); }
});

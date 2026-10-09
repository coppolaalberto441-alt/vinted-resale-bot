import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { purchaseAdvice, catalogSnapshot } from '../src/purchase-advice.js';
import { handleResaleTools } from '../src/resale-tools.js';
import { productCategory } from '../src/index.js';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const env = { DB: { prepare(sql) {
    const statement = { bind(...params) { return {
      async first() { return sqlite.prepare(sql).get(...params); },
      async all() { return { results: sqlite.prepare(sql).all(...params) }; },
      async run() { return sqlite.prepare(sql).run(...params); }
    }; } };
    return Object.assign(statement, statement.bind());
  } } };
  return { sqlite, env };
}

const trade = { item_id: '123', brand: 'Nike', cost_cents: 1350 };
const sample = [10, 40, 45, 50, 55].map((price, index) => ({ id: index === 0 ? '123' : `peer${index}`,
  title: 'Felpa Nike', brand: 'Nike', condition: 'Ottime', price, currency: 'EUR' }));

test('advice recognises cached items and paid cost changes only margin, never market price', async () => {
  const { sqlite, env } = fixture();
  const timestamp = new Date().toISOString();
  sqlite.prepare('INSERT INTO state VALUES(?,?)').run('resale_catalog:Nike', JSON.stringify(catalogSnapshot(sample, timestamp)));
  try {
    const text = await purchaseAdvice(env, trade, '', productCategory);
    // Q1 of [40,45,50,55] is 43.75: floor(0.8*43.75)=35; floor(0.85*47.5)=40.
    assert.match(text, /35.00 EUR–40.00 EUR/);
    assert.match(text, /Margine stimato: 21.50 EUR–26.50 EUR/);
    const expensive = await purchaseAdvice(env, { ...trade, cost_cents: 10000 }, '', productCategory);
    assert.match(expensive, /35.00 EUR–40.00 EUR/);
    assert.match(expensive, /vendere in perdita/);
  } finally { sqlite.close(); }
});

test('unknown category is requested instead of using another type or inventing a profitable price', async () => {
  const { sqlite, env } = fixture();
  try {
    assert.match(await purchaseAdvice(env, trade, '', productCategory), /serve il tipo/);
    sqlite.prepare("INSERT INTO category_observations(bucket,brand,category,listings,median_price) VALUES('hour','Nike','hoodie',10,100)").run();
    const text = await purchaseAdvice(env, trade, 'maglietta', productCategory);
    assert.match(text, /Stima non disponibile/);
    assert.doesNotMatch(text, /70.00/);
  } finally { sqlite.close(); }
});

test('fallback labels hourly category median honestly and refuses stale evidence', async () => {
  const { sqlite, env } = fixture();
  sqlite.prepare('INSERT INTO state VALUES(?,?)').run('resale_catalog:Nike', JSON.stringify(catalogSnapshot(sample, '2020-01-01T00:00:00Z')));
  try {
    assert.match(await purchaseAdvice(env, trade, 'felpa', productCategory), /Stima non disponibile/);
    sqlite.prepare("INSERT INTO category_observations(bucket,brand,category,listings,median_price) VALUES('hour','Nike','hoodie',10,50)").run();
    const text = await purchaseAdvice(env, trade, 'felpa', productCategory);
    assert.match(text, /35.00 EUR–40.00 EUR/);
    assert.match(text, /molto bassa/);
    assert.match(text, /una mediana aggregata/);
    sqlite.exec("UPDATE category_observations SET observed_at='2020-01-01 00:00:00'");
    assert.match(await purchaseAdvice(env, trade, 'felpa', productCategory), /Stima non disponibile/);
  } finally { sqlite.close(); }
});

test('purchase command replies with advice and duplicate input cannot change its recorded cost', async () => {
  const { sqlite, env } = fixture();
  sqlite.exec("INSERT INTO telegram_groups(chat_id,title) VALUES('1','Test')");
  sqlite.prepare('INSERT INTO state VALUES(?,?)').run('resale_catalog:Nike', JSON.stringify(catalogSnapshot(sample, new Date().toISOString())));
  const replies = [], telegram = async (_env, _action, payload) => { replies.push(payload.text); return {}; };
  const command = (text, user = 10) => handleResaleTools(env, { chat: { id: 1 }, from: { id: user }, text }, telegram, ['Nike'], productCategory);
  try {
    await command('/acquisto 123 | Nike | 13,50');
    assert.match(replies.at(-1), /Rivendita proposta/);
    await command('/acquisto 123 | Nike | 999');
    assert.match(replies.at(-1), /Costo registrato: 13.50/);
    await command('/stima 123 | felpa', 11);
    assert.match(replies.at(-1), /Acquisto non trovato/);
    await command('/stima 123 | felpa');
    assert.match(replies.at(-1), /Rivendita proposta/);
    await command('/acquisto 124 | Nike | 20 | sconosciuto');
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM resale_trades WHERE item_id='124'").get().n, 0);
  } finally { sqlite.close(); }
});

test('snapshots stay bounded and contain no photos, cookies or account credentials', () => {
  const snapshot = catalogSnapshot(Array(120).fill({ id: '1', title: 'Felpa', price: 10, image_url: 'https://image', cookie: 'secret' }), 'time');
  assert.equal(snapshot.items.length, 100);
  assert.equal(snapshot.items[0].image_url, undefined);
  assert.equal(snapshot.items[0].cookie, undefined);
});

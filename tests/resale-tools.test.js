import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { parseFilters, matchesFilters, rankOffers, eurosToCents, handleResaleTools } from '../src/resale-tools.js';
import { ingestBrand } from '../src/index.js';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sqlite.exec("INSERT INTO telegram_groups(chat_id,title) VALUES('1','Test')");
  let queries = 0;
  const env = { TELEGRAM_BOT_TOKEN: 'test', CHANNEL_ID: '1', DB: { prepare(sql) {
    const statement = { bind(...params) {
      assert.ok(params.length <= 100);
      return { async first() { queries++; return sqlite.prepare(sql).get(...params); },
        async all() { queries++; return { results: sqlite.prepare(sql).all(...params) }; },
        async run() { queries++; return sqlite.prepare(sql).run(...params); } };
    } };
    return Object.assign(statement, statement.bind());
  } } };
  return { sqlite, env, queries: () => queries };
}

test('filter parsing validates options, retains settings and supports reset', () => {
  assert.deepEqual(parseFilters('max=80 margine=12,50 taglie=m,L condizioni=very_good'), {
    max: 80, margine: 12.5, taglie: ['M','L'], condizioni: ['very_good'] });
  assert.deepEqual(parseFilters('taglie=*', { max: 40 }), { max: 40, taglie: [] });
  assert.deepEqual(parseFilters('reset', { max: 40 }), {});
  for (const input of ['max=-1', 'max=NaN', 'max=', 'unknown=3', 'condizioni=perfect', 'taglie=<bad>']) assert.throws(() => parseFilters(input));
});

test('filters use total cost, conservative margin and reject missing size/condition evidence', () => {
  const item = { price: 10, total: 13, size: 'm', condition: 'Ottime' };
  assert.equal(matchesFilters(item, { marginLow: 15 }, { max: 15, margine: 10, taglie: ['M'], condizioni: ['very_good'] }), true);
  assert.equal(matchesFilters(item, null, { margine: 0 }), false);
  assert.equal(matchesFilters(item, { marginLow: 2 }, { margine: 10 }), false);
  assert.equal(matchesFilters(item, null, { max: 12 }), false);
  assert.equal(matchesFilters({ price: 5 }, null, { taglie: ['M'] }), false);
  assert.equal(matchesFilters({ price: 5 }, null, { condizioni: ['good'] }), false);
  assert.equal(matchesFilters({ price: 5 }, null, {}), true);
});

test('priority prefers evidence then conservative margin, with stable ties and no invented margin', () => {
  const offers = [
    { id: 'generic', resale: { confidence: 'molto bassa', marginLow: 100 } },
    { id: 'low', resale: { confidence: 'bassa', marginLow: 80 } },
    { id: 'medium', resale: { confidence: 'media', marginLow: 10 } },
    { id: 'medium2', resale: { confidence: 'media', marginLow: 15 } },
    { id: 'none', resale: null }
  ];
  assert.deepEqual(rankOffers(offers).map(offer => offer.id), ['medium2','medium','low','generic','none']);
  assert.equal(offers[0].id, 'generic');
});

test('cent arithmetic rejects malformed money and supports zero net income', () => {
  assert.equal(eurosToCents('25,50'), 2550);
  assert.equal(eurosToCents('0', true), 0);
  for (const value of ['-2','25.555','1e4','0','NaN']) assert.throws(() => eurosToCents(value));
});

test('only admins in the configured group can change shared filters', async () => {
  const { sqlite, env } = fixture();
  const replies = [];
  let status = 'member';
  const telegram = async (_env, action, payload) => {
    if (action === 'getChatMember') return { status };
    replies.push(payload.text);
    return {};
  };
  const msg = { chat: { id: 1 }, from: { id: 10 }, text: '/filtri max=80' };
  try {
    await handleResaleTools(env, msg, telegram, ['Nike']);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM state').get().n, 0);
    assert.match(replies.at(-1), /Solo gli amministratori/);
    status = 'administrator';
    await handleResaleTools(env, msg, telegram, ['Nike']);
    assert.equal(JSON.parse(sqlite.prepare('SELECT value FROM state').get().value).max, 80);
    await handleResaleTools(env, { ...msg, chat: { id: 2 }, text: '/filtri reset' }, telegram, ['Nike']);
    assert.match(replies.at(-1), /gruppo attualmente configurato/);
    await handleResaleTools(env, { ...msg, text: '/filtri max=-1' }, telegram, ['Nike']);
    assert.equal(JSON.parse(sqlite.prepare('SELECT value FROM state').get().value).max, 80);
  } finally { sqlite.close(); }
});

test('real trade storage isolates users, keeps duplicate purchases intact and never counts unsold profits', async () => {
  const { sqlite, env } = fixture();
  const replies = [];
  const telegram = async (_env, _action, payload) => { replies.push(payload.text); return {}; };
  const command = (text, user = 10) => handleResaleTools(env, { chat: { id: 1 }, from: { id: user }, text }, telegram, ['Nike']);
  try {
    await command('/acquisto 123 | Nike | 25,50');
    await command('/acquisto 123 | Nike | 999');
    assert.equal(sqlite.prepare('SELECT cost_cents FROM resale_trades').get().cost_cents, 2550);
    await command('/vendita 123 | 40', 11);
    assert.equal(sqlite.prepare('SELECT sold_at FROM resale_trades').get().sold_at, null);
    await command('/acquisto 124 | Nike | 20');
    await command('/vendita 123 | 40');
    await command('/vendita 123 | 80');
    assert.equal(sqlite.prepare("SELECT proceeds_cents FROM resale_trades WHERE item_id='123'").get().proceeds_cents, 4000);
    await command('/risultati');
    assert.match(replies.at(-1), /1\/2 venduti · risultato 14.50 EUR · capitale negli invenduti 20.00 EUR/);
    await command('/risultati', 11);
    assert.match(replies.at(-1), /Nessun dato/);
    await command('/vendita 124 | 0');
    await command('/risultati');
    assert.match(replies.at(-1), /risultato -5.50 EUR/);
  } finally { sqlite.close(); }
});

test('ingestion actually filters then prioritizes current queued deals within free query limits', async () => {
  const { sqlite, env, queries } = fixture();
  sqlite.exec("INSERT INTO brand_state VALUES('Nike',1,CURRENT_TIMESTAMP)");
  sqlite.prepare('INSERT INTO state VALUES(?,?)').run('offer_filters:1', JSON.stringify({ max: 15, taglie: ['M'] }));
  const items = [
    { id: 'first', price: 9, size: 'M' },
    { id: 'best', price: 5, size: 'M' },
    { id: 'size', price: 2, size: 'L' },
    { id: 'price', price: 20, size: 'M' },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `peer${i}`, price: 100, size: 'M' }))
  ].map(item => ({ ...item, title: 'Felpa Nike', brand: 'Nike', condition: 'Ottime', url: `https://www.vinted.it/items/${item.id}` }));
  const saved = globalThis.fetch, sent = [];
  globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return Response.json({ ok: true, result: {} }); };
  try {
    await ingestBrand(env, { query: 'Nike', items, checked_at: new Date().toISOString() }, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].reply_markup.inline_keyboard[0][0].url, 'https://www.vinted.it/items/best');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM pending_deals').get().n, 3);
    assert.ok(queries() < 50);
  } finally { globalThis.fetch = saved; sqlite.close(); }
});

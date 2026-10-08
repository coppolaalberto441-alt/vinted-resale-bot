import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateResale, conditionOf, createResaleEstimator } from '../src/estimates.js';
import { productCategory, publish } from '../src/index.js';

const target = { id: 'target', title: 'Nike Dunk Low', brand: 'Nike', condition: 'Ottime', price: 10, total: 12 };
const peers = (prices, changes = {}) => prices.map((price, i) => ({ ...target, id: `peer${i}`, price, total: price + 50, ...changes }));

test('estimates use asking prices, exclude the candidate and remove extreme outliers', () => {
  const sample = peers([40, 45, 50, 55, 60, 1000]);
  const estimate = estimateResale(target, [target, ...sample], 'Nike', productCategory);
  assert.equal(estimate.count, 5);
  assert.equal(estimate.outliers, 1);
  assert.equal(estimate.median, 50);
  assert.equal(estimate.low, 36);
  assert.equal(estimate.high, 42);
  assert.equal(estimate.marginLow, 24);
  assert.equal(estimate.confidence, 'bassa');
  assert.deepEqual(createResaleEstimator(sample, 'Nike', productCategory)(target), estimate);
});

test('different categories, brands, conditions, Dunk High and SB are not mixed', () => {
  const invalid = [
    ...peers([100, 110, 120], { title: 'Felpa Nike Dunk Low' }),
    ...peers([100, 110, 120], { brand: 'Adidas' }),
    ...peers([100, 110, 120], { condition: 'Nuovo con cartellino' }),
    ...peers([100, 110, 120], { title: 'Nike Dunk High' }),
    ...peers([100, 110, 120], { title: 'Nike SB Dunk Low' }),
  ];
  assert.equal(estimateResale(target, invalid, 'Nike', productCategory), null);
});

test('numeric models and duplicate listings cannot create a misleading sample', () => {
  const item = { ...target, title: 'Nike Jordan 1 Low' };
  assert.equal(estimateResale(item, peers([40, 50, 60], { title: 'Nike Jordan 4 Low' }), 'Nike', productCategory), null);
  const sample = peers([40, 50, 60]);
  assert.equal(estimateResale(target, [sample[0], sample[0], sample[1]], 'Nike', productCategory), null);
});

test('generic titles and unknown conditions remain low-confidence and margins may be negative', () => {
  const item = { title: 'Felpa', price: 100 };
  const sample = [30, 35, 40].map(price => ({ title: 'Felpa', price }));
  const estimate = estimateResale(item, sample, 'Nike', productCategory);
  assert.equal(estimate.condition, 'unknown');
  assert.equal(estimate.confidence, 'bassa');
  assert.ok(estimate.marginHigh < 0);
  assert.equal(conditionOf({ details: 'Nuovo senza cartellino' }), 'new_without_tags');
  assert.equal(conditionOf({ condition: 'new_with_tags' }), 'new_with_tags');
  assert.equal(conditionOf({ condition: 'Molto buone' }), 'very_good');
});

test('a larger consistent model and condition sample can reach medium but never guaranteed confidence', () => {
  const estimate = estimateResale(target, peers([40, 42, 44, 46, 48, 50, 52, 54]), 'Nike', productCategory);
  assert.equal(estimate.count, 8);
  assert.equal(estimate.confidence, 'media');
});

test('legacy queued listings show insufficient evidence rather than their old median estimate', async () => {
  const saved = globalThis.fetch;
  let caption;
  globalThis.fetch = async (_url, options) => { caption = JSON.parse(options.body).text; return Response.json({ ok: true, result: {} }); };
  try {
    const env = { TELEGRAM_BOT_TOKEN: 'test', CHANNEL_ID: '1', DB: { prepare() { return { first: async () => null }; } } };
    await publish(env, 'Nike', { item: { ...target, url: 'https://www.vinted.it/items/1' }, total: 12, median: 100 });
    assert.match(caption, /Stima rivendita non disponibile/);
    assert.doesNotMatch(caption, /75\.00/);
  } finally { globalThis.fetch = saved; }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { draftFacts, photoReview, photoPlan, buildListingDraft, draftMarket } from '../src/listing-draft.js';
import { generateDraft, productCategory } from '../src/index.js';

test('draft metadata keeps confirmed fields, truthful defects and optional details separate', () => {
  const facts = draftFacts('Gap | felpa | M | buone | 25,50 | colore=blu | materiale=cotone | misure=petto 54 cm | difetti=macchia sulla manica');
  assert.equal(facts.brand, 'Gap');
  assert.equal(facts.asking, 25.5);
  assert.equal(facts.colour, 'blu');
  assert.equal(facts.flaws, 'macchia sulla manica');
  assert.equal(draftFacts('Gap | felpa | M | buone | 0').asking, null);
  assert.equal(draftFacts('Gap | felpa | M | buone | inventa il prezzo').asking, null);
});

test('photo assessment cannot inject listing claims or certify authenticity', () => {
  const review = photoReview('```json\n{"score":9,"role":"front","complete":true,"coverSuitable":true,"brand":"Prada","authentic":true,"condition":"nuovo","toConfirm":["Colore forse blu"]}\n```');
  assert.equal(review.score, 9);
  assert.equal(review.brand, undefined);
  assert.equal(review.condition, undefined);
  const draft = buildListingDraft('Gap | felpa | M | buone | 25', [review]);
  assert.doesNotMatch(draft, /Prada/);
  assert.match(draft, /Foto 1: Colore forse blu/);
  assert.equal(photoReview('AI non disponibile').score, null);
});

test('cover selection chooses a sharp complete front, not the highest score on a label or defect', () => {
  const analyses = [
    { score: 10, role: 'label', complete: true, coverSuitable: true },
    { score: 7, role: 'front', complete: true, coverSuitable: true, sharp: true, light: true },
    { score: 9, role: 'front', complete: false, coverSuitable: true },
    { score: 9, role: 'back', complete: true, coverSuitable: false },
    { score: 8, role: 'defect', complete: true, coverSuitable: true }
  ];
  const plan = photoPlan(analyses);
  assert.equal(plan.cover, 2);
  assert.deepEqual(plan.order, [2,3,4,1,5]);
  assert.equal(photoPlan(['legacy plain text']).cover, null);
});

test('copy-ready draft stays bounded, avoids invented shipping, measurements, condition and hashtag boosting', () => {
  const draft = buildListingDraft('Gap | felpa | M | buone | 25 | colore=blu | difetti=macchia sulla manica', []);
  assert.match(draft, /Gap felpa blu taglia M/);
  assert.match(draft, /Difetti: macchia sulla manica/);
  assert.match(draft, /#gap #felpa #blu/);
  assert.match(draft, /non inclusi nella descrizione/);
  assert.match(draft, /nessuna cifra inventata/);
  assert.match(draft, /Visibilità e vendite non sono garantite/);
  assert.doesNotMatch(draft, /spedisco entro|originale certificato|senza difetti/i);
  const empty = buildListingDraft('', []);
  assert.match(empty, /Taglia: \[da confermare\]/);
  assert.match(empty, /Condizioni: \[da confermare\]/);
  const long = buildListingDraft(`Gap | ${'Felpa '.repeat(30)} | M | buone | 25`, []);
  assert.ok(long.split('\n')[1].length <= 80);
});

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  let writes = 0;
  const env = { TELEGRAM_BOT_TOKEN: 'test', DB: { prepare(sql) {
    const statement = { bind(...params) { return {
      async first() { return sqlite.prepare(sql).get(...params); },
      async all() { return { results: sqlite.prepare(sql).all(...params) }; },
      async run() { writes++; return sqlite.prepare(sql).run(...params); }
    }; } };
    return Object.assign(statement, statement.bind());
  } } };
  return { sqlite, env, writes: () => writes };
}

test('draft price compares the correct brand/category and will not generate stale prices', async () => {
  const { sqlite, env } = fixture();
  sqlite.prepare("INSERT INTO category_observations(bucket,brand,category,listings,median_price) VALUES('hour','Gap','hoodie',10,40)").run();
  try {
    const market = await draftMarket(env, draftFacts('gap | felpa | M | buone | 25'), productCategory, ['Gap']);
    assert.equal(market.suggested, 30);
    assert.equal(market.confidence, 'molto bassa');
    assert.equal(await draftMarket(env, draftFacts('Gap | maglietta'), productCategory, ['Gap']), null);
    assert.equal(await draftMarket(env, draftFacts('Nike | felpa'), productCategory, ['Gap']), null);
    sqlite.exec("UPDATE category_observations SET observed_at='2020-01-01 00:00:00'");
    assert.equal(await draftMarket(env, draftFacts('Gap | felpa'), productCategory, ['Gap']), null);
  } finally { sqlite.close(); }
});

test('real draft generation works with exhausted AI budget, no AI invocation and no database writes', async () => {
  const { sqlite, env, writes } = fixture();
  sqlite.prepare('INSERT INTO photo_sessions(chat_id,user_id,metadata,analyses) VALUES(?,?,?,?)').run('1','10','Gap | felpa | M | buone | 25 | difetti=macchia', JSON.stringify([{ score: 8, role: 'front', complete: true, coverSuitable: true }]));
  env.AI = { run() { throw new Error('AI must not be used'); } };
  const saved = globalThis.fetch, messages = [];
  globalThis.fetch = async (_url, options) => { messages.push(JSON.parse(options.body)); return Response.json({ ok: true, result: {} }); };
  try {
    await generateDraft(env, { chat: { id: 1 }, from: { id: 10 }, message_thread_id: 77 });
    assert.ok(messages.length);
    assert.ok(messages.every(message => message.message_thread_id === 77 && message.text.length <= 3900));
    assert.match(messages.map(message => message.text).join(''), /Copertina originale suggerita: foto 1/);
    assert.match(messages.map(message => message.text).join(''), /Difetti: macchia/);
    assert.equal(writes(), 0);
  } finally { globalThis.fetch = saved; sqlite.close(); }
});

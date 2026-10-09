import { createResaleEstimator } from './estimates.js';

const money = value => `${Number(value).toFixed(2)} EUR`;

export function catalogSnapshot(items, checkedAt) {
  return { checked_at: checkedAt, items: items.slice(0, 100).map(item => ({
    id: String(item.id || ''), title: String(item.title || '').slice(0, 160),
    price: Number(item.price), total: Number(item.total) || Number(item.price),
    currency: String(item.currency || 'EUR'), brand: String(item.brand || '').slice(0, 80),
    condition: String(item.condition || '').slice(0, 80), details: String(item.details || '').slice(0, 200)
  })) };
}

export function adviceText(trade, estimate, source) {
  const cost = Number(trade.cost_cents) / 100;
  if (!estimate) return '⚠️ Stima non disponibile: dati recenti della stessa categoria insufficienti. Il costo pagato da solo non determina il valore di mercato.';
  return [
    `💡 Rivendita proposta per ${trade.item_id}: ${money(estimate.low)}–${money(estimate.high)}`,
    `🎯 Prezzo di partenza suggerito: ${money(estimate.suggested)}`,
    `🧾 Costo registrato: ${money(cost)} · pareggio: ${money(cost)} più eventuali costi di vendita`,
    `📈 Margine stimato: ${money(estimate.low - cost)}–${money(estimate.high - cost)}`,
    `📊 Attendibilità ${estimate.confidence} · ${source}`,
    ...(estimate.high < cost ? ['⚠️ La fascia di mercato è inferiore al costo pagato: potresti vendere in perdita. Non alzo la stima per fingere un guadagno.'] : []),
    'Prezzi richiesti, non vendite concluse; modello/condizione possono differire. Nessuna garanzia di vendita, costi di vendita e imposte esclusi.'
  ].join('\n');
}

export async function purchaseAdvice(env, trade, titleHint, categoryOf, now = Date.now()) {
  const row = await env.DB.prepare('SELECT value FROM state WHERE key=?').bind(`resale_catalog:${trade.brand}`).first();
  const snapshot = row ? JSON.parse(row.value) : null;
  const age = now - Date.parse(snapshot?.checked_at || '');
  const items = Number.isFinite(age) && age >= -60000 && age <= 24 * 3600000 && Array.isArray(snapshot?.items) ? snapshot.items : [];
  const observed = items.find(item => String(item.id) === trade.item_id);
  const title = titleHint || observed?.title || '';
  if (!title || categoryOf({ title, details: observed?.details || '' }) === 'other') {
    return `💡 Per stimare ${trade.item_id} serve il tipo di articolo: non indovino che sia una felpa solo dalla marca.\nScrivi /stima ${trade.item_id} | felpa (oppure maglietta, scarpe, giacca, ecc.).`;
  }
  // The recorded cost changes the margin, never the market comparison prices.
  const target = { ...(observed || {}), id: trade.item_id, title, brand: observed?.brand || trade.brand,
    currency: 'EUR', price: Number(trade.cost_cents) / 100, total: Number(trade.cost_cents) / 100,
    ...(titleHint ? { details: '', condition: '' } : {}) };
  const estimate = createResaleEstimator(items, trade.brand, categoryOf)(target);
  if (estimate) return adviceText(trade, estimate, `${estimate.count} annunci confrontati · catalogo ${snapshot.checked_at}`);
  // Latest hourly aggregate is a clearly labelled, very weak fallback, not a list of sold items.
  const market = await env.DB.prepare("SELECT median_price,listings,observed_at FROM category_observations WHERE brand=? AND category=? AND observed_at>=datetime('now','-24 hours') AND listings>0 AND median_price>0 ORDER BY observed_at DESC LIMIT 1")
    .bind(trade.brand, categoryOf(target)).first();
  if (!market) return adviceText(trade, null, '');
  const low = Math.max(1, Math.floor(Number(market.median_price) * 0.7));
  const high = Math.max(low, Math.floor(Number(market.median_price) * 0.8));
  return adviceText(trade, { low, high, suggested: Math.floor((low + high) / 2), confidence: 'molto bassa' },
    `stima generica da una mediana aggregata marca/categoria (${market.listings} annunci osservati, possono includere il tuo articolo) · ${market.observed_at} UTC`);
}

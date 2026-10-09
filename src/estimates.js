// Conservative heuristics on asking prices, not observed sale prices.
const text = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const tokens = value => text(value).match(/[a-z0-9]+/g) || [];
const GENERIC = new Set(tokens('scarpa scarpe sneaker sneakers trainer trainers boots stivale stivali felpa felpe hoodie sweatshirt giacca giacche jacket coat cappotto piumino parka gilet puffer smanicato pantalone pantaloni trousers jeans denim cargo shorts short maglietta magliette tshirt shirt tee camicia camicie polo maglione maglioni maglioncino sweater knit cardigan vestito abito dress gonna skirt tuta tracksuit cappello cap beanie berretto borsa bag zaino backpack cintura belt portafogli wallet occhiali watch orologio collana braccialetto nuovo nuova nuovi con senza cartellino etichetta new tags ottime ottimo buone buono condizioni condition originale authentic uomo donna unisex men women vintage logo ricamo ricamata ricamato nero nera black bianco bianca white rosso rossa red blu blue verde green grigio grey gray beige marrone brown taglia size eu uk us cotone cotton lana wool di da del della in a e il la per and the with used ottimo ottima excellent good very tag tagged'));

export function conditionOf(item) {
  const value = text(`${item.condition || ''} ${item.details || ''}`).replaceAll('_', ' ');
  if (/senza cartellino|without tags|new without/.test(value)) return 'new_without_tags';
  if (/con cartellino|with tags|new with/.test(value)) return 'new_with_tags';
  if (/ottim[eoai]|molto buon[eoai]|very good|excellent/.test(value)) return 'very_good';
  if (/soddisfacent|satisfactory|fair/.test(value)) return 'satisfactory';
  if (/buon[eoai]|\bgood\b/.test(value)) return 'good';
  return 'unknown';
}

function subtype(item, category) {
  const value = text(item.title);
  if (category === 'hoodie') {
    if (/\b(zip|cerniera|zipper)\b/.test(value)) return 'zip';
    if (/hoodie|cappuccio|hooded/.test(value)) return 'hooded';
    if (/girocollo|crewneck|crew neck/.test(value)) return 'crewneck';
  }
  if (category === 'shoes') {
    if (/boot|stival/.test(value)) return 'boots';
    if (/sneaker|trainer|dunk|jordan/.test(value)) return 'sneakers';
  }
  return 'unknown';
}

function modelTokens(item, query) {
  const brand = new Set(tokens(`${query} ${item.brand || ''}`));
  const model = new Set(tokens(item.title).filter(word => !brand.has(word) && !GENERIC.has(word) &&
    (word.length > 2 || /^\d+[a-z]+$/.test(word)) && !/^\d{1,2}$/.test(word)));
  // Keep model numbers such as Jordan 1 vs Jordan 4, without treating shoe sizes as models.
  const jordan = text(item.title).match(/\bjordan\s+(\d{1,2})\b/);
  if (jordan) model.add(`jordan${jordan[1]}`);
  return model;
}

function quantile(sorted, fraction) {
  const position = (sorted.length - 1) * fraction;
  const base = Math.floor(position);
  return sorted[base] + (sorted[Math.ceil(position)] - sorted[base]) * (position - base);
}

export function createResaleEstimator(items, query, categoryOf) {
  const features = new Map(items.map(peer => [peer, { category: categoryOf(peer), condition: conditionOf(peer),
    type: subtype(peer, categoryOf(peer)), model: modelTokens(peer, query), title: text(peer.title), brand: text(peer.brand) }]));
  return item => estimateResale(item, items, query, categoryOf, features) || estimateGeneric(item, items, query, categoryOf);
}

export function estimateGeneric(item, items, query, categoryOf) {
  const category = categoryOf(item);
  if (category === 'other') return null;
  const seen = new Set();
  const prices = items.filter(peer => {
    if (peer === item || (item.id && String(peer.id) === String(item.id)) || (item.url && peer.url === item.url)) return false;
    if (peer.id && seen.has(String(peer.id))) return false;
    if (peer.id) seen.add(String(peer.id));
    return categoryOf(peer) === category && String(peer.currency || 'EUR') === String(item.currency || 'EUR') &&
      (!peer.brand || text(peer.brand) === text(item.brand || query)) && Number.isFinite(Number(peer.price)) && Number(peer.price) > 0;
  }).map(peer => Number(peer.price)).sort((a, b) => a - b);
  if (!prices.length) return null;
  const median = quantile(prices, 0.5);
  const low = Math.max(1, Math.floor(quantile(prices, 0.25) * 0.7));
  const high = Math.max(low, Math.floor(median * 0.8));
  const acquisition = Number(item.total) || Number(item.price) || 0;
  return { low, high, suggested: Math.floor((low + high) / 2), median, count: prices.length,
    confidence: 'molto bassa', condition: 'unknown', generic: true,
    basis: 'stima generica marca/categoria; modello e condizione non confrontati',
    marginLow: Math.round((low - acquisition) * 100) / 100, marginHigh: Math.round((high - acquisition) * 100) / 100 };
}

export function estimateResale(item, items, query, categoryOf, features = null) {
  const category = categoryOf(item);
  if (category === 'other') return null;
  const condition = conditionOf(item);
  const type = subtype(item, category);
  const model = modelTokens(item, query);
  const currency = String(item.currency || 'EUR');
  const ids = new Set();
  const candidates = items.filter(peer => {
    const feature = features?.get(peer);
    if (peer === item || (item.id && String(peer.id) === String(item.id)) || (item.url && peer.url === item.url)) return false;
    if (peer.id && ids.has(String(peer.id))) return false;
    if (peer.id) ids.add(String(peer.id));
    if ((feature?.category || categoryOf(peer)) !== category || String(peer.currency || 'EUR') !== currency) return false;
    if (item.brand && peer.brand && text(item.brand) !== (feature?.brand || text(peer.brand))) return false;
    if (condition !== 'unknown' && (feature?.condition || conditionOf(peer)) !== condition) return false;
    if (type !== 'unknown' && (feature?.type || subtype(peer, category)) !== type) return false;
    if (category === 'shoes') {
      const cut = text(item.title).match(/\b(low|high|mid)\b/)?.[1];
      if (cut && (feature?.title || text(peer.title)).match(/\b(low|high|mid)\b/)?.[1] !== cut) return false;
      if (/\bdunk\b/.test(text(item.title)) && /\bsb\b/.test(text(item.title)) !== /\bsb\b/.test(feature?.title || text(peer.title))) return false;
    }
    const otherModel = feature?.model || modelTokens(peer, query);
    if (model.size) {
      // Explicit numeric models must agree even when other words overlap.
      const numbers = [...model].filter(word => /\d/.test(word));
      if (numbers.some(word => !otherModel.has(word))) return false;
      const overlap = [...model].filter(word => otherModel.has(word)).length;
      if (overlap / Math.max(model.size, otherModel.size, 1) < 0.5) return false;
    }
    return Number.isFinite(Number(peer.price)) && Number(peer.price) > 0;
  });
  if (candidates.length < 3) return null;
  let prices = candidates.map(peer => Number(peer.price)).sort((a, b) => a - b);
  const rawCount = prices.length;
  if (prices.length >= 5) {
    const q1 = quantile(prices, 0.25), q3 = quantile(prices, 0.75);
    const iqr = q3 - q1;
    // A flat sample still must not admit a single extremely expensive outlier.
    prices = prices.filter(price => price >= q1 - 1.5 * iqr && price <= q3 + 1.5 * iqr);
  }
  if (prices.length < 3) return null;
  const median = quantile(prices, 0.5);
  const low = Math.max(1, Math.floor(quantile(prices, 0.25) * 0.8));
  const high = Math.max(low, Math.floor(median * 0.85));
  const spread = (quantile(prices, 0.75) - quantile(prices, 0.25)) / median;
  const confidence = model.size && condition !== 'unknown' && prices.length >= 8 && spread <= 0.35 ? 'media' : 'bassa';
  const acquisition = Number(item.total) || Number(item.price) || 0;
  return { low, high, suggested: Math.floor((low + high) / 2), count: prices.length,
    outliers: rawCount - prices.length, confidence, median, condition,
    basis: model.size ? 'modello simile nel titolo' : 'solo stessa categoria/tipo',
    marginLow: Math.round((low - acquisition) * 100) / 100,
    marginHigh: Math.round((high - acquisition) * 100) / 100 };
}

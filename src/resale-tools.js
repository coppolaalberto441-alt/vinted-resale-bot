import { conditionOf } from './estimates.js';
import { purchaseAdvice } from './purchase-advice.js';

const CONDITIONS = ['new_with_tags', 'new_without_tags', 'very_good', 'good', 'satisfactory'];
const normalized = value => String(value || '').trim().toUpperCase();

export function parseFilters(input, previous = {}) {
  if (input.trim().toLowerCase() === 'reset') return {};
  const result = { ...previous };
  for (const option of input.trim().split(/\s+/)) {
    const [key, value, extra] = option.split('=');
    if (!value || extra !== undefined) throw new Error('Formato: /filtri max=80 margine=15 taglie=M,L condizioni=very_good,new_with_tags');
    if (['max', 'margine'].includes(key)) {
      const number = Number(value.replace(',', '.'));
      if (!Number.isFinite(number) || number < 0 || number > 100000) throw new Error('Prezzo e margine devono essere numeri da 0 a 100000.');
      result[key] = number;
    } else if (key === 'taglie') {
      const sizes = value === '*' ? [] : value.split(',').map(normalized);
      if (sizes.length > 20 || sizes.some(size => !/^[A-Z0-9./-]{1,15}$/.test(size))) throw new Error('Taglie non valide: usa M,L oppure 42,43.');
      result[key] = sizes;
    } else if (key === 'condizioni') {
      const conditions = value === '*' ? [] : value.split(',');
      if (conditions.some(condition => !CONDITIONS.includes(condition))) throw new Error(`Condizioni: ${CONDITIONS.join(',')}`);
      result[key] = conditions;
    } else throw new Error(`Filtro sconosciuto: ${key}`);
  }
  return result;
}

export function matchesFilters(item, estimate, filters = {}) {
  const total = Number(item.total) || Number(item.price);
  if (filters.max !== undefined && (!Number.isFinite(total) || total > filters.max)) return false;
  if (filters.margine !== undefined && (!estimate || estimate.marginLow < filters.margine)) return false;
  if (filters.taglie?.length && !filters.taglie.includes(normalized(item.size))) return false;
  if (filters.condizioni?.length && !filters.condizioni.includes(conditionOf(item))) return false;
  return true;
}

export function rankOffers(offers) {
  const confidence = offer => ({ media: 2, bassa: 1, 'molto bassa': 0 }[offer.resale?.confidence] ?? -1);
  return [...offers].sort((a, b) => confidence(b) - confidence(a) ||
    (b.resale?.marginLow ?? -Infinity) - (a.resale?.marginLow ?? -Infinity) ||
    (b.resale?.count || 0) - (a.resale?.count || 0));
}

export function eurosToCents(input, allowZero = false) {
  const value = String(input || '').trim().replace(',', '.');
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(value)) throw new Error('Importo EUR non valido (esempio 25,50).');
  const cents = Math.round(Number(value) * 100);
  if (!allowZero && cents === 0) throw new Error('Il costo deve essere maggiore di zero.');
  return cents;
}

const money = cents => `${(Number(cents || 0) / 100).toFixed(2)} EUR`;
const help = 'Comandi:\n/filtri — mostra i filtri\n/filtri max=80 margine=15 taglie=M,L condizioni=very_good,new_with_tags\n/filtri reset — azzera (solo amministratori)\n/acquisto ID | Marca | costo totale EUR | tipo articolo (facoltativo)\n/stima ID | tipo articolo — consiglio di rivendita dal registro\n/vendita ID | incasso netto EUR\n/registro — ultimi 20 acquisti\n/risultati — risultati personali per brand\nIl costo include spedizione e commissioni; l’incasso deve essere già al netto dei costi di vendita.';

export async function handleResaleTools(env, message, telegram, brands, categoryOf) {
  const match = String(message.text || '').match(/^\/(filtri|acquisto|stima|vendita|registro|risultati|strumenti)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return false;
  const chat = String(message.chat.id), user = String(message.from?.id || '');
  const reply = text => telegram(env, 'sendMessage', { chat_id: chat,
    ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}), text: text.slice(0, 4000) });
  try {
    const group = await env.DB.prepare('SELECT chat_id FROM telegram_groups ORDER BY configured_at DESC LIMIT 1').first();
    if (!group || String(group.chat_id) !== chat) { await reply('Usa questi comandi nel gruppo attualmente configurato.'); return true; }
    const action = match[1].toLowerCase(), input = (match[2] || '').trim();
    if (action === 'strumenti') { await reply(help); return true; }
    if (action === 'filtri') {
      const key = `offer_filters:${chat}`;
      const row = await env.DB.prepare('SELECT value FROM state WHERE key=?').bind(key).first();
      let filters = row ? JSON.parse(row.value) : {};
      if (input) {
        if (!user || message.sender_chat) throw new Error('Modifica i filtri con il tuo account amministratore, non in modalità anonima.');
        const member = await telegram(env, 'getChatMember', { chat_id: chat, user_id: message.from.id });
        if (!['administrator', 'creator'].includes(member.status)) throw new Error('Solo gli amministratori possono cambiare i filtri del gruppo.');
        filters = parseFilters(input, filters);
        await env.DB.prepare('INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, JSON.stringify(filters)).run();
      }
      await reply(`Filtri del gruppo (tutti i brand):\nTotale noto massimo: ${filters.max === undefined ? 'nessuno' : filters.max + ' EUR'}\nMargine minimo stimato: ${filters.margine === undefined ? 'nessuno' : filters.margine + ' EUR'}\nTaglie: ${filters.taglie?.join(', ') || 'tutte'}\nCondizioni: ${filters.condizioni?.join(', ') || 'tutte'}\nTaglia/condizione sconosciute sono escluse se il relativo filtro è attivo. Margine stimato prima della spedizione.\n/strumenti per esempi.`);
      return true;
    }
    if (!user || message.sender_chat) throw new Error('Usa il tuo account personale per registrare acquisti e vendite.');
    if (action === 'stima') {
      const parts = input.split('|').map(value => value.trim());
      if (parts.length > 2 || !/^[a-zA-Z0-9_-]{1,80}$/.test(parts[0] || '') || (parts[1] !== undefined && (!parts[1] || parts[1].length > 160))) throw new Error('Formato: /stima ID | felpa (tipo facoltativo se già riconosciuto).');
      const trade = await env.DB.prepare('SELECT item_id,brand,cost_cents FROM resale_trades WHERE chat_id=? AND user_id=? AND item_id=?').bind(chat, user, parts[0]).first();
      await reply(trade ? await purchaseAdvice(env, trade, parts[1], categoryOf) : 'Acquisto non trovato nel tuo registro: usa prima /acquisto.');
      return true;
    }
    if (action === 'acquisto' || action === 'vendita') {
      const parts = input.split('|').map(value => value.trim());
      const id = parts[0];
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id || '') || !(action === 'acquisto' ? [3,4] : [2]).includes(parts.length)) throw new Error(help);
      if (action === 'acquisto') {
        const brand = brands.find(brand => brand.toLowerCase() === parts[1].toLowerCase());
        if (!brand) throw new Error('Usa il nome esatto del brand nella sua sezione.');
        const cents = eurosToCents(parts[2]);
        if (parts[3] !== undefined && (!parts[3] || parts[3].length > 160 || categoryOf({ title: parts[3] }) === 'other')) throw new Error('Tipo non riconosciuto: usa felpa, maglietta, scarpe, giacca, pantaloni, ecc.');
        const saved = await env.DB.prepare('INSERT OR IGNORE INTO resale_trades(chat_id,user_id,item_id,brand,cost_cents) VALUES(?,?,?,?,?) RETURNING item_id').bind(chat, user, id, brand, cents).first();
        await reply(saved ? `✅ Acquisto ${id}: ${brand}, costo ${money(cents)}. Per chiuderlo: /vendita ${id} | incasso netto` : 'Acquisto già registrato: non ho modificato il costo. Usa /registro.');
        const trade = await env.DB.prepare('SELECT item_id,brand,cost_cents FROM resale_trades WHERE chat_id=? AND user_id=? AND item_id=?').bind(chat, user, id).first();
        try { await reply(await purchaseAdvice(env, trade, parts[3], categoryOf)); }
        catch (_) { await reply(`⚠️ Acquisto conservato; stima temporaneamente non disponibile. Riprova /stima ${id} | tipo articolo.`); }
      } else {
        const cents = eurosToCents(parts[1], true);
        const sold = await env.DB.prepare('UPDATE resale_trades SET proceeds_cents=?,sold_at=CURRENT_TIMESTAMP WHERE chat_id=? AND user_id=? AND item_id=? AND sold_at IS NULL RETURNING cost_cents').bind(cents, chat, user, id).first();
        await reply(sold ? `✅ Vendita ${id}: incasso ${money(cents)}, risultato ${money(cents - sold.cost_cents)}.` : 'Acquisto non trovato o vendita già registrata: nessuna modifica.');
      }
      return true;
    }
    if (action === 'registro') {
      const rows = await env.DB.prepare('SELECT item_id,brand,cost_cents,proceeds_cents,sold_at FROM resale_trades WHERE chat_id=? AND user_id=? ORDER BY bought_at DESC,item_id LIMIT 20').bind(chat, user).all();
      await reply('I tuoi ultimi acquisti:\n' + (rows.results.map(row => `${row.item_id} · ${row.brand} · costo ${money(row.cost_cents)} · ${row.sold_at ? 'venduto ' + money(row.proceeds_cents) : 'da vendere'}`).join('\n') || 'Nessun acquisto registrato.'));
    } else {
      const rows = await env.DB.prepare('SELECT brand,COUNT(*) AS bought,COUNT(sold_at) AS sold,SUM(CASE WHEN sold_at IS NOT NULL THEN proceeds_cents-cost_cents ELSE 0 END) AS profit,SUM(CASE WHEN sold_at IS NULL THEN cost_cents ELSE 0 END) AS invested FROM resale_trades WHERE chat_id=? AND user_id=? GROUP BY brand ORDER BY profit DESC,brand').bind(chat, user).all();
      await reply('Risultati dalle tue registrazioni (non stime):\n' + (rows.results.map(row => `${row.brand}: ${row.sold}/${row.bought} venduti · risultato ${money(row.profit)} · capitale negli invenduti ${money(row.invested)}`).join('\n') || 'Nessun dato: registra un /acquisto.') + '\nCosti non inseriti e imposte non sono inclusi. I risultati rispondono qui nel gruppo.');
    }
  } catch (error) { await reply(`⚠️ ${String(error.message || error).slice(0, 3500)}`); }
  return true;
}

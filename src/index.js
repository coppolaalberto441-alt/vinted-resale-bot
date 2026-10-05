import brandConfig from "../brands.json" with { type: "json" };

const DEAL_RATIO = 0.55;
const MAX_PUBLISHES_PER_REQUEST = 4;
const TELEGRAM_SEND_INTERVAL_MS = 3200;
const MIN_DISPATCH_INTERVAL_MS = 270000;
const GITHUB_WORKFLOW_DISPATCH_URL = "https://api.github.com/repos/coppolaalberto441-alt/vinted-resale-bot/actions/workflows/vinted-scan.yml/dispatches";
const TOPIC_COLORS = [0x6FB9F0, 0xFFD67E, 0xCB86DB, 0x8EEE98, 0xFF93B2, 0xFB6F5F];
const BRAND_NAMES = brandConfig.brands.map(({ query }) => String(query));
const SPECIAL_TOPICS = [
  ["trends", "📊 Trend mercato"],
  ["assistant", "🧠 Assistente annunci"]
];
const PRODUCT_CATEGORIES = [
  ["shoes", /\b(scarpe?|sneakers?|trainer|boots?|stivali?|dunk|jordan)\b/i],
  ["hoodie", /\b(felpa|felpe|hoodie|sweatshirt)\b/i],
  ["jacket", /\b(giacca|giacche|jacket|coat|cappotto|piumino|parka|gilet)\b/i],
  ["trousers", /\b(pantaloni?|trousers|jeans|denim|cargo|shorts?)\b/i],
  ["tshirt", /\b(t[ -]?shirt|magliett[ae]|tee)\b/i],
  ["shirt", /\b(camici[ae]|shirt|polo)\b/i],
  ["knitwear", /\b(maglion[ei]|sweater|knit|cardigan)\b/i],
  ["hat", /\b(cappell[oi]|berrett[oi]|cap|beanie)\b/i],
  ["bag", /\b(bors[ae]|bag|zaino|backpack)\b/i]
];

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function amount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function productCategory(item) {
  const text = `${item?.title || ""} ${item?.details || ""}`;
  return PRODUCT_CATEGORIES.find(([, pattern]) => pattern.test(text))?.[0] || null;
}

function medianTotal(entries) {
  const totals = entries.map(({ total }) => total).sort((a, b) => a - b);
  const middle = Math.floor(totals.length / 2);
  return totals.length % 2 ? totals[middle] : (totals[middle - 1] + totals[middle]) / 2;
}

export function selectDeals(items) {
  const priced = items
    .map((item) => ({ item, total: amount(item.total) || amount(item.price) }))
    .filter(({ total }) => total > 0)
    .sort((a, b) => a.total - b.total);
  if (priced.length < 5) return [];
  const globalMedian = medianTotal(priced);
  return priced.flatMap(({ item, total }) => {
    const category = productCategory(item);
    const comparable = category
      ? priced.filter(({ item: candidate }) => productCategory(candidate) === category)
      : [];
    const median = comparable.length >= 5 ? medianTotal(comparable) : globalMedian;
    return total <= median * DEAL_RATIO ? [{ item, total, median }] : [];
  });
}

export function resaleEstimate(median, purchaseTotal = 0) {
  const marketMedian = amount(median);
  const acquisition = amount(purchaseTotal);
  if (marketMedian <= 0) return null;
  const roundMarketPrice = (value) => {
    const step = value >= 50 ? 5 : 1;
    return Math.max(step, Math.round(value / step) * step);
  };
  const quickSale = roundMarketPrice(marketMedian * 0.75);
  return {
    quickSale,
    profit: Math.max(0, quickSale - acquisition)
  };
}

async function telegram(env, method, body) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (response.ok) return (await response.json()).result;
    const text = await response.text();
    if (response.status === 429 && attempt === 0) {
      let retryAfter = 5;
      try {
        retryAfter = Math.min(60, Math.max(1, Number(JSON.parse(text)?.parameters?.retry_after || 5)));
      } catch (_) {}
      await pause((retryAfter + 1) * 1000);
      continue;
    }
    throw new Error(`Telegram ${method} HTTP ${response.status}: ${text}`);
  }
}

export function isSetupCommand(text) {
  return /^\/setup(?:@\w+)?(?:\s|$)/i.test(String(text || "").trim());
}

function command(text, name) {
  return new RegExp(`^/${name}(?:@\\w+)?(?:\\s|$)`, "i").test(String(text || "").trim());
}

export function topicColor(index) {
  return TOPIC_COLORS[index % TOPIC_COLORS.length];
}

async function sendSetupStatus(env, chatId, text) {
  await telegram(env, "sendMessage", { chat_id: chatId, text });
}

async function setupTopics(env, message) {
  const chatId = String(message.chat.id);
  if (message.chat.type !== "supergroup" || message.chat.is_forum !== true) {
    await sendSetupStatus(env, chatId, "❌ /setup funziona solo in un supergruppo con Argomenti attivi.");
    return;
  }

  const member = await telegram(env, "getChatMember", {
    chat_id: chatId,
    user_id: message.from.id
  });
  if (!member || !["administrator", "creator"].includes(member.status)) {
    await sendSetupStatus(env, chatId, "❌ Solo un amministratore può usare /setup.");
    return;
  }

  await env.DB.prepare(
    "INSERT INTO telegram_groups(chat_id,title,configured_at) VALUES(?,?,CURRENT_TIMESTAMP) " +
    "ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title, configured_at=CURRENT_TIMESTAMP"
  ).bind(chatId, String(message.chat.title || "Gruppo Vinted")).run();

  await sendSetupStatus(env, chatId, `⏳ Configurazione avviata: creo ${BRAND_NAMES.length} sezioni. Puoi rilanciare /setup se si interrompe.`);
  let created = 0;
  let existing = 0;
  try {
    for (let index = 0; index < BRAND_NAMES.length; index += 1) {
      const brand = BRAND_NAMES[index];
      const saved = await env.DB.prepare(
        "SELECT topic_id FROM brand_topics WHERE chat_id=? AND brand=?"
      ).bind(chatId, brand).first();
      if (saved) {
        existing += 1;
        continue;
      }
      const topic = await telegram(env, "createForumTopic", {
        chat_id: chatId,
        name: `🔥 ${brand}`,
        icon_color: topicColor(index)
      });
      await env.DB.prepare(
        "INSERT OR REPLACE INTO brand_topics(chat_id,brand,topic_id) VALUES(?,?,?)"
      ).bind(chatId, brand, topic.message_thread_id).run();
      created += 1;
      await pause(250);
    }
    await ensureSpecialTopics(env, chatId);
    await sendSetupStatus(env, chatId, `✅ Configurazione completata: ${created} sezioni create, ${existing} già presenti. I prossimi annunci saranno divisi per brand.`);
  } catch (error) {
    await sendSetupStatus(env, chatId, `⚠️ Configurazione parziale: ${created} create, ${existing} già presenti. Riprova /setup tra un minuto.`);
    throw error;
  }
}

async function ensureSpecialTopics(env, chatId) {
  for (let index = 0; index < SPECIAL_TOPICS.length; index += 1) {
    const [kind, name] = SPECIAL_TOPICS[index];
    const saved = await env.DB.prepare(
      "SELECT topic_id FROM special_topics WHERE chat_id=? AND kind=?"
    ).bind(chatId, kind).first();
    if (saved) continue;
    const topic = await telegram(env, "createForumTopic", {
      chat_id: chatId,
      name,
      icon_color: topicColor(BRAND_NAMES.length + index)
    });
    await env.DB.prepare(
      "INSERT OR REPLACE INTO special_topics(chat_id,kind,topic_id) VALUES(?,?,?)"
    ).bind(chatId, kind, topic.message_thread_id).run();
    await pause(250);
  }
}

async function syncLatestGroupTopics(env) {
  const group = await env.DB.prepare(
    "SELECT chat_id FROM telegram_groups ORDER BY configured_at DESC LIMIT 1"
  ).first();
  if (!group) return;
  for (let index = 0; index < BRAND_NAMES.length; index += 1) {
    const brand = BRAND_NAMES[index];
    const saved = await env.DB.prepare(
      "SELECT topic_id FROM brand_topics WHERE chat_id=? AND brand=?"
    ).bind(group.chat_id, brand).first();
    if (saved) continue;
    const topic = await telegram(env, "createForumTopic", {
      chat_id: group.chat_id,
      name: `🔥 ${brand}`,
      icon_color: topicColor(index)
    });
    await env.DB.prepare(
      "INSERT OR REPLACE INTO brand_topics(chat_id,brand,topic_id) VALUES(?,?,?)"
    ).bind(group.chat_id, brand, topic.message_thread_id).run();
    await pause(250);
  }
  await ensureSpecialTopics(env, group.chat_id);
}

async function handleTelegramUpdate(env, update) {
  const message = update?.message;
  if (!message) return;
  if (isSetupCommand(message.text)) return setupTopics(env, message);
  if (command(message.text, "trend")) return sendTrendReport(env, 1, "Trend di oggi");
  if (command(message.text, "trend7")) return sendTrendReport(env, 7, "Trend ultimi 7 giorni");
  if (command(message.text, "trend30")) return sendTrendReport(env, 30, "Trend ultimi 30 giorni");
  if (command(message.text, "report")) return sendProfileReport(env, true);
  if (command(message.text, "nuovo")) return startPhotoSession(env, message);
  if (command(message.text, "genera")) return generateDraft(env, message);
  if (Array.isArray(message.photo) && message.photo.length) return analyzePhoto(env, message);
}

async function specialDestination(env, kind) {
  const group = await env.DB.prepare(
    "SELECT chat_id FROM telegram_groups ORDER BY configured_at DESC LIMIT 1"
  ).first();
  if (!group) return { chat_id: env.CHANNEL_ID };
  const topic = await env.DB.prepare(
    "SELECT topic_id FROM special_topics WHERE chat_id=? AND kind=?"
  ).bind(group.chat_id, kind).first();
  return { chat_id: group.chat_id, ...(topic ? { message_thread_id: topic.topic_id } : {}) };
}

async function telegramDestination(env, brand) {
  const group = await env.DB.prepare(
    "SELECT chat_id FROM telegram_groups ORDER BY configured_at DESC LIMIT 1"
  ).first();
  if (!group) return { chat_id: env.CHANNEL_ID };
  const topic = await env.DB.prepare(
    "SELECT topic_id FROM brand_topics WHERE chat_id=? AND brand=?"
  ).bind(group.chat_id, brand).first();
  return {
    chat_id: group.chat_id,
    ...(topic ? { message_thread_id: topic.topic_id } : {})
  };
}

async function publish(env, query, deal) {
  const { item, total, median } = deal;
  const price = amount(item.price);
  const currency = item.currency || "EUR";
  const discount = median > 0 ? Math.round((1 - total / median) * 100) : 0;
  const resale = resaleEstimate(median, total);
  const caption = [
    `🔥 <b>${escapeHtml(item.title || "Occasione Vinted")}</b>`, "",
    `💶 Prezzo: <b>${price.toFixed(2)} ${escapeHtml(currency)}</b>`,
    `🧾 Totale noto: <b>${total.toFixed(2)} ${escapeHtml(currency)}</b>`,
    `📐 ${escapeHtml(item.details || "Dettagli non disponibili")}`,
    `👤 ${escapeHtml(item.seller || "Venditore non indicato")}`,
    `📊 ${discount}% sotto la mediana degli annunci attivi`, "",
    ...(resale ? [
      `⚡ Prezzo vendita rapida: <b>${resale.quickSale.toFixed(2)} ${escapeHtml(currency)}</b>`,
      `📈 Margine lordo possibile: <b>${resale.profit.toFixed(2)} ${escapeHtml(currency)}</b>`,
      "ℹ️ Calcolato al 25% sotto la mediana degli annunci comparabili attivi; vendita non garantita", ""
    ] : []),
    `Ricerca: ${escapeHtml(query)}`
  ].join("\n");
  const reply_markup = { inline_keyboard: [[{ text: "Apri annuncio", url: item.url }]] };
  const destination = await telegramDestination(env, query);
  if (item.image_url) {
    try {
      await telegram(env, "sendPhoto", {
        ...destination, photo: item.image_url, caption,
        parse_mode: "HTML", reply_markup
      });
      return;
    } catch (error) {
      if (String(error).includes("HTTP 429")) throw error;
    }
  }
  await telegram(env, "sendMessage", {
    ...destination, text: caption, parse_mode: "HTML", reply_markup
  });
}

async function ingestBrand(env, scan, publishLimit) {
  const query = String(scan?.query || "").trim();
  const items = Array.isArray(scan?.items) ? scan.items.slice(0, 100) : [];
  if (!query) throw new Error("Ricerca senza nome");
  const state = await env.DB.prepare("SELECT initialized FROM brand_state WHERE brand = ?").bind(query).first();
  const initialized = state?.initialized === 1;
  const deals = selectDeals(items);
  const prices = items.map((item) => amount(item.price)).filter((price) => price > 0).sort((a, b) => a - b);
  const medianPrice = prices.length ? prices[Math.floor(prices.length / 2)] : 0;
  const favourites = items.reduce((sum, item) => sum + Math.max(0, Number(item.favourites || 0)), 0);
  const bucket = new Date().toISOString().slice(0, 13);
  await env.DB.prepare(
    "INSERT INTO brand_observations(bucket,brand,listings,deals,favourites,median_price,observed_at) " +
    "VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(bucket,brand) DO UPDATE SET " +
    "listings=excluded.listings,deals=excluded.deals,favourites=excluded.favourites,median_price=excluded.median_price,observed_at=CURRENT_TIMESTAMP"
  ).bind(bucket, query, items.length, deals.length, favourites, medianPrice).run();
  let published = 0;
  for (const deal of deals) {
    const id = String(deal.item.id || "");
    if (!id || !String(deal.item.url || "").startsWith("https://")) continue;
    const found = await env.DB.prepare("SELECT 1 AS found FROM seen_items WHERE item_id = ?").bind(id).first();
    if (found) continue;
    if (initialized && published >= publishLimit) continue;
    if (initialized) {
      await publish(env, query, deal);
      published += 1;
      await pause(TELEGRAM_SEND_INTERVAL_MS);
    }
    await env.DB.prepare("INSERT OR IGNORE INTO seen_items(item_id, brand) VALUES(?, ?)").bind(id, query).run();
  }
  await env.DB.prepare(
    "INSERT INTO brand_state(brand, initialized, last_checked_at) VALUES(?, 1, CURRENT_TIMESTAMP) " +
    "ON CONFLICT(brand) DO UPDATE SET initialized=1, last_checked_at=CURRENT_TIMESTAMP"
  ).bind(query).run();
  return { query, items: items.length, deals: deals.length, published, initialized };
}

async function ingestProfile(env, items) {
  const rows = Array.isArray(items) ? items.slice(0, 100) : [];
  const activeIds = [];
  for (const item of rows) {
    const id = String(item?.id || "");
    const url = String(item?.url || "");
    if (!id || !url.startsWith("https://")) continue;
    activeIds.push(id);
    await env.DB.prepare(
      "INSERT INTO user_listings(item_id,title,url,price,currency,brand,size,status,favourites,image_url,active,last_seen_at,last_price) " +
      "VALUES(?,?,?,?,?,?,?,?,?,?,1,CURRENT_TIMESTAMP,?) ON CONFLICT(item_id) DO UPDATE SET " +
      "title=excluded.title,url=excluded.url,last_price=user_listings.price,price=excluded.price,currency=excluded.currency," +
      "brand=excluded.brand,size=excluded.size,status=excluded.status,favourites=excluded.favourites,image_url=excluded.image_url," +
      "active=1,last_seen_at=CURRENT_TIMESTAMP,inactive_at=NULL"
    ).bind(
      id, String(item.title || "Articolo Vinted"), url, amount(item.price), String(item.currency || "EUR"),
      String(item.brand || ""), String(item.size || ""), String(item.status || ""),
      Math.max(0, Number(item.favourites || 0)), String(item.image_url || ""), amount(item.price)
    ).run();
  }
  if (activeIds.length) {
    const placeholders = activeIds.map(() => "?").join(",");
    await env.DB.prepare(
      `UPDATE user_listings SET active=0,inactive_at=COALESCE(inactive_at,CURRENT_TIMESTAMP) WHERE active=1 AND item_id NOT IN (${placeholders})`
    ).bind(...activeIds).run();
  }
  await saveState(env, "last_profile_scan", new Date().toISOString());
  return { active: activeIds.length };
}

function reportKey(prefix, date = new Date()) {
  return `${prefix}:${date.toISOString().slice(0, 10)}`;
}

async function sendTrendReport(env, days, title) {
  const result = await env.DB.prepare(
    "SELECT brand,ROUND(AVG(listings),1) AS listings,SUM(deals) AS deals,ROUND(AVG(favourites),1) AS favourites," +
    "ROUND(AVG(median_price),2) AS median_price," +
    "ROUND(AVG(listings)+SUM(deals)*2+AVG(favourites)*0.25,1) AS score " +
    "FROM brand_observations WHERE observed_at>=datetime('now',?) GROUP BY brand ORDER BY score DESC LIMIT 10"
  ).bind(`-${Math.max(1, days)} days`).all();
  const rows = result?.results || [];
  const lines = rows.map((row, index) =>
    `${index + 1}. <b>${escapeHtml(row.brand)}</b> · indice ${row.score} · ${row.listings} annunci · mediana ${Number(row.median_price).toFixed(0)}€`
  );
  const text = [
    `📊 <b>${escapeHtml(title)}</b>`, "",
    ...(lines.length ? lines : ["Non ci sono ancora abbastanza rilevazioni."]), "",
    "ℹ️ Indice stimato da volume, occasioni e preferiti degli annunci osservati; non è il numero ufficiale di vendite Vinted."
  ].join("\n");
  await telegram(env, "sendMessage", { ...(await specialDestination(env, "trends")), text, parse_mode: "HTML" });
}

async function sendProfileReport(env, requested = false) {
  const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM user_listings WHERE active=1").first();
  const newRows = await env.DB.prepare("SELECT COUNT(*) AS n FROM user_listings WHERE active=1 AND first_seen_at>=datetime('now','-1 day')").first();
  const disappeared = await env.DB.prepare("SELECT COUNT(*) AS n FROM user_listings WHERE inactive_at>=datetime('now','-1 day')").first();
  const stale = await env.DB.prepare(
    "SELECT item_id,title,url,price,currency,favourites,CAST(julianday('now')-julianday(first_seen_at) AS INTEGER) AS age " +
    "FROM user_listings WHERE active=1 AND first_seen_at<=datetime('now','-7 days') ORDER BY favourites ASC,first_seen_at ASC LIMIT 3"
  ).all();
  const top = await env.DB.prepare(
    "SELECT title,url,price,currency,favourites FROM user_listings WHERE active=1 ORDER BY favourites DESC LIMIT 3"
  ).all();
  const staleLines = (stale?.results || []).map((row) => {
    const suggestion = Math.max(1, Math.round(Number(row.price) * 0.9));
    return `• <a href="${escapeHtml(row.url)}">${escapeHtml(row.title)}</a> · ${row.age}g · ${row.favourites} preferiti → prova ${suggestion}€`;
  });
  const topLines = (top?.results || []).map((row) =>
    `• <a href="${escapeHtml(row.url)}">${escapeHtml(row.title)}</a> · ${row.favourites} preferiti · ${Number(row.price).toFixed(0)}€`
  );
  const text = [
    `🧠 <b>${requested ? "Report annunci adesso" : "Report giornaliero annunci"}</b>`, "",
    `Attivi: <b>${active?.n || 0}</b> · Nuovi 24h: <b>${newRows?.n || 0}</b> · Non più attivi 24h: <b>${disappeared?.n || 0}</b>`, "",
    "⭐ <b>Più interessanti</b>", ...(topLines.length ? topLines : ["• Nessun dato"]), "",
    "⏳ <b>Da migliorare</b>", ...(staleLines.length ? staleLines : ["• Nessun annuncio fermo da almeno 7 giorni"]), "",
    "Le riduzioni sono suggerimenti prudenti; decidi sempre tu se modificare o ripubblicare."
  ].join("\n");
  await telegram(env, "sendMessage", { ...(await specialDestination(env, "assistant")), text, parse_mode: "HTML", disable_web_page_preview: true });
}

async function startPhotoSession(env, message) {
  const metadata = String(message.text || "").replace(/^\/nuovo(?:@\w+)?\s*/i, "").trim();
  await env.DB.prepare(
    "INSERT INTO photo_sessions(chat_id,user_id,metadata,analyses,updated_at) VALUES(?,?,?,'[]',CURRENT_TIMESTAMP) " +
    "ON CONFLICT(chat_id,user_id) DO UPDATE SET metadata=excluded.metadata,analyses='[]',updated_at=CURRENT_TIMESTAMP"
  ).bind(String(message.chat.id), String(message.from.id), metadata).run();
  await telegram(env, "sendMessage", {
    chat_id: message.chat.id, ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
    text: "📸 Sessione pronta. Invia fino a 8 foto, una per messaggio. Poi usa /genera.\nFormato utile: /nuovo brand | tipo | taglia | condizione | prezzo"
  });
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

async function analyzePhoto(env, message) {
  const session = await env.DB.prepare("SELECT metadata,analyses FROM photo_sessions WHERE chat_id=? AND user_id=?")
    .bind(String(message.chat.id), String(message.from.id)).first();
  if (!session) return;
  const analyses = JSON.parse(session.analyses || "[]");
  if (analyses.length >= 8) return;
  const photo = message.photo.at(-1);
  const file = await telegram(env, "getFile", { file_id: photo.file_id });
  const response = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
  if (!response.ok) throw new Error(`Download foto Telegram HTTP ${response.status}`);
  let analysis;
  try {
    const image = bytesToBase64(new Uint8Array(await response.arrayBuffer()));
    const answer = await env.AI.run("@cf/moondream/moondream3.1-9B-A2B", {
      image,
      prompt: "Valuta questa foto per un annuncio Vinted in italiano. Dai voto 1-10 e consigli molto brevi su luce, nitidezza, inquadratura, sfondo, visibilità completa, etichette/logo/difetti e privacy. Indica se è adatta come copertina. Non inventare autenticità o marca."
    });
    analysis = String(answer?.response || answer?.description || JSON.stringify(answer)).slice(0, 1800);
  } catch (error) {
    const megapixels = ((Number(photo.width) * Number(photo.height)) / 1_000_000).toFixed(1);
    analysis = `Analisi tecnica: ${photo.width}×${photo.height} (${megapixels} MP). Usa luce naturale, sfondo pulito, articolo intero e foto separate di etichette e difetti. Analisi visiva AI temporaneamente non disponibile.`;
  }
  analyses.push(analysis);
  await env.DB.prepare("UPDATE photo_sessions SET analyses=?,updated_at=CURRENT_TIMESTAMP WHERE chat_id=? AND user_id=?")
    .bind(JSON.stringify(analyses), String(message.chat.id), String(message.from.id)).run();
  await telegram(env, "sendMessage", {
    chat_id: message.chat.id, ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
    text: `📷 Foto ${analyses.length}/8\n${analysis}\n\nInvia un'altra foto o usa /genera.`
  });
}

async function generateDraft(env, message) {
  const session = await env.DB.prepare("SELECT metadata,analyses FROM photo_sessions WHERE chat_id=? AND user_id=?")
    .bind(String(message.chat.id), String(message.from.id)).first();
  if (!session) {
    await telegram(env, "sendMessage", { chat_id: message.chat.id, text: "Prima usa /nuovo e invia le foto." });
    return;
  }
  const analyses = JSON.parse(session.analyses || "[]");
  const prompt = `Prepara in italiano una bozza Vinted pronta da copiare, senza inventare dati. Metadati: ${session.metadata || "non forniti"}. Analisi foto: ${analyses.join(" | ") || "nessuna"}. Restituisci: TITOLO (max 80 caratteri), PREZZO CONSIGLIATO con breve motivazione, DESCRIZIONE chiara, FOTO DA MIGLIORARE. Ricorda che l'utente deve confermare tutto.`;
  let draft;
  try {
    const answer = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", { prompt, max_tokens: 700 });
    draft = String(answer?.response || JSON.stringify(answer));
  } catch (_) {
    draft = `Titolo: ${session.metadata || "Completa brand, modello, taglia e colore"}\nDescrizione: indica misure, condizioni reali, eventuali difetti e disponibilità.\nPrezzo: confronta articoli identici attivi e resta 10-20% sotto la mediana per una vendita più rapida.`;
  }
  await telegram(env, "sendMessage", {
    chat_id: message.chat.id, ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
    text: `📝 BOZZA DA CONFERMARE\n\n${draft.slice(0, 3500)}\n\nIl bot non pubblica né modifica l'annuncio: la conferma finale resta a te.`
  });
}

function authorized(request, env) {
  const supplied = request.headers.get("authorization") || "";
  return supplied === `Bearer ${env.INGEST_SECRET}`;
}

async function saveState(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(key, value).run();
}

export async function dispatchGithubWorkflow(env, fetcher = fetch) {
  if (!env.GITHUB_ACTIONS_TOKEN) throw new Error("GITHUB_ACTIONS_TOKEN non configurato");
  const response = await fetcher(GITHUB_WORKFLOW_DISPATCH_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "vinted-resale-cloudflare"
    },
    body: JSON.stringify({ ref: "main" })
  });
  if (response.status !== 204) {
    const details = (await response.text()).slice(0, 500);
    throw new Error(`GitHub workflow dispatch HTTP ${response.status}: ${details}`);
  }
  await saveState(env, "last_dispatch_at", new Date().toISOString());
}

export function shouldDispatch(lastDispatchAt, now = Date.now()) {
  const previous = Date.parse(String(lastDispatchAt || ""));
  return !Number.isFinite(previous) || now - previous >= MIN_DISPATCH_INTERVAL_MS;
}

async function runScheduledScan(env) {
  try {
    const previous = await env.DB.prepare(
      "SELECT value FROM state WHERE key='last_dispatch_at'"
    ).first();
    if (!shouldDispatch(previous?.value)) return;
    await dispatchGithubWorkflow(env);
  } catch (error) {
    await saveState(env, "last_dispatch_error", String(error?.stack || error).slice(0, 1500));
    throw error;
  }
}

async function sendOnce(env, key, action) {
  const found = await env.DB.prepare("SELECT value FROM state WHERE key=?").bind(key).first();
  if (found) return;
  await action();
  await saveState(env, key, new Date().toISOString());
}

async function runPeriodicReports(env, now = new Date()) {
  if (now.getUTCHours() < 7) return;
  const dayKey = now.toISOString().slice(0, 10);
  await sendOnce(env, `profile_report:${dayKey}`, () => sendProfileReport(env));
  await sendOnce(env, `trend_daily:${dayKey}`, () => sendTrendReport(env, 1, "Trend giornaliero"));
  if (now.getUTCDay() === 1) {
    await sendOnce(env, `trend_weekly:${dayKey}`, () => sendTrendReport(env, 7, "Trend settimanale"));
  }
  if (now.getUTCDate() === 1) {
    await sendOnce(env, `trend_monthly:${dayKey}`, () => sendTrendReport(env, 30, "Trend mensile"));
  }
  await env.DB.prepare("DELETE FROM brand_observations WHERE observed_at<datetime('now','-35 days')").run();
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(Promise.all([runScheduledScan(env), syncLatestGroupTopics(env), runPeriodicReports(env)]));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "vinted-resale-bot", scanner: "github-actions" });
    }
    if (url.pathname === "/ingest" && request.method === "POST") {
      if (!authorized(request, env)) return Response.json({ ok: false }, { status: 401 });
      try {
        const body = await request.json();
        const scans = Array.isArray(body?.scans) ? body.scans.slice(0, 50) : [];
        const results = [];
        let remainingPublishes = MAX_PUBLISHES_PER_REQUEST;
        for (const scan of scans) {
          const result = await ingestBrand(env, scan, remainingPublishes);
          remainingPublishes -= result.published;
          results.push(result);
        }
        await env.DB.prepare(
          "INSERT INTO state(key,value) VALUES('last_github_run',CURRENT_TIMESTAMP) " +
          "ON CONFLICT(key) DO UPDATE SET value=CURRENT_TIMESTAMP"
        ).run();
        return Response.json({ ok: true, results });
      } catch (error) {
        const message = String(error?.stack || error).slice(0, 1500);
        await env.DB.prepare(
          "INSERT INTO state(key,value) VALUES('last_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
        ).bind(message).run();
        return Response.json({ ok: false, error: message }, { status: 500 });
      }
    }
    if (url.pathname === "/profile-ingest" && request.method === "POST") {
      if (!authorized(request, env)) return Response.json({ ok: false }, { status: 401 });
      try {
        const body = await request.json();
        return Response.json({ ok: true, ...(await ingestProfile(env, body?.items)) });
      } catch (error) {
        const message = String(error?.stack || error).slice(0, 1500);
        await saveState(env, "last_profile_error", message);
        return Response.json({ ok: false, error: message }, { status: 500 });
      }
    }
    if (url.pathname === "/telegram" && request.method === "POST") {
      if (request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) {
        return Response.json({ ok: false }, { status: 401 });
      }
      const update = await request.json();
      ctx.waitUntil(handleTelegramUpdate(env, update));
      return Response.json({ ok: true });
    }
    if (url.pathname === "/configure-webhook" && request.method === "POST") {
      if (request.headers.get("x-setup-key") !== env.SETUP_KEY) {
        return Response.json({ ok: false }, { status: 401 });
      }
      const result = await telegram(env, "setWebhook", {
        url: `${url.origin}/telegram`,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["message"],
        drop_pending_updates: false
      });
      return Response.json({ ok: true, result });
    }
    return Response.json({ ok: false, error: "Not found" }, { status: 404 });
  }
};

import brandConfig from "../brands.json" with { type: "json" };

const DEAL_RATIO = 0.55;
const MAX_PUBLISHES_PER_REQUEST = 4;
const TELEGRAM_SEND_INTERVAL_MS = 3200;
const MIN_DISPATCH_INTERVAL_MS = 270000;
const GITHUB_WORKFLOW_DISPATCH_URL = "https://api.github.com/repos/coppolaalberto441-alt/vinted-resale-bot/actions/workflows/vinted-scan.yml/dispatches";
const TOPIC_COLORS = [0x6FB9F0, 0xFFD67E, 0xCB86DB, 0x8EEE98, 0xFF93B2, 0xFB6F5F];
const BRAND_NAMES = brandConfig.brands.map(({ query }) => String(query));

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function amount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function selectDeals(items) {
  const priced = items
    .map((item) => ({ item, total: amount(item.total) || amount(item.price) }))
    .filter(({ total }) => total > 0)
    .sort((a, b) => a.total - b.total);
  if (priced.length < 5) return [];
  const middle = Math.floor(priced.length / 2);
  const median = priced.length % 2
    ? priced[middle].total
    : (priced[middle - 1].total + priced[middle].total) / 2;
  return priced
    .filter(({ total }) => total <= median * DEAL_RATIO)
    .map(({ item, total }) => ({ item, total, median }));
}

export function resaleEstimate(median, purchaseTotal = 0) {
  const marketMedian = amount(median);
  const acquisition = amount(purchaseTotal);
  if (marketMedian <= 0) return null;
  const roundMarketPrice = (value) => {
    const step = value >= 50 ? 5 : 1;
    return Math.max(step, Math.round(value / step) * step);
  };
  const low = roundMarketPrice(marketMedian * 0.75);
  const high = Math.max(low, roundMarketPrice(marketMedian * 0.90));
  return {
    low,
    high,
    profitLow: Math.max(0, low - acquisition),
    profitHigh: Math.max(0, high - acquisition)
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
    await sendSetupStatus(env, chatId, `✅ Configurazione completata: ${created} sezioni create, ${existing} già presenti. I prossimi annunci saranno divisi per brand.`);
  } catch (error) {
    await sendSetupStatus(env, chatId, `⚠️ Configurazione parziale: ${created} create, ${existing} già presenti. Riprova /setup tra un minuto.`);
    throw error;
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
}

async function handleTelegramUpdate(env, update) {
  const message = update?.message;
  if (!message || !isSetupCommand(message.text)) return;
  await setupTopics(env, message);
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
      `💰 Rivendita stimata: <b>${resale.low.toFixed(2)}–${resale.high.toFixed(2)} ${escapeHtml(currency)}</b>`,
      `📈 Margine lordo stimato: <b>${resale.profitLow.toFixed(2)}–${resale.profitHigh.toFixed(2)} ${escapeHtml(currency)}</b>`,
      "ℹ️ Stima basata sugli annunci attivi dello stesso brand; vendita non garantita", ""
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

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(Promise.all([runScheduledScan(env), syncLatestGroupTopics(env)]));
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

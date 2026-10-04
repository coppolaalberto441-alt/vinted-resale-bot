const DEAL_RATIO = 0.55;
const MAX_PUBLISHES_PER_REQUEST = 4;
const TELEGRAM_SEND_INTERVAL_MS = 3200;

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

async function telegram(env, method, body) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (response.ok) return;
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

async function publish(env, query, deal) {
  const { item, total, median } = deal;
  const price = amount(item.price);
  const currency = item.currency || "EUR";
  const discount = median > 0 ? Math.round((1 - total / median) * 100) : 0;
  const caption = [
    `🔥 <b>${escapeHtml(item.title || "Occasione Vinted")}</b>`, "",
    `💶 Prezzo: <b>${price.toFixed(2)} ${escapeHtml(currency)}</b>`,
    `🧾 Totale noto: <b>${total.toFixed(2)} ${escapeHtml(currency)}</b>`,
    `📐 ${escapeHtml(item.details || "Dettagli non disponibili")}`,
    `👤 ${escapeHtml(item.seller || "Venditore non indicato")}`,
    `📊 ${discount}% sotto la mediana degli annunci attivi`, "",
    `Ricerca: ${escapeHtml(query)}`
  ].join("\n");
  const reply_markup = { inline_keyboard: [[{ text: "Apri annuncio", url: item.url }]] };
  if (item.image_url) {
    try {
      await telegram(env, "sendPhoto", {
        chat_id: env.CHANNEL_ID, photo: item.image_url, caption,
        parse_mode: "HTML", reply_markup
      });
      return;
    } catch (error) {
      if (String(error).includes("HTTP 429")) throw error;
    }
  }
  await telegram(env, "sendMessage", {
    chat_id: env.CHANNEL_ID, text: caption, parse_mode: "HTML", reply_markup
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

export default {
  async fetch(request, env) {
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
    return Response.json({ ok: false, error: "Not found" }, { status: 404 });
  }
};

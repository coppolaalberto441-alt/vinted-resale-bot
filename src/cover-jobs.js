const PREFIX = 'cover_job:';
const DISPATCH = 'https://api.github.com/repos/coppolaalberto441-alt/vinted-resale-bot/actions/workflows/vinted-cover.yml/dispatches';
const MAX_BYTES = 8 * 1024 * 1024;
const reply = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const keyOf = id => /^[a-f0-9-]{36}$/.test(String(id || '')) ? PREFIX + id : '';

async function tg(env, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error('Telegram cover delivery failed');
  return result.result;
}

export async function dispatchCovers(env) {
  if (env.FREE_COVERS_ENABLED !== 'true' || !env.GITHUB_ACTIONS_TOKEN) return false;
  const response = await fetch(DISPATCH, { method: 'POST', headers: {
    authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`, accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28', 'user-agent': 'vinted-resale-cloudflare'
  }, body: JSON.stringify({ ref: 'main' }) });
  return response.status === 204;
}

export async function queueCover(env, fileId, destination) {
  if (env.FREE_COVERS_ENABLED !== 'true') {
    await tg(env, 'sendMessage', { ...destination, text: '📸 Copertina generativa disattivata: originale conservato. Scontorno gratuito non ancora attivato.' });
    return;
  }
  const now = Date.now(), id = crypto.randomUUID();
  const job = { id, file_id: fileId, destination, status: 'queued', created_at: now, expires_at: now + 30*60000 };
  await env.DB.prepare('INSERT INTO state(key,value) VALUES(?,?)').bind(PREFIX+id, JSON.stringify(job)).run();
  let dispatched = false;
  try { dispatched = await dispatchCovers(env); } catch (_) { /* Cron will try again. */ }
  await tg(env, 'sendMessage', { ...destination, text: `📸 Scontorno gratuito ${dispatched ? 'avviato su GitHub' : 'in coda; riprovo al prossimo ciclo'}. Può richiedere alcuni minuti. Sfondo neutro, senza ridisegnare colore, logo o tessuto. Controlla sempre il risultato; puoi già usare /genera.` });
}

export async function maintainCoverJobs(env, now = Date.now()) {
  if (env.FREE_COVERS_ENABLED !== 'true') return;
  const rows = await env.DB.prepare('SELECT key,value FROM state WHERE key>=? AND key<? LIMIT 30').bind(PREFIX, PREFIX+'~').all();
  let queued = false;
  for (const row of rows.results || []) {
    const job = JSON.parse(row.value);
    const stale = job.expires_at <= now || (job.status !== 'queued' && job.claimed_at < now-15*60000);
    if (stale) {
      // Compare-and-delete: concurrent maintenance runs must not send duplicate fallbacks.
      const removed = await env.DB.prepare('DELETE FROM state WHERE key=? AND value=? RETURNING key').bind(row.key,row.value).first();
      if (removed) await tg(env, 'sendPhoto', { ...job.destination, photo: job.file_id,
        caption: 'Scontorno non completato: ecco l’originale. Nessuna parte del capo è stata ricostruita e nessun servizio a pagamento è stato attivato.' });
    } else if (job.status === 'queued') queued = true;
  }
  if (queued) await dispatchCovers(env);
}

async function readJob(env, request, id) {
  const key = keyOf(id);
  if (!key) return null;
  const row = await env.DB.prepare('SELECT value FROM state WHERE key=?').bind(key).first();
  if (!row) return null;
  const job = JSON.parse(row.value);
  return job.status === 'processing' && job.expires_at > Date.now() && job.lease === request.headers.get('x-cover-lease') ? job : null;
}

export async function coverRoute(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/cover-jobs/')) return null;
  // Never allow the string "Bearer undefined" to authenticate an unconfigured worker.
  if (!env.INGEST_SECRET || request.headers.get('authorization') !== `Bearer ${env.INGEST_SECRET}`) return reply({ok:false},401);
  if (env.FREE_COVERS_ENABLED !== 'true') return reply({ok:false},503);
  if (url.pathname === '/cover-jobs/claim' && request.method === 'POST') {
    const now = Date.now(), lease = crypto.randomUUID();
    const row = await env.DB.prepare("UPDATE state SET value=json_set(value,'$.status','processing','$.lease',?,'$.claimed_at',?) WHERE key=(SELECT key FROM state WHERE key>=? AND key<? AND json_extract(value,'$.status')='queued' AND json_extract(value,'$.expires_at')>? ORDER BY key LIMIT 1) RETURNING value")
      .bind(lease,now,PREFIX,PREFIX+'~',now).first();
    return reply({ok:true,job:row ? {id:JSON.parse(row.value).id,lease} : null});
  }
  const id = url.searchParams.get('id'), job = await readJob(env,request,id);
  if (!job) return reply({ok:false},404);
  if (url.pathname === '/cover-jobs/image' && request.method === 'GET') {
    const file = await tg(env,'getFile',{file_id:job.file_id});
    if (!file?.file_path || file.file_size > MAX_BYTES) return reply({ok:false},413);
    const source = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
    if (!source.ok) return reply({ok:false},502);
    const data = await source.arrayBuffer();
    if (data.byteLength > MAX_BYTES) return reply({ok:false},413);
    return new Response(data,{headers:{'content-type':'image/jpeg','cache-control':'no-store'}});
  }
  if (url.pathname === '/cover-jobs/result' && request.method === 'POST') {
    if (Number(request.headers.get('content-length') || 0) > MAX_BYTES) return reply({ok:false},413);
    const fallback = request.headers.get('content-type') !== 'image/png';
    const bytes = fallback ? null : new Uint8Array(await request.arrayBuffer());
    if (bytes && (bytes.length > MAX_BYTES || bytes.length < 24 || ![137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v))) return reply({ok:false},400);
    if (bytes) {
      const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      const width=view.getUint32(16), height=view.getUint32(20);
      if (!width || !height || width>4096 || height>4096) return reply({ok:false},400);
    }
    // Reserve delivery atomically; retries cannot publish the same output twice.
    const reserved = await env.DB.prepare("UPDATE state SET value=json_set(value,'$.status','delivering') WHERE key=? AND json_extract(value,'$.status')='processing' AND json_extract(value,'$.lease')=? RETURNING key")
      .bind(keyOf(id),job.lease).first();
    if (!reserved) return reply({ok:false},409);
    if (fallback) {
      await tg(env,'sendPhoto',{...job.destination,photo:job.file_id,caption:'Scontorno incerto o non disponibile: mantengo l’originale. Nessun colore, logo, piega o difetto viene ridisegnato. Prova con il capo intero su uno sfondo uniforme.'});
    } else {
      const form = new FormData();
      for (const [key,value] of Object.entries(job.destination)) form.append(key,String(value));
      form.append('document',new Blob([bytes],{type:'image/png'}),'copertina-fedele.png');
      form.append('caption','📸 Copertina scontornata, non rigenerata. Il capo mantiene i pixel originali; sfondo e margini sono cambiati. Controlla bordi e parti mancanti: lo scontorno può sbagliare. Ombre, pieghe e difetti restano. Conserva anche l’originale nell’annuncio.');
      const response=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`,{method:'POST',body:form});
      const result=await response.json();
      if (!response.ok || !result.ok) throw new Error('Cover upload failed');
    }
    await env.DB.prepare('DELETE FROM state WHERE key=?').bind(keyOf(id)).run();
    return reply({ok:true});
  }
  return reply({ok:false},404);
}

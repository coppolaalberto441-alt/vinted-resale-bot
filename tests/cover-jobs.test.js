import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { queueCover, coverRoute, maintainCoverJobs } from '../src/cover-jobs.js';
import { makeCover, requestPhotoCover } from '../src/index.js';

function fixture() {
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  const env={FREE_COVERS_ENABLED:'true',INGEST_SECRET:'test-secret',GITHUB_ACTIONS_TOKEN:'test',TELEGRAM_BOT_TOKEN:'test',
    AI:{run(){throw new Error('No Cloudflare AI allowed for covers');}},DB:{prepare(sql){
      const statement={bind(...args){return {
        async first(){return db.prepare(sql).get(...args);},async all(){return {results:db.prepare(sql).all(...args)};},async run(){return db.prepare(sql).run(...args);}
      };}};return Object.assign(statement,statement.bind());
    }}};
  return {db,env};
}
const request=(path,method='POST',lease='',data=null,type='application/json',secret='test-secret')=>new Request('https://worker.test/cover-jobs/'+path,{method,headers:{authorization:'Bearer '+secret,'x-cover-lease':lease,'content-type':type},...(data?{body:data}:{})});

test('queue and real claim never expose Telegram IDs or call Cloudflare AI; claim is single-owner',async()=>{
  const {db,env}=fixture(), saved=globalThis.fetch, calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return String(url).includes('github.com')?new Response(null,{status:204}):Response.json({ok:true,result:{}});};
  try {
    await makeCover(env,new Uint8Array([1]),'private-file',{chat_id:123,message_thread_id:77});
    const row=db.prepare("SELECT value FROM state WHERE key LIKE 'cover_job:%'").get();
    assert.ok(row);
    assert.equal(calls.some(call=>call.url.includes('flux')),false);
    const github=calls.find(call=>call.url.includes('github.com'));
    assert.deepEqual(JSON.parse(github.options.body),{ref:'main'});
    const response=await coverRoute(request('claim'),env), body=await response.json();
    assert.deepEqual(Object.keys(body.job).sort(),['id','lease']);
    assert.doesNotMatch(JSON.stringify(body),/private-file|chat_id|123/);
    assert.equal((await (await coverRoute(request('claim'),env)).json()).job,null);
    assert.equal((await coverRoute(request('image?id='+body.job.id,'GET','wrong'),env)).status,404);
  } finally {globalThis.fetch=saved;db.close();}
});

test('unauthorized and unconfigured routes cannot claim or read jobs',async()=>{
  const {db,env}=fixture();
  try {
    assert.equal((await coverRoute(request('claim','POST','',null,'application/json','wrong'),env)).status,401);
    delete env.INGEST_SECRET;
    assert.equal((await coverRoute(request('claim','POST','',null,'application/json','undefined'),env)).status,401);
  } finally {db.close();}
});

test('result stays in the same topic, sends PNG as a document and refuses duplicate delivery',async()=>{
  const {db,env}=fixture(),saved=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return String(url).includes('github.com')?new Response(null,{status:204}):Response.json({ok:true,result:{}});};
  try {
    await queueCover(env,'file',{chat_id:123,message_thread_id:77});
    const {job}=await (await coverRoute(request('claim'),env)).json();
    const path='result?id='+job.id;
    assert.equal((await coverRoute(request(path,'POST',job.lease,new Uint8Array([1]),'image/png'),env)).status,400);
    const png=new Uint8Array(24);png.set([137,80,78,71,13,10,26,10]);const view=new DataView(png.buffer);view.setUint32(16,600);view.setUint32(20,800);
    assert.equal((await coverRoute(request(path,'POST',job.lease,png,'image/png'),env)).status,200);
    const upload=calls.find(call=>call.url.endsWith('sendDocument')).options.body;
    assert.equal(upload.get('message_thread_id'),'77');
    assert.equal(upload.get('document').type,'image/png');
    assert.equal((await coverRoute(request(path,'POST',job.lease,png,'image/png'),env)).status,404);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM state WHERE key LIKE 'cover_job:%'").get().n,0);
  } finally {globalThis.fetch=saved;db.close();}
});

test('failure and stale jobs return original, never paid or generative fallback',async()=>{
  const {db,env}=fixture(),saved=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return String(url).includes('github.com')?new Response(null,{status:204}):Response.json({ok:true,result:{}});};
  try {
    await queueCover(env,'original',{chat_id:123});
    const {job}=await (await coverRoute(request('claim'),env)).json();
    await coverRoute(request('result?id='+job.id,'POST',job.lease,'{}'),env);
    assert.equal(JSON.parse(calls.find(call=>call.url.endsWith('sendPhoto')).options.body).photo,'original');
    await queueCover(env,'stale-original',{chat_id:123});
    await maintainCoverJobs(env,Date.now()+31*60000);
    await maintainCoverJobs(env,Date.now()+31*60000);
    assert.equal(calls.filter(call=>call.url.endsWith('sendPhoto')).length,2);
    assert.ok(calls.every(call=>call.url.startsWith('https://api.telegram.org/')||call.url.startsWith('https://api.github.com/')));
  } finally {globalThis.fetch=saved;db.close();}
});

test('manual cover selection uses only the current user session and the daily budget',async()=>{
  const {db,env}=fixture(),saved=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return String(url).includes('github.com')?new Response(null,{status:204}):Response.json({ok:true,result:{}});};
  db.prepare('INSERT INTO photo_sessions(chat_id,user_id,analyses) VALUES(?,?,?)').run('123','42',JSON.stringify([{fileId:'first'},{fileId:'second'}]));
  db.prepare('INSERT INTO photo_sessions(chat_id,user_id,analyses) VALUES(?,?,?)').run('123','99',JSON.stringify([{fileId:'other-user'}]));
  try {
    await requestPhotoCover(env,{chat:{id:123},from:{id:42},text:'/copertina 2',message_thread_id:77});
    const job=JSON.parse(db.prepare("SELECT value FROM state WHERE key LIKE 'cover_job:%'").get().value);
    assert.equal(job.file_id,'second');
    assert.equal(job.destination.message_thread_id,77);
    for(let i=0;i<10;i++) await requestPhotoCover(env,{chat:{id:123},from:{id:42},text:'/copertina 1'});
    assert.equal(db.prepare("SELECT COUNT(*) n FROM state WHERE key LIKE 'cover_job:%'").get().n,10);
    assert.ok(calls.some(call=>call.url.endsWith('sendMessage')&&JSON.parse(call.options.body).text.includes('Limite gratuito')));
    await requestPhotoCover(env,{chat:{id:123},from:{id:42},text:'/copertina 9'});
    assert.match(JSON.parse(calls.at(-1).options.body).text,/Usa \/copertina/);
  } finally {globalThis.fetch=saved;db.close();}
});

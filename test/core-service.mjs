import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginService } from '../dist/core/service.js';

const store = () => { const values = new Map(); return { values, async get(k, fallback) { return values.has(k) ? values.get(k) : fallback; }, async set(k,v) { values.set(k,v); } }; };
const harness = (options = {}) => {
  const db = options.db ?? store(), sends = [], sessions = new Set(), calls = [], creds = { key: undefined, async resolve(){ return this.key; }, async set(v){ this.key=v; }, async clear(){ this.key=undefined; } };
  const dsh = { async list(){ return [{id:'w1',name:'Workspace',path:'C:/work',available:true}]; }, async register(path){ return {id:'w1',name:'Workspace',path,available:true}; }, async validate(id){ if(id!=='w1') throw Error('missing'); return {id:'w1',name:'Workspace',path:'C:/work',available:true}; }, async createSession(w,s){ calls.push(['create',w,s]); sessions.add(s); }, async sendPrompt(s,r,p){ calls.push(['send',s,r]); sends.push(p); }, async sessionExists(s){ return sessions.has(s); } };
  return { db, sends, sessions, calls, creds, dsh, async service(opts={}) { return PluginService.create({store:db,credentials:creds,dsh,logDirectory:'unused',fetch:opts.fetch}); } };
};
const json = (obj, status=200) => new Response(JSON.stringify(obj), {status, headers:{'content-type':'application/json'}});

test('mock default makes no network requests and returns broad deterministic metadata', async () => {
  let count=0; const h=harness(), s=await h.service({fetch:async()=>{count++; throw Error('network');}});
  const result=await s.call('list',{});
  assert.equal(count,0); assert.equal(result.catalog.projects.length,130); assert.ok(result.total>=120); assert.ok(result.rows.every(r=>!('description' in r.issue)));
  assert.equal(result.filters.statuses[0],'open'); assert.ok(result.catalog.categories.some(c=>c.name==='Общее'));
});

test('real Redmine uses GET, API key header, paginates old REST responses, and excludes issue body', async () => {
  const h=harness(); let issueRequest; const requests=[]; const fetch=async (url,init) => {
    assert.equal(init.method,'GET'); assert.equal(init.headers['X-Redmine-API-Key'],'topsecret'); assert.equal(init.redirect,'error');
    requests.push(url);
    const u=new URL(url); const path=u.pathname.split('/').at(-1);
    if(path==='current.json') return json({user:{id:5,login:'ada',firstname:'Ada',lastname:'Lovelace'}});
    if(path==='projects.json') { const offset=Number(u.searchParams.get('offset')||0); return json({projects:offset?[]:[{id:1,name:'P'}],total_count:1}); }
    if(path==='issues.json') { issueRequest=u; const offset=Number(u.searchParams.get('offset')||0); return json({issues:offset?[]:[{id:3,subject:'Subject',description:'DO NOT KEEP',project:{id:1,name:'P'},status:{id:2,name:'Open'},assigned_to:{id:5,name:'Ada'},updated_on:'2025-01-01'},{id:4,subject:'Other user',project:{id:1,name:'P'},status:{id:2,name:'Open'},assigned_to:{id:9,name:'Not Ada'}},{id:6,subject:'Closed item',project:{id:1,name:'P'},status:{id:5,name:'Closed'},assigned_to:{id:5,name:'Ada'}}],total_count:3}); }
    if(path==='issue_statuses.json') return json({issue_statuses:[{id:2,name:'Open',is_closed:false},{id:5,name:'Closed',is_closed:true}]});
    if(path==='trackers.json') return json({trackers:[]});
    if(path==='issue_priorities.json') return json({issue_priorities:[]});
    if(path==='issue_categories.json') return json({issue_categories:[]});
    throw Error(path);
  };
  const s=await h.service({fetch}); await s.call('configure',{mockEnabled:false,baseUrl:'https://redmine.example/base',apiKey:'topsecret'}); const result=await s.call('list',{});
  assert.equal(issueRequest.searchParams.get('assigned_to_id'),'me'); assert.equal(issueRequest.searchParams.get('status_id'),'*');
  assert.equal(result.total,1);
  assert.equal(result.rows[0].issue.url,'https://redmine.example/base/issues/3'); assert.equal('description' in result.rows[0].issue,false);
  assert.equal(result.user.name,'Ada Lovelace'); assert.equal(requests.filter(x=>new URL(x).pathname.endsWith('issue_categories.json')).length,1);
  const filtered=await s.call('list',{filters:{statuses:['5'],search:'#6'}}); assert.equal(filtered.total,1); assert.equal(filtered.rows[0].issue.id,6);
  const all=await s.call('list',{filters:{statuses:['*'],search:''}}); assert.equal(all.total,2);
});

test('all project pages are fetched, categories are lazy, and server-open fallback works without status catalog', async () => {
  const h=harness(), projectOffsets=[]; const fetch=async (url,init) => {
    assert.equal(init.method,'GET'); const u=new URL(url), path=u.pathname.split('/').at(-1);
    if(path==='current.json') return json({user:{id:5,login:'ada'}});
    if(path==='projects.json') { const off=Number(u.searchParams.get('offset')||0); projectOffsets.push(off); return json({projects:off===0?Array.from({length:100},(_,i)=>({id:i+1,name:`P${i+1}`})):[{id:101,name:'P101'}],total_count:101}); }
    if(path==='issues.json') { const status=u.searchParams.get('status_id'), all=[{id:7,subject:'Unknown open',project:{id:1,name:'P1'},status:{id:9,name:'New'},assigned_to:{id:5,name:'Ada'}},{id:8,subject:'Unknown closed',project:{id:1,name:'P1'},status:{id:10,name:'Done'},assigned_to:{id:5,name:'Ada'}}]; const rows=status==='open'?[all[0]]:status==='closed'?[all[1]]:all; return json({issues:rows,total_count:rows.length}); }
    if(path==='issue_statuses.json') return json({},403);
    if(path==='trackers.json') return json({trackers:[]});
    if(path==='issue_priorities.json') return json({issue_priorities:[]});
    if(path==='issue_categories.json') return json({issue_categories:[{id:1,name:'Common'}],total_count:1});
    throw Error(path);
  };
  const s=await h.service({fetch}); await s.call('configure',{mockEnabled:false,baseUrl:'https://redmine.example',apiKey:'k'}); const result=await s.call('list',{});
  assert.deepEqual(projectOffsets,[0,100]); assert.equal(result.catalog.projects.length,101); assert.deepEqual(result.catalog.categories.map(c=>c.projectId),[1]);
  assert.equal(result.rows.length,1); assert.equal(result.rows[0].issue.id,7); assert.equal(result.rows[0].issue.status.closed,false); assert.ok(result.catalog.warnings.some(x=>x.startsWith('statuses:')));
  const all=await s.call('list',{filters:{statuses:['*']}}); assert.equal(all.total,2); assert.deepEqual(all.rows.map(r=>r.issue.status.closed).sort(),[false,true]);
  const closed=await s.call('list',{filters:{statuses:['closed']}}); assert.equal(closed.total,1); assert.equal(closed.rows[0].issue.id,8);
});

test('healthcheck distinguishes forbidden and mock health does not claim a real check', async () => {
  const h=harness(), s=await h.service({fetch:async()=>json({},403)}); const mock=await s.call('check',{}); assert.equal(mock.mock,true); assert.equal(mock.status,'warning');
  await s.call('configure',{mockEnabled:false,baseUrl:'https://redmine.example',apiKey:'secret'});
  const bad=await s.call('check',{}); assert.equal(bad.status,'error'); assert.ok(bad.steps.some(x=>x.httpStatus===403)); assert.match(bad.steps.find(x=>x.httpStatus===403).message,/прав/);
});

test('launch retries reuse a session and request ID; duplicate operation is one session', async () => {
  const h=harness(); const s=await h.service(); const data=await s.call('list',{}); await s.call('selectWorkspace',{issueId:data.rows[0].issue.id,workspaceId:'w1',rememberProject:true});
  let fail=true; h.dsh.sendPrompt=async (session,request,prompt)=>{ h.calls.push(['send',session,request]); if(fail){fail=false; throw Error('temporary failure');} h.sends.push(prompt); };
  const op='stable-op'; await assert.rejects(s.call('launch',{issueId:data.rows[0].issue.id,operationId:op}), e=>e.sessionId==='redmine-stable-op');
  const complete=await s.call('launch',{issueId:data.rows[0].issue.id,operationId:op}); const duplicate=await s.call('launch',{issueId:data.rows[0].issue.id,operationId:op});
  assert.equal(complete.sessionId,duplicate.sessionId); assert.equal(h.calls.filter(x=>x[0]==='create').length,1); assert.equal(h.calls.filter(x=>x[0]==='send').length,2); assert.match(h.sends[0],/демонстрационный запуск/i); assert.match(h.sends[0],/Не вызывай Redmine, MCP или сеть/i); assert.doesNotMatch(h.sends[0],/redmine\.invalid|10000/);
});

test('diagnostic records redact credential material and require developer mode', async () => {
  const h=harness(), s=await h.service(); await s.call('configure',{developerMode:true});
  await s.call('clientEvent',{level:'info',operation:'launch'}); const logs=await s.call('logs',{}); assert.ok(logs.length); assert.equal(JSON.stringify(logs).includes('topsecret'),false);
  const s2=await harness().service(); await assert.rejects(s2.call('logs',{}),/developer mode/);
});

test('network errors redact the exact configured key from health and persisted logs', async () => {
  const h=harness(), s=await h.service({fetch:async()=>{throw Error('transport rejected secret-value');}});
  await s.call('configure',{mockEnabled:false,baseUrl:'https://redmine.example',apiKey:'secret-value',developerMode:true});
  const health=await s.call('check',{}); assert.equal(JSON.stringify(health).includes('secret-value'),false);
  const logs=await s.call('logs',{}); assert.equal(JSON.stringify(logs).includes('secret-value'),false);
});

test('diagnostic writes serialize concurrently and storage failure does not fail feature operations', async () => {
  const h=harness(); const s=await h.service(); await s.call('configure',{developerMode:true});
  await Promise.all(Array.from({length:20},(_,i)=>s.diagnostic('info','test','parallel',`record-${i}`,{operation:`operation-${i}`})));
  const entries=await s.call('logs',{}); assert.equal(entries.filter(x=>x.component==='test' && x.operation==='parallel').length,20);
  const underlying=store(), failingDb={get:underlying.get,async set(k,v){if(k==='redmine.diagnostics') throw Error('disk unavailable'); return underlying.set(k,v);}};
  const h2=harness({db:failingDb}), s2=await h2.service(); await s2.call('configure',{developerMode:true}); const list=await s2.call('list',{}); assert.ok(list.total>0);
});

test('scope changes reset filters and invalid URL cannot be configured', async () => {
  const h=harness(), s=await h.service(); await s.call('list',{filters:{search:'needle'}}); await s.call('configure',{baseUrl:'https://redmine.example',mockEnabled:false});
  const state=await s.call('state',{}); assert.equal(state.filters.search,'');
  await assert.rejects(s.call('configure',{baseUrl:'http://redmine.invalid',mockEnabled:false}),/HTTPS/);
});

test('in-flight Redmine work keeps its captured URL/key and cannot continue after reconfiguration', async () => {
  const h=harness(), requests=[]; let releaseA, markAStarted; const startedA=new Promise(r=>markAStarted=r);
  const fetch=async (url,init) => {
    const host=new URL(url).host; requests.push({host,key:init.headers['X-Redmine-API-Key'],url});
    if(host==='redmine-a.example' && !releaseA) return new Promise(resolve=>{releaseA=()=>resolve(json({user:{id:5,login:'ada'}})); markAStarted();});
    const path=new URL(url).pathname.split('/').at(-1);
    if(path==='current.json') return json({user:{id:5,login:'ada'}});
    if(path==='projects.json') return json({projects:[],total_count:0});
    if(path==='issues.json') return json({issues:[],total_count:0});
    if(path==='issue_statuses.json') return json({issue_statuses:[]});
    if(path==='trackers.json') return json({trackers:[]});
    if(path==='issue_priorities.json') return json({issue_priorities:[]});
    return json({issue_categories:[],total_count:0});
  };
  const s=await h.service({fetch}); await s.call('configure',{mockEnabled:false,baseUrl:'https://redmine-a.example',apiKey:'key-A'});
  const old=s.call('list',{refresh:true}); await startedA; await s.call('configure',{baseUrl:'https://redmine-b.example',apiKey:'key-B'});
  releaseA(); await assert.rejects(old,/superseded/); await s.call('list',{refresh:true});
  assert.equal(requests[0].host,'redmine-a.example'); assert.equal(requests[0].key,'key-A');
  assert.ok(requests.filter(x=>x.host==='redmine-b.example').every(x=>x.key==='key-B'));
});

test('switching to mock aborts an in-flight real request and prevents follow-up Redmine calls', async () => {
  const h=harness(), requests=[]; let release, markStarted; const started=new Promise(r=>markStarted=r);
  const fetch=async (url,init) => { requests.push({url,key:init.headers['X-Redmine-API-Key']}); return new Promise(resolve=>{release=()=>resolve(json({user:{id:5,login:'ada'}})); markStarted();}); };
  const s=await h.service({fetch}); await s.call('configure',{mockEnabled:false,baseUrl:'https://redmine-a.example',apiKey:'key-A'});
  const pending=s.call('list',{refresh:true}); await started; await s.call('configure',{mockEnabled:true}); release(); await assert.rejects(pending,/superseded/);
  assert.equal(requests.length,1); assert.equal(new URL(requests[0].url).host,'redmine-a.example'); assert.equal(requests[0].key,'key-A');
});

test('concurrent list requests are serialized so older filters cannot overwrite newer filters', async () => {
  const h=harness(), requests=[]; let releaseFirst, startedResolve; const firstStarted=new Promise(r=>startedResolve=r); let firstCurrent=true;
  const fetch=async (url,init) => {
    const u=new URL(url), path=u.pathname.split('/').at(-1); requests.push(u.href);
    if(path==='current.json' && firstCurrent) { firstCurrent=false; return new Promise(resolve=>{releaseFirst=()=>resolve(json({user:{id:5,login:'ada'}})); startedResolve();}); }
    if(path==='current.json') return json({user:{id:5,login:'ada'}});
    if(path==='projects.json') return json({projects:[{id:1,name:'One'},{id:2,name:'Two'}],total_count:2});
    if(path==='issues.json') return json({issues:[{id:21,subject:'One task',project:{id:1,name:'One'},status:{id:2,name:'Open',is_closed:false},assigned_to:{id:5,name:'Ada'}},{id:22,subject:'Two task',project:{id:2,name:'Two'},status:{id:2,name:'Open',is_closed:false},assigned_to:{id:5,name:'Ada'}}],total_count:2});
    if(path==='issue_statuses.json') return json({issue_statuses:[{id:2,name:'Open',is_closed:false}]});
    if(path==='trackers.json') return json({trackers:[]}); if(path==='issue_priorities.json') return json({issue_priorities:[]});
    if(path==='issue_categories.json') return json({issue_categories:[],total_count:0}); throw Error(path);
  };
  const s=await h.service({fetch}); await s.call('configure',{mockEnabled:false,baseUrl:'https://redmine.example',apiKey:'k'});
  const a=s.call('list',{refresh:true,filters:{projects:[1]}}); await firstStarted;
  const b=s.call('list',{refresh:true,filters:{projects:[2]}}); assert.equal(requests.length,1);
  releaseFirst(); const [ra,rb]=await Promise.all([a,b]); assert.deepEqual(ra.rows.map(r=>r.issue.id),[21]); assert.deepEqual(rb.rows.map(r=>r.issue.id),[22]);
});

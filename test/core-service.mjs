import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginService } from '../dist/core/service.js';

const store = () => { const values = new Map(); return { values, async get(k, fallback) { return values.has(k) ? values.get(k) : fallback; }, async set(k,v) { values.set(k,v); } }; };
const harness = (options = {}) => {
  const db = options.db ?? store(), sends = [], sessions = new Set(), calls = [], renames = [], creds = { key: undefined, async resolve(){ return this.key; }, async set(v){ this.key=v; }, async clear(){ this.key=undefined; } };
  let planModePresetFailures = options.planModePresetFailures ?? 0, planModeEnableFailures = options.planModeEnableFailures ?? 0;
  const dsh = { async list(){ return [{id:'w1',name:'Workspace',path:'C:/work',available:true}]; }, async register(path){ return {id:'w1',name:'Workspace',path,available:true}; }, async validate(id){ if(id!=='w1') throw Error('missing'); return {id:'w1',name:'Workspace',path:'C:/work',available:true}; }, async createSession(w,s,preset){ calls.push(['create',w,s,preset]); sessions.add(s); }, async planModePreset(){ calls.push(['plan-preflight']); if(planModePresetFailures-->0) throw Error('Plan mode unavailable'); return options.agentPreset ?? 'default-preset'; }, async enablePlanMode(s){ calls.push(['plan-mode',s]); if(planModeEnableFailures-->0) throw Error('Plan mode set failed'); }, async sendPrompt(s,r,p){ calls.push(['send',s,r]); sends.push(p); }, async renameSession(s,t){ calls.push(['rename',s,t]); renames.push({sessionId:s,title:t}); }, async sessionExists(s){ return sessions.has(s); }, async existingSessions(ids){ calls.push(['existingSessions', [...ids]]); return [...new Set(ids)].filter(id=>sessions.has(id)); } };
  return { db, sends, sessions, calls, renames, creds, dsh, async service(opts={}) { return PluginService.create({store:db,credentials:creds,dsh,logDirectory:'unused',fetch:opts.fetch}); } };
};
const json = (obj, status=200) => new Response(JSON.stringify(obj), {status, headers:{'content-type':'application/json'}});
const launchFromPreflight = async (service, issueId, operationId, expectedContextGeneration) => {
  const { confirmationToken } = await service.call('issueSessions', { issueId, expectedContextGeneration });
  return service.call('launch', { issueId, operationId, confirmationToken });
};

test('mock default makes no network requests and returns broad deterministic metadata', async () => {
  let count=0; const h=harness(), s=await h.service({fetch:async()=>{count++; throw Error('network');}});
  const result=await s.call('list',{});
  assert.equal(count,0); assert.equal(result.catalog.projects.length,130); assert.ok(result.total>=120); assert.ok(result.rows.every(r=>!('description' in r.issue)));
  assert.equal(result.filters.statuses[0],'open'); assert.ok(result.catalog.categories.some(c=>c.name==='Общее'));
});

test('plan-mode launch preference defaults off and persists across Host service reload', async () => {
  const h=harness(), first=await h.service();
  assert.equal((await first.call('state',{})).settings.launchInPlanMode,false);
  await first.call('configure',{launchInPlanMode:true});
  const second=await h.service();
  assert.equal((await second.call('state',{})).settings.launchInPlanMode,true);
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
    if(path==='issue_priorities.json') return json({issue_priorities:[]});
    if(/^\d+\.json$/.test(path)) return json({project:{id:Number(path.slice(0,-5)),trackers:[{id:3,name:'Bug'}],issue_categories:[]}});
    throw Error(path);
  };
  const s=await h.service({fetch}); await s.call('configure',{mockEnabled:false,baseUrl:'https://redmine.example/base',apiKey:'topsecret'}); const result=await s.call('list',{});
  assert.equal(issueRequest.searchParams.get('assigned_to_id'),'me'); assert.equal(issueRequest.searchParams.get('status_id'),'*');
  assert.equal(result.total,1);
  assert.equal(result.rows[0].issue.url,'https://redmine.example/base/issues/3'); assert.equal('description' in result.rows[0].issue,false);
  assert.equal(result.user.name,'Ada Lovelace'); assert.deepEqual(result.catalog.trackers,[{id:3,name:'Bug'}]); assert.equal(requests.filter(x=>new URL(x).pathname.endsWith('issue_categories.json')).length,0); assert.ok(requests.some(x=>new URL(x).pathname.endsWith('/projects/1.json') && new URL(x).searchParams.get('include')==='trackers,issue_categories'));
  const filtered=await s.call('list',{filters:{statuses:['5'],search:'#6'}}); assert.equal(filtered.total,1); assert.equal(filtered.rows[0].issue.id,6);
  const all=await s.call('list',{filters:{statuses:['*'],search:''}}); assert.equal(all.total,2);
});

test('all project pages are fetched, categories stay scoped, and server-open fallback works without status catalog', async () => {
  const h=harness(), projectOffsets=[]; const fetch=async (url,init) => {
    assert.equal(init.method,'GET'); const u=new URL(url), path=u.pathname.split('/').at(-1);
    if(path==='current.json') return json({user:{id:5,login:'ada'}});
    if(path==='projects.json') { const off=Number(u.searchParams.get('offset')||0); projectOffsets.push(off); return json({projects:off===0?Array.from({length:100},(_,i)=>({id:i+1,name:`P${i+1}`})):[{id:101,name:'P101'}],total_count:101}); }
    if(path==='issues.json') { const status=u.searchParams.get('status_id'), all=[{id:7,subject:'Unknown open',project:{id:1,name:'P1'},status:{id:9,name:'New'},assigned_to:{id:5,name:'Ada'}},{id:8,subject:'Unknown closed',project:{id:1,name:'P1'},status:{id:10,name:'Done'},assigned_to:{id:5,name:'Ada'}}]; const rows=status==='open'?[all[0]]:status==='closed'?[all[1]]:all; return json({issues:rows,total_count:rows.length}); }
    if(path==='issue_statuses.json') return json({},403);
    if(path==='issue_priorities.json') return json({issue_priorities:[]});
    if(/^\d+\.json$/.test(path)) { const id=Number(path.slice(0,-5)); return json({project:{id,trackers:[{id:id===101?12:4,name:id===101?'Other project type':'Task'}],issue_categories:id===1?[{id:1,name:'Common'}]:[]}}); }
    throw Error(path);
  };
  const s=await h.service({fetch}); await s.call('configure',{mockEnabled:false,baseUrl:'https://redmine.example',apiKey:'k'}); const result=await s.call('list',{});
  assert.deepEqual(projectOffsets,[0,100]); assert.equal(result.catalog.projects.length,101); assert.deepEqual(result.catalog.categories.map(c=>c.projectId),[1]); assert.ok(result.catalog.trackers.some(t=>t.id===12 && t.name==='Other project type'));
  assert.equal(result.rows.length,1); assert.equal(result.rows[0].issue.id,7); assert.equal(result.rows[0].issue.status.closed,false); assert.ok(result.catalog.warnings.some(x=>x.startsWith('statuses:')));
  const all=await s.call('list',{filters:{statuses:['*']}}); assert.equal(all.total,2); assert.deepEqual(all.rows.map(r=>r.issue.status.closed).sort(),[false,true]);
  const closed=await s.call('list',{filters:{statuses:['closed']}}); assert.equal(closed.total,1); assert.equal(closed.rows[0].issue.id,8);
});

test('healthcheck distinguishes forbidden and mock health does not claim a real check', async () => {
  const h=harness(), s=await h.service({fetch:async()=>json({},403)}); const mock=await s.call('check',{}); assert.equal(mock.mock,true); assert.equal(mock.status,'warning');
  await s.call('configure',{mockEnabled:false,baseUrl:'https://redmine.example',apiKey:'secret'});
  const bad=await s.call('check',{}); assert.equal(bad.status,'error'); assert.ok(bad.steps.some(x=>x.httpStatus===403)); assert.match(bad.steps.find(x=>x.httpStatus===403).message,/прав/);
});

test('healthcheck validates categories and trackers through project details and reports sample scope', async () => {
  const h=harness(), requests=[]; const fetch=async (url,init) => {
    const u=new URL(url), path=u.pathname.split('/').at(-1); requests.push(u);
    assert.equal(init.method,'GET');
    if(path==='current.json') return json({user:{id:5,login:'ada'}});
    if(path==='projects.json') return json({projects:[{id:21,name:'Sample'}],total_count:1});
    if(path==='issues.json') return json({issues:[],total_count:0});
    if(path==='issue_statuses.json') return json({issue_statuses:[]});
    if(path==='issue_priorities.json') return json({issue_priorities:[]});
    if(path==='21.json') return json({project:{id:21,trackers:[{id:4,name:'Bug'}],issue_categories:[]}});
    throw Error(path);
  };
  const s=await h.service({fetch}); await s.call('configure',{mockEnabled:false,baseUrl:'https://redmine.example',apiKey:'k'});
  const health=await s.call('check',{});
  assert.equal(health.status,'ok'); assert.equal(health.steps.find(x=>x.name==='Категории').message,'Список доступен (проект #21)'); assert.equal(health.steps.find(x=>x.name==='Типы задач').message,'Список доступен (проект #21)');
  assert.equal(requests.filter(u=>/issue_categories\.json$/.test(u.pathname)).length,0); assert.equal(requests.filter(u=>u.pathname.endsWith('/projects/21.json')).length,1);
});

test('healthcheck keeps categories available when project details omit trackers', async () => {
  const h=harness(), fetch=async url => {
    const u=new URL(url), path=u.pathname.split('/').at(-1);
    if(path==='current.json') return json({user:{id:5,login:'ada'}});
    if(path==='projects.json') return json({projects:[{id:21,name:'Sample'}],total_count:1});
    if(path==='issues.json') return json({issues:[],total_count:0});
    if(path==='issue_statuses.json') return json({issue_statuses:[]});
    if(path==='issue_priorities.json') return json({issue_priorities:[]});
    if(path==='21.json') return json({project:{id:21,issue_categories:[]}});
    throw Error(path);
  };
  const s=await h.service({fetch}); await s.call('configure',{mockEnabled:false,baseUrl:'https://redmine.example',apiKey:'k'});
  const health=await s.call('check',{});
  assert.equal(health.status,'warning'); assert.equal(health.steps.find(x=>x.name==='Категории').status,'ok'); assert.equal(health.steps.find(x=>x.name==='Типы задач').status,'warning');
});

test('healthcheck repeats the project endpoint failure for both project capabilities', async () => {
  const h=harness(), fetch=async url => {
    const u=new URL(url), path=u.pathname.split('/').at(-1);
    if(path==='current.json') return json({user:{id:5,login:'ada'}});
    if(path==='projects.json') return json({projects:[{id:21,name:'Sample'}],total_count:1});
    if(path==='issues.json') return json({issues:[],total_count:0});
    if(path==='issue_statuses.json') return json({issue_statuses:[]});
    if(path==='issue_priorities.json') return json({issue_priorities:[]});
    if(path==='21.json') return json({errors:['Not found']},404);
    throw Error(path);
  };
  const s=await h.service({fetch}); await s.call('configure',{mockEnabled:false,baseUrl:'https://redmine.example',apiKey:'k'});
  const health=await s.call('check',{}), categories=health.steps.find(x=>x.name==='Категории'), trackers=health.steps.find(x=>x.name==='Типы задач');
  assert.equal(categories.httpStatus,404); assert.equal(trackers.httpStatus,404); assert.equal(trackers.message,categories.message);
});

test('partial project details are retried on refresh so trackers can recover', async () => {
  const h=harness(); let detailCalls=0; const fetch=async url => {
    const u=new URL(url), path=u.pathname.split('/').at(-1);
    if(path==='current.json') return json({user:{id:5,login:'ada'}});
    if(path==='projects.json') return json({projects:[{id:21,name:'Sample'}],total_count:1});
    if(path==='issues.json') return json({issues:[],total_count:0});
    if(path==='issue_statuses.json') return json({issue_statuses:[]});
    if(path==='issue_priorities.json') return json({issue_priorities:[]});
    if(path==='21.json') { detailCalls++; return json({project:{id:21,issue_categories:[],...(detailCalls > 1 ? {trackers:[{id:4,name:'Recovered'}]} : {})}}); }
    throw Error(path);
  };
  const s=await h.service({fetch}); await s.call('configure',{mockEnabled:false,baseUrl:'https://redmine.example',apiKey:'k'});
  const filters={projects:[21]}; const incomplete=await s.call('list',{filters});
  assert.ok(incomplete.catalog.warnings.some(x=>x.startsWith('trackers:21:')));
  const recovered=await s.call('list',{filters,refresh:true});
  assert.deepEqual(recovered.catalog.trackers,[{id:4,name:'Recovered'}]); assert.equal(detailCalls,2);
});

test('launch retries reuse a session and request ID; duplicate operation is one session', async () => {
  const h=harness(); const s=await h.service(); const data=await s.call('list',{}); await s.call('selectWorkspace',{issueId:data.rows[0].issue.id,workspaceId:'w1',rememberProject:true});
  let fail=true; h.dsh.sendPrompt=async (session,request,prompt)=>{ h.calls.push(['send',session,request]); if(fail){fail=false; throw Error('temporary failure');} h.sends.push(prompt); };
  const op='stable-op'; await assert.rejects(launchFromPreflight(s,data.rows[0].issue.id,op,data.contextGeneration), e=>e.sessionId==='redmine-stable-op');
  const complete=await s.call('launch',{issueId:data.rows[0].issue.id,operationId:op}); const duplicate=await s.call('launch',{issueId:data.rows[0].issue.id,operationId:op});
  assert.equal(complete.sessionId,duplicate.sessionId); assert.equal(h.calls.filter(x=>x[0]==='create').length,1); assert.equal(h.calls.filter(x=>x[0]==='rename').length,1); assert.equal(h.calls.filter(x=>x[0]==='send').length,2); assert.deepEqual(h.calls.filter(x=>x[0]!=='existingSessions').map(x=>x[0]),['create','rename','send','send']); assert.equal(h.renames[0].title,data.rows[0].issue.subject); assert.equal(complete.sessionTitle,data.rows[0].issue.subject); assert.equal(complete.titleApplied,true); assert.match(h.sends[0],/демонстрационный запуск/i); assert.match(h.sends[0],/Не вызывай Redmine, MCP или сеть/i); assert.doesNotMatch(h.sends[0],/redmine\.invalid|10000/);
});

test('plan-mode launch snapshots the default preset and enables the mode before any prompt, including retry', async () => {
  const h=harness({agentPreset:'planning'}), s=await h.service();
  await s.call('configure',{launchInPlanMode:true});
  const data=await s.call('list',{}), issueId=data.rows[0].issue.id;
  await s.call('selectWorkspace',{issueId,workspaceId:'w1',rememberProject:true});
  h.dsh.enablePlanMode=async session=>{ h.calls.push(['plan-mode',session]); if(h.calls.filter(x=>x[0]==='plan-mode').length===1) throw Error('temporary plan service failure'); };
  const operationId='plan-mode-retry';
  await assert.rejects(launchFromPreflight(s,issueId,operationId,data.contextGeneration),/temporary plan service failure/);
  const saved=h.db.values.get(`redmine.scope.mock:user:7.launch.${operationId}`);
  assert.equal(saved.planModeOnLaunch,true); assert.equal(saved.agentPreset,'planning');
  assert.equal(h.calls.filter(x=>x[0]==='send').length,0);
  assert.deepEqual(h.calls.find(x=>x[0]==='create'),['create','w1',`redmine-${operationId}`,'planning']);
  await s.call('configure',{launchInPlanMode:false});
  const complete=await s.call('launch',{issueId,operationId});
  const steps=h.calls.map(x=>x[0]);
  assert.equal(complete.status,'sent'); assert.equal(complete.planModeOnLaunch,true);
  assert.equal(steps.filter(x=>x==='create').length,1); assert.equal(steps.filter(x=>x==='plan-preflight').length,1);
  assert.equal(steps.filter(x=>x==='plan-mode').length,2);
  assert.ok(steps.lastIndexOf('plan-mode') < steps.indexOf('send'));
});

test('plan-mode preflight failure does not create a session or send a prompt', async () => {
  const h=harness({planModePresetFailures:1}), s=await h.service();
  await s.call('configure',{launchInPlanMode:true});
  const data=await s.call('list',{}), issueId=data.rows[0].issue.id;
  await s.call('selectWorkspace',{issueId,workspaceId:'w1',rememberProject:true});
  await assert.rejects(launchFromPreflight(s,issueId,'plan-mode-unavailable',data.contextGeneration),/Plan mode unavailable/);
  assert.equal(h.calls.filter(x=>x[0]==='create').length,0);
  assert.equal(h.sessions.size,0); assert.equal(h.calls.filter(x=>x[0]==='send').length,0);
});

test('preset mismatch stays blocked on same-operation retry even when plan mode is available', async () => {
  const h=harness({agentPreset:'expected-preset'}), s=await h.service();
  await s.call('configure',{launchInPlanMode:true});
  const data=await s.call('list',{}), issueId=data.rows[0].issue.id;
  await s.call('selectWorkspace',{issueId,workspaceId:'w1',rememberProject:true});
  let createCalls=0, planModeCalls=0;
  h.dsh.createSession=async (_workspaceId,sessionId)=>{
    createCalls++; h.sessions.add(sessionId);
    throw Object.assign(new Error('wrong preset returned'),{sessionId,planModePresetMismatch:true});
  };
  h.dsh.enablePlanMode=async sessionId=>{ planModeCalls++; h.calls.push(['plan-mode',sessionId]); };
  const operationId='preset-mismatch-retry';
  await assert.rejects(launchFromPreflight(s,issueId,operationId,data.contextGeneration),/wrong preset returned/);
  const saved=h.db.values.get(`redmine.scope.mock:user:7.launch.${operationId}`);
  assert.equal(saved.planModePresetMismatch,true);
  await assert.rejects(s.call('launch',{issueId,operationId}),/different preset|другим preset/i);
  assert.equal(createCalls,1); assert.equal(planModeCalls,0);
  assert.equal(h.calls.filter(call=>call[0]==='send').length,0);
  assert.equal(h.sessions.has(`redmine-${operationId}`),true);
});

test('issue session preflight returns only live sessions recorded for that loaded issue in one batch', async () => {
  const h=harness(), s=await h.service(), data=await s.call('list',{}), issueId=data.rows[0].issue.id;
  await s.call('selectWorkspace',{issueId,workspaceId:'w1',rememberProject:true});
  await launchFromPreflight(s,issueId,'first-session',data.contextGeneration);
  await launchFromPreflight(s,issueId,'second-session',data.contextGeneration);
  assert.deepEqual(data.rows[0].launches,[]); // the panel's list snapshot is stale
  h.sessions.add('unrelated-session');
  const before=h.calls.filter(call=>call[0]==='existingSessions').length;
  const result=await s.call('issueSessions',{issueId,expectedContextGeneration:data.contextGeneration});
  assert.deepEqual(result.sessions.map(item=>item.sessionId).sort(),['redmine-first-session','redmine-second-session']);
  assert.ok(result.sessions.every(item=>item.issueId===issueId && item.status==='sent'));
  assert.equal(typeof result.confirmationToken,'string');
  assert.equal(h.calls.filter(call=>call[0]==='existingSessions').length,before+1);
  await assert.rejects(s.call('issueSessions',{issueId:999999,expectedContextGeneration:data.contextGeneration}),/loaded metadata list/);
});

test('preflight token is rejected after a Redmine credential context change', async () => {
  const h=harness(), s=await h.service(), data=await s.call('list',{}), issueId=data.rows[0].issue.id;
  await s.call('selectWorkspace',{issueId,workspaceId:'w1',rememberProject:true});
  const { confirmationToken }=await s.call('issueSessions',{issueId,expectedContextGeneration:data.contextGeneration});
  const before=(await s.call('state',{})).contextGeneration;
  await s.call('configure',{apiKey:'replacement-key'});
  const after=(await s.call('state',{})).contextGeneration;
  assert.ok(after>before);
  await assert.rejects(s.call('issueSessions',{issueId,expectedContextGeneration:data.contextGeneration}),/list context changed/i);
  await assert.rejects(s.call('launch',{issueId,operationId:'stale-confirmation',confirmationToken}),/confirmation is stale or expired/i);
  assert.equal(h.calls.filter(call=>call[0]==='create').length,0);
});

test('confirmation token stays revoked when the Redmine user scope changes A to B to A', async () => {
  const h=harness(); let userId=5;
  const fetch=async (url,init) => {
    assert.equal(init.method,'GET');
    const path=new URL(url).pathname.split('/').at(-1);
    if(path==='current.json') return json({user:{id:userId,login:`user-${userId}`}});
    if(path==='projects.json') return json({projects:[{id:1,name:'P'}],total_count:1});
    if(path==='issues.json') return json({issues:[{id:3,subject:'Issue',project:{id:1,name:'P'},status:{id:2,name:'Open',is_closed:false},assigned_to:{id:userId,name:`User ${userId}`}}],total_count:1});
    if(path==='issue_statuses.json') return json({issue_statuses:[{id:2,name:'Open',is_closed:false}]});
    if(path==='issue_priorities.json') return json({issue_priorities:[]});
    if(path==='1.json') return json({project:{id:1,trackers:[{id:4,name:'Task'}],issue_categories:[]}});
    throw Error(path);
  };
  const s=await h.service({fetch});
  await s.call('configure',{mockEnabled:false,baseUrl:'https://redmine.example',apiKey:'key'});
  const load=()=>s.call('list',{refresh:true});
  const userA=await load(); const issueId=userA.rows[0].issue.id;
  const {confirmationToken}=await s.call('issueSessions',{issueId,expectedContextGeneration:userA.contextGeneration});
  userId=6; const userB=await load();
  userId=5; const userAAgain=await load();
  assert.ok(userB.contextGeneration>userA.contextGeneration);
  assert.ok(userAAgain.contextGeneration>userB.contextGeneration);
  await assert.rejects(s.call('launch',{issueId,operationId:'revived-user-token',confirmationToken}),/confirmation is stale or expired/i);
  assert.equal(h.calls.filter(call=>call[0]==='create').length,0);
});

test('one preflight token cannot authorize concurrent launches with different operation IDs', async () => {
  const h=harness(), s=await h.service(), data=await s.call('list',{}), issueId=data.rows[0].issue.id;
  await s.call('selectWorkspace',{issueId,workspaceId:'w1',rememberProject:true});
  const { confirmationToken }=await s.call('issueSessions',{issueId,expectedContextGeneration:data.contextGeneration});
  const results=await Promise.allSettled([
    s.call('launch',{issueId,operationId:'one-shot-a',confirmationToken}),
    s.call('launch',{issueId,operationId:'one-shot-b',confirmationToken}),
  ]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.filter(result=>result.status==='rejected').length,1);
  assert.equal(h.calls.filter(call=>call[0]==='create').length,1);
});

test('failed title operation is retried on the existing session before its prompt', async () => {
  const h=harness(); const s=await h.service(); const data=await s.call('list',{}); await s.call('selectWorkspace',{issueId:data.rows[0].issue.id,workspaceId:'w1',rememberProject:true});
  const title=data.rows[0].issue.subject; let fail=true;
  h.dsh.renameSession=async(session,requestedTitle)=>{ h.calls.push(['rename',session,requestedTitle]); h.renames.push({sessionId:session,title:requestedTitle}); if(fail){fail=false; throw Error('title service unavailable');} };
  const op='title-retry'; await assert.rejects(launchFromPreflight(s,data.rows[0].issue.id,op,data.contextGeneration), e=>e.sessionId==='redmine-title-retry');
  const stored=h.db.values.get(`redmine.scope.mock:user:7.launch.${op}`); assert.equal(stored.sessionId,'redmine-title-retry'); assert.equal(stored.status,'failed'); assert.equal(stored.titleApplied,undefined); assert.equal(stored.sessionTitle,title);
  const complete=await s.call('launch',{issueId:data.rows[0].issue.id,operationId:op});
  assert.equal(complete.status,'sent'); assert.equal(complete.sessionId,'redmine-title-retry'); assert.equal(complete.titleApplied,true); assert.equal(h.calls.filter(x=>x[0]==='create').length,1); assert.equal(h.calls.filter(x=>x[0]==='rename').length,2); assert.equal(h.calls.filter(x=>x[0]==='send').length,1); assert.deepEqual(h.calls.filter(x=>x[0]!=='existingSessions').map(x=>x[0]),['create','rename','rename','send']); assert.ok(h.calls.indexOf(h.calls.find(x=>x[0]==='rename'))<h.calls.findIndex(x=>x[0]==='send')); assert.deepEqual(h.renames.map(x=>x.title),[title,title]);
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
    if(path==='issue_priorities.json') return json({issue_priorities:[]});
    if(/^\d+\.json$/.test(path)) return json({project:{id:Number(path.slice(0,-5)),trackers:[],issue_categories:[]}});
    return json({});
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
    if(path==='issue_priorities.json') return json({issue_priorities:[]});
    if(/^\d+\.json$/.test(path)) return json({project:{id:Number(path.slice(0,-5)),trackers:[],issue_categories:[]}}); throw Error(path);
  };
  const s=await h.service({fetch}); await s.call('configure',{mockEnabled:false,baseUrl:'https://redmine.example',apiKey:'k'});
  const a=s.call('list',{refresh:true,filters:{projects:[1]}}); await firstStarted;
  const b=s.call('list',{refresh:true,filters:{projects:[2]}}); assert.equal(requests.length,1);
  releaseFirst(); const [ra,rb]=await Promise.all([a,b]); assert.deepEqual(ra.rows.map(r=>r.issue.id),[21]); assert.deepEqual(rb.rows.map(r=>r.issue.id),[22]);
});

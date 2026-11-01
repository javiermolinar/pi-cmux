import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import cmuxStart from '../extensions/cmux-start.ts';
import registerMessaging from '../extensions/cmux-messages.ts';
import { makeEnvelope } from '../lib/messaging/protocol.ts';
import { FOLLOWUP_CONTEXT, FOLLOWUP_INTENT } from '../lib/messaging/receipts.ts';
import { orientationHarness } from './helpers/orientation.mjs';
import { effectiveCommand } from './helpers/launch-command.mjs';
async function setup(t,options={}){
 // Fake cmux creation never starts a child. Keep startup polling unconfirmed,
 // but do not spend ten wall-clock seconds per fixture waiting for its binding.
 const timeout=globalThis.setTimeout;t.mock.method(globalThis,'setTimeout',(callback,ms,...args)=>{
  if(ms!==250)return timeout(callback,ms,...args);queueMicrotask(()=>callback(...args));return 0;
 });
 const h=orientationHarness(t,options);h.ctx.sessionManager=SessionManager.create(h.root,h.root);h.ctx.sessionManager.appendMessage({role:'user',content:'Explicitly delegated review with findings returned',timestamp:1});h.ctx.hasPendingMessages=()=>false;
 const queue=[],messages=[],peers=new Map();h.pi.sendMessage=(message,delivery)=>{messages.push({message,delivery});h.ctx.sessionManager.appendCustomMessageEntry(message.customType,message.content,message.display,message.details)};
 const runtime=registerMessaging(h.pi,{client:()=>({ready:async()=>{},settings:async()=>true,list:async()=>[...queue]}),peer:id=>peers.get(id)});
 t.after(()=>runtime.detach());await h.emit('session_start');cmuxStart(h.pi);
 return {...h,queue,messages,peers,messaging:runtime,invoke:(params,signal)=>h.tools.get('cmux_start_pi').execute('fixture-launch',params,signal,undefined,h.ctx)};
}
test('authorized fresh launch embeds exact return route and grants only that child/request',async t=>{
 const h=await setup(t,{exec:async(_cmd,args)=>{
  if(!args.includes('create'))return;
  // Match real CLI formatting: default JSON has refs only; both adds full IDs.
  const both=args[args.indexOf('--id-format')+1]==='both';
  return {code:0,killed:false,stdout:JSON.stringify({workspace_ref:'workspace:2',surface_ref:'surface:2',...(both?{surface_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}:{})})};
 }}),result=await h.invoke({returnResults:true,role:'review',prompt:'Review auth; do not modify files',focus:false});await h.messaging.worker.tick();
 assert.equal(result.details.automaticReturn.state,'awaiting-live-child-binding');const id=result.details.automaticReturn.requestId;assert.match(id,/^[a-f0-9-]{36}$/);assert.equal(result.details.orientation.taskId,h.runtime.state.taskId);
 const command=effectiveCommand(h.calls.find(c=>c.args[0]==='respawn-pane').args.at(-1));assert.ok(command.includes(id));assert.ok(command.includes(h.location.surfaceId));assert.ok(command.includes('cmux_message_send'));assert.ok(command.includes('kind result'));assert.ok(command.includes('Review auth; do not modify files'));
 const owner={surfaceId:h.location.surfaceId,sessionId:h.ctx.sessionManager.getSessionId(),conversationId:h.runtime.state.conversationId,taskId:h.runtime.state.taskId};
 const peer={...owner,surfaceId:result.details.created.surface_id,sessionId:randomUUID(),conversationId:result.details.orientation.conversationId};
 const envelope=makeEnvelope(peer,owner,id,'result','Delegated review complete');h.queue.push({id:randomUUID(),thread_id:randomUUID(),sender_surface_id:peer.surfaceId,recipient_surface_id:owner.surfaceId,body:JSON.stringify(envelope),state:'queued',in_reply_to:null});
 await h.messaging.worker.tick();assert.equal(h.messages.length,0,'launch is not readiness; unknown child binding cannot deliver');
 h.peers.set(peer.surfaceId,peer);await h.messaging.worker.tick();assert.equal(h.messages.length,1);assert.equal(h.messages[0].message.customType,FOLLOWUP_CONTEXT);assert.deepEqual(h.messages[0].delivery,{triggerTurn:true,deliverAs:'followUp'});assert.equal(h.queue.length,1);
});
test('automatic return alone selects same-task placement before launch',async t=>{
 const h=await setup(t);
 const first=await h.invoke({returnResults:true,prompt:'Review A'}),second=await h.invoke({returnResults:true,prompt:'Review B'});
 assert.equal(first.details.placement,'right');assert.equal(second.details.placement,'tab');
 assert.equal(first.details.orientation.taskId,h.runtime.state.taskId);assert.equal(second.details.children.length,2);
});
test('automatic return instructions stay compact without dropping routing or delivery limits',async t=>{
 const h=await setup(t),result=await h.invoke({returnResults:true,role:'review',prompt:'Review only; do not edit',focus:false});
 const command=effectiveCommand(h.calls.find(c=>c.args[0]==='respawn-pane').args.at(-1)),start=command.indexOf('\n\n[Host result return]\n');
 assert.ok(start>=0,'host return instructions must be separate from the task');
 const suffix=command.slice(start);
 assert.ok(Buffer.byteLength(suffix,'utf8')<=460,'bound appended instructions, not the whole launch request');
 assert.ok(suffix.includes(`target ${h.location.surfaceId}`));assert.ok(suffix.includes(`requestId ${result.details.automaticReturn.requestId}`));
 for(const text of ['On completion, cmux_message_send','kind result','concise findings with report paths/limits','Questions only if blocked on this task','optional progress stays quiet','Expires in 30 min or on parent abort/session change','Do not wait for replies, auto-retry unknown sends, launch workers or expand scope','Queued is not processing confirmation'])assert.ok(suffix.includes(text),text);
});
test('findings from different launched peers coalesce without granting unrelated traffic authority',async t=>{
 let count=0;const h=await setup(t,{exec:async(_cmd,args)=>args.includes('create')?{code:0,killed:false,stdout:JSON.stringify({workspace_ref:'workspace:2',surface_ref:`surface:${++count+1}`,surface_id:randomUUID()})}:undefined});
 const a=await h.invoke({placement:'workspace',returnResults:true,prompt:'Review A',focus:false}),b=await h.invoke({placement:'workspace',returnResults:true,prompt:'Review B',focus:false});await h.messaging.worker.tick();
 const owner={surfaceId:h.location.surfaceId,sessionId:h.ctx.sessionManager.getSessionId(),conversationId:h.runtime.state.conversationId,taskId:h.runtime.state.taskId};
 for(const [i,result] of [a,b].entries()){
  const peer={...owner,surfaceId:result.details.created.surface_id,sessionId:randomUUID(),conversationId:result.details.orientation.conversationId};h.peers.set(peer.surfaceId,peer);const envelope=makeEnvelope(peer,owner,result.details.automaticReturn.requestId,'result',`Review ${i} findings`);h.queue.push({id:randomUUID(),thread_id:randomUUID(),sender_surface_id:peer.surfaceId,recipient_surface_id:owner.surfaceId,body:JSON.stringify(envelope),state:'queued',in_reply_to:null});
 }
 await h.messaging.worker.tick();assert.equal(h.messages.length,1);assert.equal(h.messages[0].message.details.receipts.length,2);assert.equal(h.messaging.snapshot().returnRequests,2);assert.equal(h.queue.length,2);
});
test('ordinary independent and merely related launches gain no return permission or prompt rewrite',async t=>{
 for(const params of [{},{related:true},{role:'review'}]){
  const h=await setup(t);const result=await h.invoke({...params,prompt:'Independent review',focus:false});assert.equal(result.details.automaticReturn,undefined);assert.equal(h.messaging.snapshot().returnRequests,0);assert.ok(h.calls.find(c=>c.args[0]==='respawn-pane').args.at(-1).endsWith(" -- 'Independent review'"));
 }
});
for(const params of [{returnResults:true,continueSession:true},{returnResults:true,related:false},{returnResults:true,role:'continue'},{returnResults:'yes'},{returnResults:true,prompt:''}])test(`invalid return option rejects before creation: ${JSON.stringify(params)}`,async t=>{
 const h=await setup(t);await assert.rejects(h.invoke({prompt:'Review task',...params}));assert.equal(h.calls.some(c=>c.args.includes('create')||c.args.includes('new-split')||c.args.includes('respawn-pane')),false);
});
for(const phase of ['before-intake','receiving-check','intent-write'])test(`replaced own claim during ${phase} cannot enqueue through production self resolution`,async t=>{
 const h=await setup(t),result=await h.invoke({returnResults:true,prompt:'Offline review',focus:false});await h.messaging.worker.tick();
 const owner=h.messaging.currentOwner(h.ctx),peer={...owner,surfaceId:result.details.created.surface_id,sessionId:randomUUID(),conversationId:result.details.orientation.conversationId};h.peers.set(peer.surfaceId,peer);
 const replace=()=>h.store.write(h.location.surfaceId,{...h.store.read(h.location.surfaceId),token:randomUUID()});
 if(phase==='before-intake')replace();
 if(phase==='receiving-check')h.messaging.client.settings=async()=>{replace();return true};
 if(phase==='intent-write'){const append=h.pi.appendEntry;h.pi.appendEntry=(type,data)=>{append(type,data);if(type===FOLLOWUP_INTENT)replace()}};
 const envelope=makeEnvelope(peer,owner,result.details.automaticReturn.requestId,'result','Offline finding');h.queue.push({id:randomUUID(),thread_id:randomUUID(),sender_surface_id:peer.surfaceId,recipient_surface_id:owner.surfaceId,body:JSON.stringify(envelope),state:'queued',in_reply_to:null});
 await h.messaging.worker.tick();assert.equal(h.messages.length,0);assert.equal(h.queue.length,1);
 await assert.rejects(h.messaging.prepareReturn(h.ctx),/live cmux UUID ownership/);
});

const launchCases=[];
for(const placement of ['workspace','right','down','tab']){
 for(const phase of ['identify',...(placement==='workspace'?[]:['inventory']),'creation','discovery','boot','rename'])launchCases.push({placement,phase,mode:'abort',returned:true});
 for(const mode of ['off','owner'])for(const phase of ['identify','rename'])launchCases.push({placement,phase,mode,returned:true});
 for(const mode of ['abort','owner'])launchCases.push({placement,phase:'identify',mode,returned:false});
}
launchCases.push({placement:'workspace',phase:'identify',mode:'session',returned:false});
for(const {placement,phase,mode,returned} of launchCases)test(`${placement} ${returned?'automatic':'ordinary'} launch stops on ${mode} at ${phase}`,async t=>{
 let h,armed=false,created=false,triggered=false;const controller=new AbortController();
 const stop=async()=>{
  if(!armed)return;armed=false;triggered=true;
  if(mode==='abort')controller.abort();
  if(mode==='off')h.messaging.disable();
  if(mode==='owner')h.store.write(h.location.surfaceId,{...h.store.read(h.location.surfaceId),token:randomUUID()});
  if(mode==='session'){h.ctx.sessionManager=SessionManager.create(h.root,h.root);h.ctx.sessionManager.appendMessage({role:'user',content:'Other offline task',timestamp:2});await h.emit('session_start')};
 };
 h=await setup(t,{exec:async(_command,args)=>{
  const creation=args.includes('create')||args.includes('new-split')||args.includes('new-surface');
  if(creation){created=true;if(phase==='creation')await stop();if(phase==='discovery')return {code:0,killed:false,stdout:JSON.stringify(placement==='workspace'?{workspace_ref:'workspace:2'}:{})}};
  if(phase==='identify'&&args.includes('identify'))await stop();
  if(phase==='inventory'&&!created&&args.includes('list-panes'))await stop();
  if(phase==='rename'&&args[0]==='rename-tab')await stop();
  if(phase==='discovery'&&created&&args.includes('list-panes')){
   await stop();return {code:0,killed:false,stdout:JSON.stringify({panes:[{ref:placement==='tab'?'pane:1':'pane:2',surface_refs:['surface:2']}]})};
  }
 }});
 await h.runtime.renameTopic('Offline fixture');
 const setTimeout=globalThis.setTimeout;t.mock.method(globalThis,'setTimeout',(callback,ms,...args)=>{
  if(ms!==250)return setTimeout(callback,ms,...args);
  if(phase==='boot')void stop();queueMicrotask(callback);return 0;
 });
 armed=true;const afterCreation=['creation','discovery','boot','rename'].includes(phase);
 await assert.rejects(h.invoke({placement,returnResults:returned,prompt:'Fake task; never executed',focus:false},controller.signal),
  afterCreation?/created.*Do not relaunch automatically/is:/abort|stale|binding|origin/i);
 assert.equal(triggered,true);assert.equal(h.calls.filter(c=>c.args.includes('create')||c.args.includes('new-split')||c.args.includes('new-surface')).length,afterCreation?1:0);
 assert.equal(h.calls.filter(c=>c.args[0]==='respawn-pane').length,0);assert.equal(h.messaging.snapshot().returnRequests,0);
});

for(const placement of ['workspace','right','down','tab'])test(`${placement} abort after child-command dispatch preserves already-launched/no-retry outcome`,async t=>{
 let h,armed=false;const controller=new AbortController();
 h=await setup(t,{exec:async(_command,args)=>{if(armed&&args[0]==='respawn-pane'){armed=false;controller.abort()}}});
 await h.runtime.renameTopic('Offline fixture');
 const setTimeout=globalThis.setTimeout;t.mock.method(globalThis,'setTimeout',(callback,ms,...args)=>{if(ms!==250)return setTimeout(callback,ms,...args);queueMicrotask(callback);return 0});
 armed=true;const result=await h.invoke({placement,returnResults:true,prompt:'Fake task; never executed',focus:false},controller.signal);
 assert.equal(result.details.automaticReturn.state,'not-configured');assert.match(result.details.automaticReturn.warning,/already launched.*Do not relaunch/i);
 assert.equal(h.calls.filter(c=>c.args.includes('create')||c.args.includes('new-split')||c.args.includes('new-surface')).length,1);
 assert.equal(h.calls.filter(c=>c.args[0]==='respawn-pane').length,1);assert.equal(h.messaging.snapshot().returnRequests,0);
});
test('standalone start extension fails before creation when automatic returns are unavailable',async t=>{
 const h=orientationHarness(t);await h.emit('session_start');cmuxStart(h.pi);await assert.rejects(h.tools.get('cmux_start_pi').execute('fixture',{returnResults:true,prompt:'Review'},undefined,undefined,h.ctx),/bundled messaging/);assert.equal(h.calls.some(c=>c.args.includes('create')),false);
});
test('missing child UUID after successful launch reports not-configured, never a safe-to-retry launch failure',async t=>{
 const h=await setup(t,{exec:async(_cmd,args)=>args.includes('create')?{code:0,killed:false,stdout:JSON.stringify({workspace_ref:'workspace:2',surface_ref:'surface:2'})}:undefined});const result=await h.invoke({placement:'workspace',returnResults:true,prompt:'Review',focus:false});assert.equal(result.details.automaticReturn.state,'not-configured');assert.match(result.details.automaticReturn.warning,/already launched.*Do not relaunch/);assert.equal(h.calls.filter(c=>c.args.includes('create')).length,1);assert.equal(h.messaging.snapshot().returnRequests,0);
});

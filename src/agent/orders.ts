/** 订单范围与报告：独立于不可覆盖的执行原件，缺失记录保持未知。 */
import {readSavedAttempts, type SavedAttempt} from './attempt-records.js';
import {classifyError} from './execution-error.js';
import {mkdir, readFile, writeFile, readdir} from 'node:fs/promises';
import {join, resolve, relative, isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {AGENT_TASKS, type AgentTaskId} from './tasks.js';
import {canonical} from './diff.js';
import {isRecord} from '../util.js';
import {readReview, type ReviewView} from './review.js';
import {readRoundMetrics, type RoundMetrics} from './round-metrics.js';
import {readOutputRecord} from '../output-records.js';
import {prepareRecordInput, singleRequest, type RecordInput} from '../record-input.js';
import {parseRenderRequest} from '../request.js';
import {withLocalAccess} from '../local-access.js';
import {writeAtomicJson} from './execution.js';
import type {RoundRecord} from './run.js';
import {isDeepStrictEqual} from 'node:util';
import {workspaceFingerprint} from './round-files.js';
import {loadWorkspaceDocuments} from '../workspace.js';

const hash=(value:unknown)=>'sha256:'+createHash('sha256').update(canonical(value)).digest('hex');
const id=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
export interface OrderPlan {readonly id:string; readonly task:AgentTaskId; readonly root:string}
export interface OrderDefinition {readonly id:string; readonly plans:readonly OrderPlan[]; readonly deliveries:readonly {id:string; plan:string; request:unknown}[]}
const pricedMetrics=['inputTokens','outputTokens','cacheReadTokens','cacheCreationTokens'] as const;
interface OrderPricing {version:string;provider:string;currency:string;endpoint:string;model:string;basis:'separate-input-output-cache';perMillion:Record<typeof pricedMetrics[number],number>}
export interface OrderScope {readonly format:'renderweave-order-scope/1'; readonly id:string; readonly orders:readonly OrderDefinition[]; readonly pricing?:OrderPricing}
interface SavedScope {format:'renderweave-order-register/1'; declaredAt:string; scope:OrderScope; identity:string}
function scopeOf(value:unknown):OrderScope {
  if(!isRecord(value)||value.format!=='renderweave-order-scope/1'||!id(value.id)||!Array.isArray(value.orders)||!value.orders.length)throw new Error('订单范围格式无效');
  if(value.pricing!==undefined){
    const p=value.pricing;
    if(!isRecord(p)||!['version','provider','endpoint','model'].every(k=>typeof p[k]==='string'&&p[k])||typeof p.currency!=='string'||! /^[A-Z]{3}$/.test(p.currency)||p.basis!=='separate-input-output-cache'||!isRecord(p.perMillion)||!pricedMetrics.every(k=>typeof (p.perMillion as Record<string,unknown>)[k]==='number'&&Number.isFinite((p.perMillion as Record<string,number>)[k])&&(p.perMillion as Record<string,number>)[k]!>=0))throw new Error('计价需提供版本、提供方、端点、模型、币种及完整独立用量费率');
  }
  const orders=new Set<string>(),roots:{root:string;task:string}[]=[];
  for(const order of value.orders){
    if(!isRecord(order)||!id(order.id)||orders.has(order.id)||!Array.isArray(order.plans)||!order.plans.length||!Array.isArray(order.deliveries))throw new Error('订单必须有唯一标识、计划及正式出图要求');
    orders.add(order.id);const plans=new Set<string>();
    for(const plan of order.plans){
      if(!isRecord(plan)||!id(plan.id)||plans.has(plan.id)||typeof plan.task!=='string'||!Object.hasOwn(AGENT_TASKS,plan.task)||typeof plan.root!=='string'||!plan.root)throw new Error('订单计划无效');
      plans.add(plan.id);plan.root=resolve(plan.root);roots.push({root:plan.root as string,task:plan.task});
    }
    const deliveries=new Set<string>();
    for(const delivery of order.deliveries){
      if(!isRecord(delivery)||!id(delivery.id)||deliveries.has(delivery.id)||typeof delivery.plan!=='string'||!plans.has(delivery.plan))throw new Error('正式出图必须有唯一标识并关联预登记计划');
      const request=parseRenderRequest(delivery.request).request;
      if(!request||request.mode!=='final')throw new Error('订单只能以有效正式出图请求定义交付');
      deliveries.add(delivery.id);delivery.request=request;
    }
  }
  for(let i=0;i<roots.length;i++)for(let j=i+1;j<roots.length;j++){
    const a=roots[i]!,b=roots[j]!;
    if(a.task===b.task&&(inside(a.root,b.root)||inside(b.root,a.root)))throw new Error('同任务计划执行目录不能重叠');
  }
  return value as unknown as OrderScope;
}
export async function initializeOrderScope(dir:string,value:unknown):Promise<SavedScope>{
  const scope=scopeOf(structuredClone(value)),declaredAt=new Date().toISOString();const saved:SavedScope={format:'renderweave-order-register/1',declaredAt,scope,identity:hash({scope,declaredAt})};
  await mkdir(dir);await writeFile(join(dir,'scope.json'),JSON.stringify(saved,null,2)+'\n',{flag:'wx'});return saved;
}
async function openScope(dir:string):Promise<SavedScope>{
  const saved=JSON.parse(await readFile(join(dir,'scope.json'),'utf8')) as SavedScope;
  if(saved.format!=='renderweave-order-register/1'||hash({scope:scopeOf(saved.scope),declaredAt:saved.declaredAt})!==saved.identity)throw new Error('预登记订单范围已改变');return saved;
}
const inside=(root:string,path:string)=>{const rel=relative(resolve(root),resolve(path));return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../');};
async function optional<T>(file:string):Promise<T|undefined>{try{return JSON.parse(await readFile(file,'utf8')) as T;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}}
function elapsed(start:string|undefined,end:string|undefined):number|undefined{
  const begin=Date.parse(start??''),finish=Date.parse(end??'');
  return Number.isFinite(begin)&&Number.isFinite(finish)&&finish>=begin?finish-begin:undefined;
}
interface Attempt {elapsedMs?:number;error?:string;aliases?:string[];attemptId?:string;experiment?:string|null;legacy?:boolean;id:string;plan:string;dir:string;usage?:RoundMetrics;startedAt:string|null;endedAt:string|null;original:string;originalIdentity:string|null;view?:ReviewView;record?:RoundRecord;execution?:string;previous:string|null}
async function collect(plan:OrderPlan):Promise<Attempt[]>{
  const found:Attempt[]=[],metadata=new Map<string,SavedAttempt>();
  const visit=async(dir:string):Promise<void>=>{
    let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
    const names=new Set(entries.map(e=>e.name));
    if(names.has('attempts'))for(const attempt of await readSavedAttempts(dir)){
      if(attempt.record.task!==plan.task)continue;
      const original=join(attempt.dir,'round');metadata.set(resolve(original),attempt);
      const exists=await optional(join(original,'round.json'))??await optional(join(original,'execution.json'))??await optional(join(original,'round-start.json'));
      if(!exists)found.push({elapsedMs:attempt.completion?.elapsedMs??undefined,error:attempt.completion?.error,id:'attempt:'+attempt.record.id,attemptId:attempt.record.id,experiment:attempt.record.experiment,legacy:attempt.record.legacy,
        plan:plan.id,dir:original,usage:await readRoundMetrics(original,plan.root,plan.task),startedAt:attempt.record.startedAt,endedAt:attempt.completion?.endedAt??null,original:'unknown',originalIdentity:null,previous:null});
    }
    if(names.has('round.json')||names.has('round-start.json')||names.has('execution.json')){
      const record=await optional<RoundRecord>(join(dir,'round.json')),start=await optional<{task:string}>(join(dir,'round-start.json'));
      if((record?.task??start?.task)&&((record?.task??start?.task)!==plan.task))return;
      const inspected=await readReview(dir);
      if(inspected.problems.length&&!inspected.execution?.committed)throw new Error('订单轮次无法核对：'+inspected.problems.map(p=>p.code).join(','));
      if(inspected.execution?.start&&inspected.execution.start.task!==plan.task)throw new Error('订单计划与轮次任务不一致');
      const attempt=metadata.get(resolve(dir));
      const usage=await readRoundMetrics(dir,plan.root,plan.task);
      found.push({elapsedMs:attempt?.completion?attempt.completion.elapsedMs??undefined:elapsed(record?.startedAt,record?.endedAt),error:record?.run.error??attempt?.completion?.error,attemptId:attempt?.record.id,experiment:attempt?.record.experiment,legacy:attempt?.record.legacy??!inspected.execution,id:inspected.execution?.owner.id??hash(record),plan:plan.id,dir,usage,
        startedAt:record?.startedAt??inspected.execution?.start?.startedAt??null,endedAt:record?.endedAt??null,
        original:record?.verdict??'unknown',originalIdentity:(await optional<{contentIdentity?:{id:string}}>(join(dir,'check.json')))?.contentIdentity?.id??null,view:inspected.view,record,execution:inspected.execution?.status,
        previous:record?.inputs.previous?.dir??inspected.execution?.start?.inputs.previous?.dir??null});return;
    }
    for(const entry of entries){if(entry.isSymbolicLink())throw new Error('订单范围包含链接，无法固定');
      if(entry.isDirectory()&&!/^\.write-(?:lock|released|abandoned)(?:-|$)/.test(entry.name))await visit(join(dir,entry.name));}
  };
  await visit(plan.root);const unique=new Map<string,Attempt>();for(const attempt of found){const previous=unique.get(attempt.id);
    if(!previous)unique.set(attempt.id,{...attempt,aliases:[attempt.dir]});
    else {const original=attempt.attemptId?attempt:previous;unique.set(attempt.id,{...original,aliases:[...(previous.aliases??[previous.dir]),attempt.dir],view:attempt.view?.applied?attempt.view:previous.view?.applied?previous.view:original.view});}}
  return [...unique.values()].sort((a,b)=>(a.startedAt??'').localeCompare(b.startedAt??'')||a.id.localeCompare(b.id));
}
interface DeliveryEvent {id:string;kind:'delivery';order:string;plan:string;round:string;delivery:string;record:string}
interface HumanEvent {id:string;kind:'labor'|'assessment';order:string;plan:string;round:string;category?:'review'|'correction'|'rework';minutes?:number;phase?:'original'|'corrected';result?:'pass'|'fail'}
type OrderEvent=DeliveryEvent|HumanEvent;
interface StoredEvent {format:'renderweave-order-event/1';scopeIdentity:string;input:OrderEvent;at:string;binding:unknown;integrity:string}
function verifyEvent(event:StoredEvent|undefined,scopeIdentity:string):asserts event is StoredEvent {
  if(!event)throw new Error('订单事件记录已改变');
  const {integrity,...value}=event;
  if(event.format!=='renderweave-order-event/1'||event.scopeIdentity!==scopeIdentity||hash(value)!==integrity)throw new Error('订单事件记录已改变');
}
async function bindHuman(scope:OrderScope,input:HumanEvent){
  const plan=scope.orders.find(o=>o.id===input.order)?.plans.find(p=>p.id===input.plan);
  if(!plan||!inside(plan.root,input.round))throw new Error('人工事件不属于预登记计划');
  const inspected=await readReview(input.round);if(inspected.problems.length||!inspected.view&&!inspected.execution)throw new Error('人工事件关联轮次无法核对');
  const record=await optional<RoundRecord>(join(input.round,'round.json'));
  if((record?.task??inspected.execution?.start?.task)!==plan.task)throw new Error('人工事件与计划任务不一致');
  const outcome=await optional<unknown>(join(input.round,'outcome.json'));
  return {round:inspected.execution?.owner.id??hash(record),original:hash({record:record??null,outcome:outcome??null}),
    ...(input.kind==='assessment'&&input.phase==='corrected'?{review:inspected.view?.contentIdentity?.id??null}: {})};
}
async function bindDelivery(scope:OrderScope,input:DeliveryEvent,verifyCurrent=false){
  const order=scope.orders.find(o=>o.id===input.order),plan=order?.plans.find(p=>p.id===input.plan),need=order?.deliveries.find(d=>d.id===input.delivery&&d.plan===input.plan);
  if(!plan||!need||!inside(plan.root,input.round))throw new Error('事件不属于预登记订单计划');
  const round=await readReview(input.round),view=round.view;
  if(view?.round.task!==plan.task)throw new Error('交付与计划任务不一致');
  if(round.problems.length||!view?.applied)throw new Error('交付必须关联已核对的成功应用');
  const record=await readOutputRecord({dir:input.record});if(!record.record||record.problems.length)throw new Error('必须提供完整正式出图记录');
  const snapshot=JSON.parse(await readFile(join(input.record,'input.json'),'utf8')) as RecordInput;
  const expected=parseRenderRequest(need.request).request;
  if(!expected||!isDeepStrictEqual(singleRequest(snapshot.batch),expected))throw new Error('正式出图与预登记请求不一致');
  if(verifyCurrent)await withLocalAccess([view.applied.workspace,input.round],async()=>{
    if(await workspaceFingerprint(view.applied!.workspace)!==view.applied!.fingerprints.after)throw new Error('工作区在应用之后已改变，不能补认该成品归属');
    const expectedInput=prepareRecordInput(await loadWorkspaceDocuments(view.applied!.workspace),snapshot.batch,snapshot.options).input;
    if(!isDeepStrictEqual(expectedInput.documents,snapshot.documents))throw new Error('正式出图输入不是本次应用的完整依赖');
  });
  for(const resource of view.contentIdentity?.resources??[]){
    const delivered=record.record.resources.find(r=>r.id===resource.id);
    if(delivered&&delivered.state==='available'&&delivered.sha256!==resource.sha256)throw new Error('正式出图资源不是本次审核的内容');
  }
  const templates=view.candidates.filter(c=>c.kind==='template'&&!c.dropped);
  if(!templates.length||templates.some(c=>!isDeepStrictEqual(c.document,snapshot.documents.templates.find(t=>t.name===c.name)?.document)))throw new Error('正式出图不是本次审核应用的模板');
  return {round:round.execution?.owner.id??hash(view.round),commit:view.applied.commitId??hash(view.applied),contentIdentity:view.contentIdentity?.id??null,record:hash(record.record)};
}
export async function recordOrderEvent(dir:string,value:unknown){
  if(!isRecord(value)||!id(value.id)||!id(value.order)||!id(value.plan)||typeof value.round!=='string')throw new Error('订单事件格式无效');
  if(value.kind==='delivery'){if(!id(value.delivery)||typeof value.record!=='string')throw new Error('交付事件格式无效');}
  else if(value.kind==='labor'){if(!['review','correction','rework'].includes(String(value.category))||typeof value.minutes!=='number'||!Number.isFinite(value.minutes)||value.minutes<0)throw new Error('人工时间必须是明确记录的非负分钟');}
  else if(value.kind==='assessment'){if(!['original','corrected'].includes(String(value.phase))||!['pass','fail'].includes(String(value.result)))throw new Error('审核结论需区分原始及修正后成果');}
  else throw new Error('订单事件种类无效');
  const input={...value,round:resolve(value.round),...(value.kind==='delivery'?{record:resolve(value.record as string)}:{})} as unknown as OrderEvent;
  return withLocalAccess([dir],async()=>{
    const saved=await openScope(dir),file=join(dir,'events',input.id+'.json'),old=await optional<StoredEvent>(file);
    if(old){verifyEvent(old,saved.identity);if(!isDeepStrictEqual(old.input,input))throw new Error('事件标识已存在且内容不同');return old;}
    const binding=input.kind==='delivery'?await bindDelivery(saved.scope,input,true):await bindHuman(saved.scope,input);
    const data={format:'renderweave-order-event/1' as const,scopeIdentity:saved.identity,input,binding,at:new Date().toISOString()},event:StoredEvent={...data,integrity:hash(data)};await mkdir(join(dir,'events'),{recursive:true});await writeAtomicJson(file,event,true);return event;
  });
}
const laborKinds=['review','correction','rework'] as const;
function laborTotals(plans:readonly OrderPlan[],events:StoredEvent[]){return Object.fromEntries(laborKinds.map(category=>[category,{
  knownMinutes:events.reduce((n,e)=>n+(e.input.kind==='labor'&&e.input.category===category?e.input.minutes!:0),0),
  unknownPlans:plans.filter(p=>!events.some(e=>e.input.kind==='labor'&&e.input.category===category&&e.input.plan===p.id)).length}]));}
function quality(plans:readonly OrderPlan[],attempts:Attempt[],events:StoredEvent[]){
  const assessments=events.filter(e=>e.input.kind==='assessment');
  const verdict=(values:(string|undefined)[]):string=>!values.length?'unknown':values.includes('fail')?'fail':values.includes('conflicting')?'conflicting':values.includes('unknown')?'unknown':new Set(values).size===1?values[0]!:'conflicting';
  const byPlan=plans.map(plan=>{
    const rounds=attempts.filter(a=>a.plan===plan.id),first=rounds[0],latest=rounds.at(-1);
    const original=assessments.filter(e=>(e.input as HumanEvent).phase==='original'&&(e.binding as {round:string}).round===first?.id);
    const corrected=assessments.filter(e=>(e.input as HumanEvent).phase==='corrected'&&(e.binding as {round:string}).round===latest?.id&&latest?.view?.contentIdentity?.id===(e.binding as {review:string}).review);
    const conclusion=(list:StoredEvent[])=>list.length?new Set(list.map(e=>(e.input as HumanEvent).result)).size===1?(list[0]!.input as HumanEvent).result!:'conflicting':'unknown';
    return {plan:plan.id,original:conclusion(original),corrected:conclusion(corrected)};
  });
  return {original:verdict(byPlan.map(p=>p.original)),corrected:verdict(byPlan.map(p=>p.corrected)),
    agentFirstSuccess:byPlan.every(p=>p.original==='pass'),plans:byPlan,
    assessments:assessments.map(e=>({id:e.input.id,at:e.at,phase:(e.input as HumanEvent).phase,result:(e.input as HumanEvent).result,binding:e.binding}))};
}
const metrics=['inputTokens','outputTokens','thinkingTokens','cacheReadTokens','cacheCreationTokens','toolCalls','persistedResults'] as const;
function totals(attempts:Attempt[]){return {usage:Object.fromEntries(metrics.map(key=>[key,{known:attempts.reduce((n,a)=>n+(a.usage?.[key]??0),0),unknownAttempts:attempts.filter(a=>a.usage?.[key]===undefined||(key.endsWith('Tokens')&&a.usage?.usageSource==='messages')).length}]))};}
type DeliverySummary={delivery:string}&Awaited<ReturnType<typeof bindDelivery>>;
interface OrderResult {events:StoredEvent[];history:ReturnType<typeof history>;totals:ReturnType<typeof totals>;timing:ReturnType<typeof timing>;id:string;status:string;labor:ReturnType<typeof laborTotals>;quality:ReturnType<typeof quality>;attempts:{evidence:ReturnType<typeof evidence>;elapsedMs?:number;startedAt:string|null;endedAt:string|null;attemptId?:string;experiment?:string|null;id:string;plan:string;dir:string;usage?:RoundMetrics;original:string;originalIdentity:string|null;execution?:string;previous:string|null;checkpoint?:NonNullable<RoundRecord['inputs']['previous']>['checkpoint']}[];commits:string[];deliveries:DeliverySummary[]}
function evidence(attempt:Attempt){
  return {recordIdentity:attempt.record?hash(attempt.record):null,check:attempt.originalIdentity?join(attempt.dir,'check.json'):null,
    review:attempt.view?.review.status??null,reviewIdentity:attempt.view?.contentIdentity?.id??null,
    candidates:attempt.view?.candidates.map(({path,kind,name,dropped,edited})=>({path,kind,name,dropped,edited}))??[]};
}
function timing(attempts:Attempt[]){
  const intervals=attempts.flatMap(a=>{const start=Date.parse(a.startedAt??''),end=Date.parse(a.endedAt??'');return Number.isFinite(start)&&Number.isFinite(end)&&end>=start?[[start,end] as const]:[];}).sort((a,b)=>a[0]-b[0]);
  let knownExecutionWallMs=0,last=-Infinity;
  for(const [start,end] of intervals){knownExecutionWallMs+=Math.max(0,end-Math.max(last,start));last=Math.max(last,end);}
  return {knownExecutionWallMs,executionWallMs:intervals.length===attempts.length?knownExecutionWallMs:null,
    attemptsElapsedMs:attempts.reduce((n,a)=>n+(a.elapsedMs??0),0),unknownAttemptDurations:attempts.filter(a=>a.elapsedMs===undefined).length};
}
function history(attempts:Attempt[],declaredAt:string){
  const aliases=new Set(attempts.flatMap(a=>(a.aliases??[a.dir]).map(p=>resolve(p))));
  const legacyAttempts=attempts.filter(a=>a.legacy).length;
  const outsideScopePreviousRounds=attempts.filter(a=>a.previous&&!aliases.has(resolve(a.previous))).length;
  const startedBeforeDeclaration=attempts.filter(a=>a.startedAt&&Date.parse(a.startedAt)<Date.parse(declaredAt)).length;
  const unverifiableStarts=attempts.filter(a=>!Number.isFinite(Date.parse(a.startedAt??''))).length;
  return {complete:!(legacyAttempts||outsideScopePreviousRounds||startedBeforeDeclaration||unverifiableStarts),legacyAttempts,outsideScopePreviousRounds,startedBeforeDeclaration,unverifiableStarts};
}
function amount(attempts:Attempt[],pricing?:OrderPricing,complete=true){
  if(!pricing)return {value:null,reason:'pricing-unavailable'};
  const info={currency:pricing.currency,pricingIdentity:hash(pricing),basis:pricing.basis};
  if(!complete)return {...info,value:null,reason:'history-incomplete'};
  if(!attempts.length||attempts.some(a=>!a.record||a.usage?.usageSource==='messages'||a.record.runtime.endpoint!==pricing.endpoint||a.record.run.servedModel!==pricing.model||pricedMetrics.some(k=>a.usage?.[k]===undefined)))return {...info,value:null,reason:'usage-or-provider-unknown'};
  return {...info,value:attempts.reduce((sum,a)=>sum+pricedMetrics.reduce((n,k)=>n+a.usage![k]!*pricing.perMillion[k],0),0)/1_000_000};
}
export async function reportOrders(dir:string){
  const saved=await openScope(dir),files=await readdir(join(dir,'events')).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return [];throw e;});
  const events=await Promise.all(files.filter(f=>f.endsWith('.json')).sort().map(f=>optional<StoredEvent>(join(dir,'events',f))));
  for(const event of events){
    verifyEvent(event,saved.identity);
    if(event.input.kind!=='delivery'){
      const current=await bindHuman(saved.scope,event.input),old=event.binding as {round:string;original:string};
      if(current.round!==old.round||current.original!==old.original)throw new Error('人工事件的原始轮次已改变');
    }
  }
  const orders:OrderResult[]=[],all:Attempt[]=[],owners=new Map<string,string>();
  for(const order of saved.scope.orders){
    const attempts:Attempt[]=[];for(const plan of order.plans)attempts.push(...await collect(plan));
    for(const a of attempts){if(owners.has(a.id))throw new Error('同一尝试不能计入多个计划或订单');owners.set(a.id,order.id);all.push(a);}
    const deliveries:({delivery:string}&Awaited<ReturnType<typeof bindDelivery>>)[]=[];
    for(const event of events){if(event?.input.order!==order.id||event.input.kind!=='delivery')continue;const binding=await bindDelivery(saved.scope,event.input);
      if(!isDeepStrictEqual(binding,event.binding))throw new Error('订单交付来源已改变');
      const delivery=event.input.delivery;if(!deliveries.some(d=>d.delivery===delivery))deliveries.push({delivery,...binding});}
    const orderEvents=events.filter((e):e is StoredEvent=>e?.input.order===order.id);
    const labor=laborTotals(order.plans,orderEvents);
    const commits=[...new Set(attempts.flatMap(a=>a.view?.applied?[a.view.applied.commitId??hash(a.view.applied)]:[]))];
    const succeeded=order.plans.every(p=>attempts.some(a=>a.plan===p.id&&a.view?.applied))&&order.deliveries.every(d=>deliveries.some(e=>e.delivery===d.id));
    const coverage=history(attempts,saved.declaredAt),assessment=quality(order.plans,attempts,orderEvents);
    if(!coverage.complete)assessment.agentFirstSuccess=false;
    orders.push({events:orderEvents,history:coverage,totals:totals(attempts),timing:timing(attempts),id:order.id,labor,quality:assessment,status:!attempts.length?'not-run':succeeded?'delivered':'incomplete',attempts:attempts.map(a=>({evidence:evidence(a),elapsedMs:a.elapsedMs,startedAt:a.startedAt,endedAt:a.endedAt,attemptId:a.attemptId,experiment:a.experiment,id:a.id,plan:a.plan,dir:a.dir,usage:a.usage,original:a.original,originalIdentity:a.originalIdentity,execution:a.execution,previous:a.previous,checkpoint:a.record?.inputs.previous?.checkpoint})),commits,deliveries});
  }
  const successfulOrders=orders.filter(o=>o.status==='delivered').length;
  const total={...totals(all),labor:Object.fromEntries(laborKinds.map(key=>[key,{knownMinutes:orders.reduce((n,o)=>n+o.labor[key]!.knownMinutes,0),unknownPlans:orders.reduce((n,o)=>n+o.labor[key]!.unknownPlans,0)}]))};
  const invalid=(a:Attempt)=>a.record?.run.stopped?.reason==='hardQuota'||classifyError(a.error??'')!=='other';
  const invalidAttempts=all.filter(invalid).length;
  const unknownAttempts=all.filter(a=>!a.record&&!invalid(a)).length;
  const finished=events.filter(e=>e?.input.kind==='delivery').map(e=>Date.parse(e!.at));
  const coverage=history(all,saved.declaredAt);
  return {format:'renderweave-order-report/1',scopeIdentity:saved.identity,scope:saved.scope,declaredAt:saved.declaredAt,history:coverage,
    model:{validAttempts:all.length-invalidAttempts-unknownAttempts,invalidAttempts,unknownAttempts},
    timing:{...timing(all),actualWallMs:orders.length===successfulOrders&&finished.length?Math.max(...finished)-Date.parse(saved.declaredAt):null},counts:{orders:orders.length,plans:saved.scope.orders.reduce((n,o)=>n+o.plans.length,0),attempts:all.length,successfulOrders},orders,totals:total,
    costPerSuccessfulOrder:successfulOrders?{usageComplete:coverage.complete&&metrics.every(key=>total.usage[key]!.unknownAttempts===0),labor:{knownMinutes:orders.reduce((n,o)=>n+laborKinds.reduce((s,k)=>s+o.labor[k]!.knownMinutes,0),0)/successfulOrders,complete:coverage.complete&&orders.every(o=>laborKinds.every(k=>o.labor[k]!.unknownPlans===0))},usage:Object.fromEntries(metrics.map(key=>[key,total.usage[key]!.known/successfulOrders]))}:null,amount:amount(all,saved.scope.pricing,coverage.complete)};
}
/** 白名单摘要；不复制错误原文、提示词、客户备注或目录，不是完整复现包。 */
export async function shareOrders(dir:string){
  const report=await reportOrders(dir);
  return {format:'renderweave-order-share/1',reproductionBundle:false,scopeIdentity:report.scopeIdentity,counts:report.counts,history:report.history,model:report.model,timing:report.timing,totals:report.totals,costPerSuccessfulOrder:report.costPerSuccessfulOrder,amount:report.amount,
    orders:report.orders.map(order=>({id:hash(order.id),status:order.status,history:order.history,labor:order.labor,totals:order.totals,timing:order.timing,
      quality:{original:order.quality.original,corrected:order.quality.corrected,agentFirstSuccess:order.quality.agentFirstSuccess},
      attempts:order.attempts.map(attempt=>({id:hash(attempt.id),plan:hash(attempt.plan),original:attempt.original,originalIdentity:attempt.originalIdentity,reviewIdentity:attempt.evidence.reviewIdentity,recordIdentity:attempt.evidence.recordIdentity,execution:attempt.execution??null,stopped:attempt.usage?.stopped?.reason??null,usageSource:attempt.usage?.usageSource??null,
        usage:Object.fromEntries(metrics.map(key=>[key,attempt.usage?.[key]??null])),diagnostic:classifyError(attempt.usage?.error??'') })),
      commits:order.commits.map(hash),deliveries:order.deliveries.map(d=>({delivery:hash(d.delivery),round:hash(d.round),commit:hash(d.commit),contentIdentity:d.contentIdentity,record:d.record}))}))};
}

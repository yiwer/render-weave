/** 公开候选冻结命令；只复制本地事实，不调用模型。 */
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {bindCandidate,freezeCandidate,verifyCandidate} from './candidate.js';
import type {RuntimeOptions} from './eval.js';
const {values}=parseArgs({options:{out:{type:'string'},verify:{type:'string'},current:{type:'boolean'},bind:{type:'string'},config:{type:'string'},scenarios:{type:'string'},repeat:{type:'string'},jobs:{type:'string'},paired:{type:'boolean'},model:{type:'string'},'small-model':{type:'string'},endpoint:{type:'string'},effort:{type:'string'},'max-turns':{type:'string'},'timeout-ms':{type:'string'},'stagnation-threshold':{type:'string'},'context-policy':{type:'string'},claude:{type:'string'},'claude-args':{type:'string'},'previous-binding':{type:'string'}},strict:true});
try{
  if(values.bind){
    if(!values.out||!values.config||values.verify||values.current)throw new Error('--bind 需要 --config 和 --out，不能混用校验');
    const positive=(value:string|undefined)=>{if(value===undefined)return undefined;const number=Number(value);if(!Number.isSafeInteger(number)||number<1)throw new Error('次数、并行数和预算必须是正整数');return number;};
    const args:unknown=values['claude-args']===undefined?undefined:JSON.parse(values['claude-args']);
    if(args!==undefined&&(!values.claude||!Array.isArray(args)||!args.every(value=>typeof value==='string')))throw new Error('claude-args 必须与 claude 一起提供字符串数组');
    if(values.effort&&!['low','medium','high','xhigh','max'].includes(values.effort))throw new Error('无效 effort');
    const runtime:RuntimeOptions={model:values.model,smallModel:values['small-model'],endpoint:values.endpoint,effort:values.effort,
      maxTurns:positive(values['max-turns']),roundTimeoutMs:positive(values['timeout-ms']),stagnationThreshold:positive(values['stagnation-threshold']),contextPolicy:values['context-policy'] as RuntimeOptions['contextPolicy'],
      ...(values.claude?{claude:{command:values.claude,args:args as string[]|undefined}}:{})};
    const binding=await bindCandidate({candidate:resolve(values.bind),config:resolve(values.config),out:resolve(values.out),scenarios:values.scenarios,repeat:positive(values.repeat),pairedJobs:values.paired?positive(values.jobs)??3:null,runtime,previousBinding:values['previous-binding']?resolve(values['previous-binding']):undefined});
    console.log(JSON.stringify({binding:binding.id,candidate:binding.candidate.id,units:binding.units,realModelObservations:0}));
  }else{
  if(values['previous-binding'])throw new Error('--previous-binding 只用于新计划绑定');
  if(values.out&&values.verify||!values.verify&&values.current)throw new Error('--verify 与 --out 互斥，--current 只用于校验');
  if(!values.out&&!values.verify)throw new Error('需要 --out <新候选目录> 或 --verify <候选目录>');
  const candidate=values.verify?await verifyCandidate(values.verify,values.current):await freezeCandidate(values.out!);
  console.log(JSON.stringify({candidate:candidate.id,realModelObservations:0}));
  }
}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=2;}

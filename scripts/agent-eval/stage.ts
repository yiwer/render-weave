/** 核准材料与人工审核工作流的逐阶段绑定/预检；派发仅调用一次现有 Agent CLI。 */
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {bindStage,dispatchStage,verifyStage} from './candidate-stage.js';
const {values}=parseArgs({options:{bind:{type:'string'},request:{type:'string'},out:{type:'string'},verify:{type:'string'},dispatch:{type:'string'},'key-env':{type:'string'}},strict:true});
try{
  if([values.bind,values.verify,values.dispatch].filter(Boolean).length!==1)throw new Error('选择 --bind、--verify 或 --dispatch');
  if(values.bind){
    if(!values.request||!values.out||values['key-env'])throw new Error('--bind 需要 --request 与 --out，不读取凭据');
    const binding=await bindStage(resolve(values.bind),resolve(values.request),resolve(values.out));
    console.log(JSON.stringify({candidate:binding.candidate.id,binding:binding.id,unit:binding.unit,realModelObservations:0}));
  }else{
    if(values.request||values.out||values.verify&&values['key-env'])throw new Error('预检或派发只读取既有阶段绑定');
    if(values.dispatch)process.exitCode=await dispatchStage(resolve(values.dispatch),values['key-env']??'OPEN_CODE_API_KEY');
    else{const {binding}=await verifyStage(resolve(values.verify!));console.log(JSON.stringify({candidate:binding.candidate.id,binding:binding.id,unit:binding.unit,realModelObservations:0}));}
  }
}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=2;}

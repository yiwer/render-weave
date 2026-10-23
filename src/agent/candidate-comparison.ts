/** 完整检查的保守逐项关系；不把候选哈希、总分或作者自述当作质量改善。 */
import { canonical } from './diff.js';
import type { CheckpointRecord } from './checkpoints.js';

export type ComparisonBasis = Readonly<Record<'task'|'workspace'|'resources'|'request'|'reference'|'policy'|'criteria',string>>;
export interface CandidateChange { readonly dimension:string; readonly item:string; readonly before:number|null; readonly after:number|null }
export interface CandidateComparison {
  readonly status:'uncompared'|'improved'|'regressed'|'incomparable'|'unchanged';
  readonly from?:string; readonly to:string; readonly reasons:readonly string[];
  readonly improved:readonly CandidateChange[]; readonly regressed:readonly CandidateChange[]; readonly unknownAdded:readonly string[];
}
export function compareCandidates(before:CheckpointRecord|undefined,after:CheckpointRecord):CandidateComparison {
  const result={...(before?{from:before.id}:{}),to:after.id,improved:[] as CandidateChange[],regressed:[] as CandidateChange[],unknownAdded:[] as string[]};
  if(!before)return {...result,status:'uncompared',reasons:['首次完整候选只作比较起点，尚无较好证据']};
  if(!before.comparisonBasis||!after.comparisonBasis)return {...result,status:'incomparable',reasons:['缺少可核对的比较依据']};
  const changed=Object.keys(after.comparisonBasis).filter(key=>before.comparisonBasis![key as keyof ComparisonBasis]!==after.comparisonBasis![key as keyof ComparisonBasis]);
  if(changed.length)return {...result,status:'incomparable',reasons:changed.map(key=>`比较依据不同：${key}`)};
  const old=before.check.coverageVerification,next=after.check.coverageVerification;
  if(!old||!next||old.status==='notChecked'||next.status==='notChecked')return {...result,status:'incomparable',reasons:['没有可信的已核准测量，不能排序']};
  const compareSet=(dimension:string,oldItems:readonly string[],newItems:readonly string[])=>{
    for(const item of new Set([...oldItems,...newItems])){
      const prior=Number(oldItems.includes(item)),current=Number(newItems.includes(item));
      if(prior!==current)(current<prior?result.improved:result.regressed).push({dimension,item,before:prior,after:current});
    }
  };
  compareSet('coverage.missing',old.missingItems,next.missingItems);
  const anomalies=(value:typeof old)=>value.anomalies.map(item=>canonical({code:item.code,item:item.item,path:item.path??null,level:item.level}));
  compareSet('coverage.anomaly',anomalies(old),anomalies(next));
  result.unknownAdded.push(...next.unknownItems.filter(item=>!old.unknownItems.includes(item)).map(item=>`coverage:${item}`));
  const technical=after.check.assessment;
  const blocked=technical.structure!=='valid'||technical.candidates!=='valid'||technical.render.status==='blocked';
  const reasons=[...(blocked?['新候选未保持技术硬约束或授权修改范围']:[]),...(result.unknownAdded.length?['未知范围增加，不能用错误转未知证明改善']:[])];
  if(blocked||result.unknownAdded.length||(result.improved.length&&result.regressed.length))return {...result,status:'incomparable',reasons:[...reasons,...(result.improved.length&&result.regressed.length?['维度互有得失，不能相互抵消']:[])]};
  return {...result,status:result.regressed.length?'regressed':result.improved.length?'improved':'unchanged',reasons:result.regressed.length?['存在逐项退步']:result.improved.length?['核准指标改善且其余已核查维度未退步']:['没有可证明的改善']};
}

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
  const old=observations(before),next=observations(after);
  if(!old.trusted||!next.trusted)return {...result,status:'incomparable',reasons:['没有可信的已核准测量，不能排序']};
  for(const key of new Set([...old.metrics.keys(),...next.metrics.keys()])){
    const prior=old.metrics.get(key)?.value??0,current=next.metrics.get(key)?.value??0;
    const {dimension,item}=next.metrics.get(key)??old.metrics.get(key)!;
    if(Math.abs(prior-current)>1e-9)(current<prior?result.improved:result.regressed).push({dimension,item,before:prior,after:current});
  }
  result.unknownAdded.push(...[...next.unknown].filter(item=>!old.unknown.has(item)));
  const technical=after.check.assessment;
  const blocked=technical.structure!=='valid'||technical.candidates!=='valid'||technical.render.status==='blocked';
  const reasons=[...(blocked?['新候选未保持技术硬约束或授权修改范围']:[]),...(result.unknownAdded.length?['未知范围增加，不能用错误转未知证明改善']:[])];
  if(blocked||result.unknownAdded.length||(result.improved.length&&result.regressed.length))return {...result,status:'incomparable',reasons:[...reasons,...(result.improved.length&&result.regressed.length?['维度互有得失，不能相互抵消']:[])]};
  return {...result,status:result.regressed.length?'regressed':result.improved.length?'improved':'unchanged',reasons:result.regressed.length?['存在逐项退步']:result.improved.length?['核准指标改善且其余已核查维度未退步']:['没有可证明的改善']};
}

function observations(record:CheckpointRecord){
  const metrics=new Map<string,{dimension:string;item:string;value:number}>(),unknown=new Set<string>();
  let trusted=false;
  const add=(dimension:string,item:string,value:number)=>metrics.set(canonical([dimension,item]),{dimension,item,value});
  for(const pending of record.check.submission?.pending??[])unknown.add(`pending:${canonical({file:pending.file,path:pending.path??null,reason:pending.reason})}`);
  const coverage=record.check.coverageVerification;
  if(coverage&&coverage.status!=='notChecked'){
    trusted=true;
    for(const item of coverage.missingItems)add('coverage.missing',item,1);
    for(const anomaly of coverage.anomalies)add('coverage.anomaly',canonical({code:anomaly.code,item:anomaly.item,path:anomaly.path??null,level:anomaly.level}),1);
    for(const item of coverage.unknownItems)unknown.add(`coverage:${item}`);
  }
  const style=record.check.styleVerification,reference=record.comparisonReference;
  if(style&&reference&&style.valid&&style.status!=='notChecked'){
    trusted ||= reference.approvedRegions.some(region=>region.boxKind||region.expectedFontSizeMm!==undefined||region.expectedText!==undefined||region.expectedColor||region.expectedImageSha256);
    for(const anomaly of style.anomalies)if(!['fontSizeTooSmall','fontSizeTooLarge','sizeDeviation','positionDeviation'].includes(anomaly.kind))add('style.anomaly',canonical({kind:anomaly.kind,region:anomaly.regionId,path:anomaly.path}),1);
    for(const region of style.regions){
      const approved=reference.approvedRegions.find(item=>item.id===region.id);
      if(!approved){unknown.add(`style:${region.id}:未找到核准区域`);continue;}
      if(!region.instances.length&&(region.status==='ambiguous'||region.status==='unknown'))unknown.add(`style:${region.id}:${region.status}`);
      const penalty=(ratio:number)=>ratio<(approved.toleranceRatio?.min??0.8)||ratio>(approved.toleranceRatio?.max??1.2)?Math.abs(ratio-1):0;
      for(const instance of region.instances){
        const item=`${region.id}:${instance.path}`;
        for(const reason of instance.unknown)unknown.add(`${item}:${reason}`);
        if(approved.expectedFontSizeMm!==undefined){
          const errors=(instance.fontSizesMm??[]).map(size=>penalty(size/approved.expectedFontSizeMm!)).sort((a,b)=>b-a);
          errors.forEach((value,index)=>add('style.fontSize',`${item}:${index}`,value));
        }
        if(approved.boxKind&&instance.sizeRatio)for(const axis of ['width','height'] as const)add('style.size',`${item}:${axis}`,penalty(instance.sizeRatio[axis]));
        if(approved.boxKind&&!approved.repeat&&instance.deltaMm)for(const axis of ['x','y'] as const){
          const delta=Math.abs(instance.deltaMm[axis]);add('style.position',`${item}:${axis}`,delta>(approved.positionToleranceMm??1)?delta:0);
        }
      }
    }
  }else if(reference?.approvedRegions.length)unknown.add('style:核准区域尚未测量');
  return {metrics,unknown,trusted};
}

/** 分页只消费已完成检查的冻结结果，不触碰候选，不产生新的检查或修复机会。 */
import {randomUUID, createHash} from 'node:crypto';
import type {OutcomeCheck} from '../agent/outcome.js';
import type {Problem} from '../problems.js';
import {ToolInputError} from './files.js';

interface FeedbackItem {readonly code:string;readonly target:string;readonly unknown:boolean;readonly detail:unknown}
export function outcomeFeedback(check:OutcomeCheck, display:(problem:Problem)=>Problem) {
  const reportId=randomUUID(), items:FeedbackItem[]=[];
  const add=(code:string,target:string,detail:unknown,unknown=false)=>items.push({code,target,detail,unknown});
  const problem=(value:Problem,file='')=>{const shown=display(value);add(shown.code,file||JSON.stringify(shown.location),shown);};
  check.problems.forEach(value=>problem(value));check.assessment.render.problems.forEach(value=>problem(value));
  for(const candidate of check.candidates){
    const {problems: _problems, deferred: _deferred, revision: _revision, sha256: _sha256, ...metadata} = candidate;
    add('candidate', candidate.path, metadata);
    candidate.problems.forEach(value=>problem(value,candidate.path));
    candidate.deferred?.forEach(value=>add(`deferred.${value.code}`,candidate.path,display(value),true));
    candidate.revision?.changes.forEach(value=>add('revision.change',candidate.path,{file:candidate.path,...value}));
  }
  const coverage=check.coverageVerification??check.assessment.coverage;
  coverage?.anomalies.forEach(value=>add(`coverage.${value.code}`,value.item,value));
  coverage?.missingItems.forEach(id=>add('coverage.missing',id,{id}));
  coverage?.unknownItems.forEach(id=>add('coverage.unknown',id,{id},true));
  for(const value of check.styleVerification?.anomalies??check.assessment.style?.anomalies??[]){
    const region=check.styleVerification?.regions.find(region=>region.id===value.regionId);
    add(`style.${value.kind}`,value.regionId,{...value,instances:region?.instances});
  }
  for(const region of check.styleVerification?.regions??[]){
    if(region.status!=='measured'||region.instances.some(instance=>instance.unknown.length))add('style.unknown',region.id,region,true);
  }
  check.submission?.pending.forEach(value=>add('pending',value.file,value,true));
  // 单条超长诊断也可无损续取，fragment 是原条目的 JSON 字符片段；按 itemId/index 拼接后 JSON.parse。
  const pages=items.flatMap((item,index)=>{
    const text=JSON.stringify(item);
    if(text.length<=5000)return [item];
    const total=Math.ceil(text.length/4000),short=(value:string)=>value.length<=160?value:value.slice(0,120)+'#'+createHash('sha256').update(value).digest('hex').slice(0,16);
    return Array.from({length:total},(_,part)=>({code:short(item.code),target:short(item.target),unknown:item.unknown,detail:{itemId:index,index:part,total,encoding:'json',fragment:text.slice(part*4000,(part+1)*4000)}}));
  });
  const metadata={tool:'outcome_feedback',reportId,total:pages.length,issueTotal:items.length,unknownTotal:items.filter(item=>item.unknown).length};
  return {
    metadata,
    page(args:Record<string,unknown>){
      if(args['reportId']!==reportId)throw new ToolInputError('检查报告不存在或已过期；先调用 check_outcome，并使用它返回的 reportId');
      const offset=Number(args['offset']??0),limit=Number(args['limit']??30),groupBy=args['groupBy']==='target'?'target':'code';
      if(offset>pages.length)throw new ToolInputError('offset 超过检查报告总条数');
      const ordered=[...pages].sort((a,b)=>a[groupBy].localeCompare(b[groupBy]));
      const selected:FeedbackItem[]=[];let chars=0;
      for(const item of ordered.slice(offset,offset+limit)) {const size=JSON.stringify(item).length;if(chars+size>22000)break;selected.push(item);chars+=size;}
      const groups=[...new Set(selected.map(item=>item[groupBy]))].map(key=>({key,total:ordered.filter(item=>item[groupBy]===key).length,items:selected.filter(item=>item[groupBy]===key)}));
      const next=offset+selected.length;
      return {reportId,contentIdentity:check.contentIdentity?.id??null,currentBytesChecked:false,verdict:check.verdict,
        structure:check.assessment.structure,candidates:check.assessment.candidates,content:check.assessment.content,
        renderStatus:check.assessment.render.status,capabilityBlocked:check.assessment.render.capabilityBlocked,
        coverageStatus:coverage?.status??'notChecked',visualStatus:check.styleVerification?.status??'notChecked',
        total:pages.length,issueTotal:items.length,unknownTotal:metadata.unknownTotal,groupBy,offset,groups,
        truncated:next<pages.length,nextOffset:next<pages.length?next:null,
        continuation:'使用相同 reportId、groupBy 与 nextOffset 继续；修改后必须重新 check_outcome。fragment 按 itemId/index 拼接后 JSON.parse，不得遗漏未知项或后续页。'};
    }
  };
}

/**
 * 留出准备专用：固定已有操作者素材与独立事实，生成订单/核准材料并做离线公开入口核查。
 * 不调用远端模型，不批准业务结果，不生成新的评估或通用记录协议。
 * node --import tsx scripts/agent-eval/prepare-holdout.mjs --out <新目录> --resources fixtures/resources
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, cp, readdir} from 'node:fs/promises';
import {dirname, join, resolve, relative} from 'node:path';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {
  initializeResourceStore, importResources, publishStaticSchema, runAgentTask,
  initializeOrderScope, reportOrders, readReview, checkDslDocument,
} from '../../src/index.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const {values} = parseArgs({options:{
  out:{type:'string'}, resources:{type:'string'}, source:{type:'string'},
},strict:true});
if(!values.out || !values.resources) throw new Error('需要 --out 新目录与 --resources 原始资源仓库');
const out=resolve(values.out);
const source=resolve(values.source ?? 'D:/我的图片/sample');
const packageDir=join(repo,'.scratch/agent-harness-hardening/holdout');
const proposal=JSON.parse(await readFile(join(packageDir,'case-proposal.json'),'utf8'));
const observations=JSON.parse(await readFile(join(packageDir,'source-observations.json'),'utf8')).observations;
assert.equal(proposal.cases.length,12);
assert.equal(proposal.cases.filter(c=>c.flow==='full').length,10);
assert.equal(proposal.cases.filter(c=>c.flow==='revision').length,2);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const save=async(file,value)=>{await mkdir(dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx'});};
const write=async(file,text)=>{await mkdir(dirname(file),{recursive:true});await writeFile(file,text,{flag:'wx'});};

// 源文件先核对，任何缺失/换图立即拒绝；mkdir拒绝覆盖既有准备或观测。
for(const c of proposal.cases){
  const known=observations.find(x=>x.id===c.id),bytes=await readFile(join(source,c.file));
  assert.equal(hash(bytes),known.sha256,'素材字节变化：'+c.id);
  assert.equal(bytes.readUInt32BE(16),known.width);
  assert.equal(bytes.readUInt32BE(20),known.height);
}
await mkdir(out);
await cp(packageDir,join(out,'proposal'),{recursive:true});
await cp(join(packageDir,'../holdout-candidates.md'),join(out,'holdout-candidates.md'));
const resources=join(out,'resources');
assert.deepEqual((await initializeResourceStore(resources)).problems,[]);
assert.deepEqual((await importResources({sourceDir:resolve(values.resources),dir:resources})).problems,[]);

const budgets={
  model:'claude-haiku-5-5',smallModel:'claude-haiku-5-5',effort:'existing-default',contextPolicy:'bind-ticket-20-default',
  maxTurns:{'definition-extraction':40,'dataset-extraction':40,'template-design':80,'template-revision':80},
  timeoutMs:3_600_000,saveGraceMs:30_000,
  modelFailure:'保留首次有效失败；不以覆盖重跑替换。后续人工修正/接续另记，不改变首次能力。',
  transient:'每阶段最多额外2次；60秒、180秒；全部尝试保留，连续失败记invalid。',
  quota:'立即停止后续派发；未跑保持not-run，不自动等待、不换模型绕过；恢复必须仍为同一冻结身份。',
  missing:'没有实际产物、用量或人工分钟时保持unknown；不填0、不借其他案例结果。',
};
await save(join(out,'budget-policy.json'),budgets);
const cases=[],orders=[],units=[],reviewForms=[];
for(const c of proposal.cases){
  const observed=observations.find(x=>x.id===c.id),dir=join(out,'cases',c.id);
  await mkdir(dir,{recursive:true});
  const name='holdout-'+c.id,dataset='ds-'+name;
  const region = (id,expected,box,state='normal',repeat=false) => ({
    id,name:id,sampleRegion:box,
    ...(id==='route-number'||id.startsWith('board-stop-name')?{targetPathPattern:'*/'+id}:{targetText:expected}),
    expectedText:expected,state,...(repeat?{repeat:true}:{}),
  });
  let approvedRegions;
  if(c.regions==='pixel-observations'){
    approvedRegions=['chinese','english'].map((language,index)=>{
      const box=observed.regions[language],id=index===0?'stop-name-zh':'stop-name-en';
      return {id,name:index===0?'中文站名':'英文站名',
        sampleRegion:{x:box.left,y:box.top,width:box.right-box.left+1,height:box.bottom-box.top+1},
        targetPathPattern:'*/'+id,expectedText:c.facts[index===0?'stopNameZh':'stopNameEn'],
        expectedColor:'#FFFFFF',state:index===0&&c.id==='stop-name-03'?'longestText':'normal',
      };
    });
  }else{
    approvedRegions=c.regions.map(([id,text,roi,state,repeat])=>region(id,text,{
      x:Math.round(roi[0]*c.regionScale),y:Math.round(roi[1]*c.regionScale),
      width:Math.round(roi[2]*c.regionScale),height:Math.round(roi[3]*c.regionScale),
    },state,repeat));
  }
  const reference={
    sampleWidthPx:observed.width,sampleHeightPx:observed.height,
    artboardWidthMm:c.size[0],artboardHeightMm:c.size[1],
    ...(c.boardRegion?{boardRegion:c.boardRegion}:{}),
    sampleSha256:observed.sha256,complete:false,approvedRegions,
  };
  const unknown={id:'manual-full-content-style',label:'完整站序/道路/图标归属/样式与未量化维度需独立逐项审核，自动子集不产生整体结论'};
  const definitionBaseline={name:c.id+'-definition',items:[
    ...Object.keys(c.facts).map(field=>({id:field,label:field,definition:name,field})),unknown,
  ]};
  const datasetBaseline={name:c.id+'-dataset',items:[
    ...Object.entries(c.facts).map(([field,value])=>({id:field,label:field,values:[{path:field,value}]})),unknown,
  ]};
  const request={template:name,dataset:{id:dataset},parameters:{},mode:'final',
    output:{width:c.size[0],height:c.size[1],dpi:120,format:'png'}};
  await save(join(dir,'definition-baseline.json'),definitionBaseline);
  await save(join(dir,'dataset-baseline.json'),datasetBaseline);
  await save(join(dir,'reference.json'),reference);
  assert.deepEqual(checkDslDocument(request).problems,[]);
  await save(join(dir,'request.json'),request);
  const batch={template:request.template,mode:'final',items:[{
    id:'image',dataset:request.dataset,parameters:request.parameters,output:request.output,
  }]};
  assert.deepEqual(checkDslDocument(batch).problems,[]);
  await save(join(dir,'batch-request.json'),batch);
  await save(join(dir,'truth-checklist.json'),{
    id:c.id,source:join(source,c.file),sourceSha256:observed.sha256,
    approval:'pending-user',machineFacts:c.facts,manualChecks:c.manual,
    originalImageIsTruth:true,automaticCoverage:'partial',unknown:['原始字体/字号','二维码目标与未取得的独立资源字节','未量化感知样式/细部遮挡'],
    criticalErrors:['错/漏站或改变停靠顺序','线路/方向/票价/时刻错误','本站/过站/后续状态混淆','圈号/图标错绑','未经核准编造文字或二维码内容','修改任务越出预登记范围'],
    errorTolerance:'必要业务事实无已知错误；不可辨识项明确pending/unknown并阻止声称整体业务通过。任何豁免须派发前核准，结果后不放宽。',
  });
  const fieldLabels=Object.keys(c.facts).join('、');
  await write(join(dir,'brief.md'),[
    '# 留出案例 '+c.id,
    '从原始素材完成本例任务。此为独立业务评估，不允许读取其他案例答案、前次重复或核准文件。',
    '主数据定义名称固定为 '+name+'，主模板名称同名；数据集ID固定为 '+dataset+'。可另建所需被引用的数据定义。',
    '为独立核查保留以下主字段名：'+fieldLabels+'。显示名称用中文；其他字段按素材业务提取，未知不编造。',
    'routeNo保存线路编号，不含单位后缀“路”；显示时按原图表达，字段值与显示文案分别核查。',
    '线路牌应分别提取双向/各线路停靠序列，道路、附属标识与每次停靠绑定；重复站不去重。使用已有领域规则，不把终点或本站无条件复制成线路数据。',
    '出图包含实际业务牌内全部内容。源图外生产文件注记与横版空白签审表不出图；空下一站和无法确定的二维码目标保持未知。',
    '文字、列表、状态与样式用真实DSL表达；不得将整张原图作为图片覆盖充当模板。',
    '文字元素的稳定名称：线路号用route-number，整站牌中英文主标题用board-stop-name-zh/board-stop-name-en，独立站名牌用stop-name-zh/stop-name-en。站名文字和道路分成可单独核查的元素。',
    '参考仅覆盖部分事实。交回前检查实际成果；未核实维度保留unknown，不凭notes或零severe宣称全图通过。',
    '',
  ].join('\n'));
  cases.push({id:c.id,type:c.kind,flow:c.flow,family:c.family,entityGroup:c.entityGroup??c.id,
    independence:'regression-family-independence-unproven',sample:join(source,c.file),sampleSha256:observed.sha256,
    name,dataset,dir,request:join(dir,'request.json'),reference:join(dir,'reference.json'),
    definitionBaseline:join(dir,'definition-baseline.json'),datasetBaseline:join(dir,'dataset-baseline.json'),
    brief:join(dir,'brief.md'),budget:budgets,reviewer:'user',approval:'pending-user'});
  for(let repetition=1;repetition<=3;repetition++){
    const id=c.id+'-r'+repetition,root=join(out,'observations',id);
    const stages=c.flow==='full'?[
      ['definition','definition-extraction'],['dataset','dataset-extraction'],['template','template-design'],
    ]:[['revision','template-revision']];
    const plans=stages.map(([stage,task])=>({id:stage,task,root:join(root,stage)}));
    orders.push({id,plans,deliveries:[{id:'image',plan:plans.at(-1).id,request}]});
    units.push({id,case:c.id,repetition,type:c.kind,flow:c.flow,status:'not-run',
      order:id,root,stages:plans.map(p=>({id:p.id,task:p.task,root:p.root,maxTurns:budgets.maxTurns[p.task],timeoutMs:budgets.timeoutMs}))});
    reviewForms.push({unit:id,reviewer:'user',status:'not-reviewed',original:{
      content:null,stopOrder:null,style:null,states:null,scope:null,businessQuality:null,criticalFalsePass:null,automaticClaimedScope:null,
    },unknown:[],disagreements:[],resolution:null,
      minutes:{review:null,correction:null,rework:null},corrected:null,applied:null,formalOutput:null,
      evidence:{source:join(source,c.file),sourceSha256:observed.sha256,originalCandidate:null,originalImage:null,automaticReport:null,correctedCandidate:null,correctedImage:null}});
  }
}
await save(join(out,'cases.json'),cases);
await save(join(out,'units.json'),units);
await save(join(out,'review-forms.json'),reviewForms);
for(const type of ['landscape','vertical','board','stop-name']){
  const selected=units.filter(u=>u.type===type);assert.equal(selected.length,9);
  await save(join(out,'strata',type+'.json'),selected);
}
assert.equal(units.length,36);
await save(join(out,'orders.json'),{format:'renderweave-order-scope/1',id:'bus-holdout-v1',orders});

// 复用15公开订单入口核查计划；此登记只读冒烟，不是实际派发登记。
const preflightScope=join(out,'validation','order-register');
await mkdir(dirname(preflightScope),{recursive:true});
await initializeOrderScope(preflightScope,JSON.parse(await readFile(join(out,'orders.json'),'utf8')));
const initialReport=await reportOrders(preflightScope);
assert.deepEqual(initialReport.counts,{orders:36,plans:96,attempts:0,successfulOrders:0});
await save(join(out,'validation','order-report.json'),initialReport);

// 由另一个准备者手工给定数据绑定模板，非模型生成或此前重复答案。
const {prepareHoldoutSeeds}=await import('./prepare-holdout-seeds.ts');
const seedBindings=await prepareHoldoutSeeds({out:join(out,'revision-seeds'),resources});
await save(join(out,'seed-bindings.json'),seedBindings);

// 公开Agent入口读取每个内容/参考基准。受控空执行器不会联网或生成候选；输入只用于格式/哈希预检。
const executor=join(out,'validation','no-model.mjs');
await write(executor,"if(process.argv.includes('--version')) console.log('holdout-input-validation-no-model/1');\nprocess.exit(0);\n");
const inputChecks=[];
for(const c of cases){
  const facts=proposal.cases.find(x=>x.id===c.id).facts;
  const workspace=join(out,'validation',c.id,'workspace');
  await mkdir(workspace,{recursive:true});
  const schema={dslVersion:'renderweave-schema/1',name:c.name,displayName:'仅输入格式核查',fields:Object.keys(facts).map(name=>({name,displayName:name,type:'text'}))};
  const published=publishStaticSchema(schema,[]);
  assert.deepEqual(published.problems,[]);assert.ok(published.published);
  await save(join(workspace,'schema.json'),published.published.definition);
  await save(join(workspace,'compiled.json'),published.published.compiled);
  await save(join(workspace,'dataset.json'),{dataset:{id:c.dataset,name:'仅输入格式核查',staticSchema:{name:c.name,version:1},origin:{kind:'manual',note:'独立原图事实的格式预检，不传给全流程模型'}},data:facts});
  for(const [task,extra] of [
    ['definition-extraction',{contentBaseline:c.definitionBaseline}],
    ['dataset-extraction',{contentBaseline:c.datasetBaseline,workspace,definition:c.name}],
    ['template-design',{reference:c.reference,workspace,dataset:c.dataset,request:c.request}],
    ...seedBindings.cases.filter(seed=>seed.id===c.id).map(seed=>[
      'template-revision',{reference:c.reference,workspace:seed.workspace,dataset:c.dataset,request:c.request,requirement:seed.requirement},
    ]),
  ]){
    const round=join(out,'validation',c.id,task);
    const result=await runAgentTask({task,sample:c.sample,brief:c.brief,resources,out:round,...extra,
      key:'holdout-input-validation-no-network',keyEnv:'ISOLATED_HOLDOUT_PREFLIGHT',
      maxTurns:1,roundTimeoutMs:15_000,claude:{command:process.execPath,args:[executor]}});
    const review=await readReview(round);
    assert.ok(result.record.inputs.sample.sha256);
    assert.ok(result.record.inputs[task.startsWith('template-')?'reference':'contentBaseline']);
    assert.notEqual(result.check.verdict,'qualified');
    assert.deepEqual(result.check.problems.map(p=>p.code),['outcome.invalid']);
    assert.equal(result.record.runtime.roundTimeoutMs,15_000);
    if(task==='template-revision'){
      assert.deepEqual(review.problems,[]);
      assert.equal(review.view.round.source,'hostRecovery');
      assert.equal(review.view.round.verdict,'unqualified');
      assert.equal(review.view.canApprove,false);
    }else assert.deepEqual(review.problems.map(p=>p.code),['round.invalid']);
    inputChecks.push({case:c.id,task,inputsReadable:true,verdict:result.check.verdict,review:task==='template-revision'?'readable-unapprovable-recovery':'expected-no-outcome-refusal',modelCalls:0,round});
  }
}
await save(join(out,'validation','input-checks.json'),inputChecks);
await write(join(out,'contamination-log.md'),'# 污染记录\n\n准备阶段仅查看原始素材、量测区域、制作两例独立修改种子与空执行器格式预检；真实模型观测0，未查看被测Agent的留出结果，未据留出结果调整资料/策略。\n\n后续逐项追加日期、单元、查看者、用途、是否用于调整、降级范围。用于调优后整相关家族转校准/回归；事后重评分另存，不增加独立观测。\n');
await save(join(out,'candidate-binding.json'),{status:'pending-ticket-20',candidate:null,modelObservations:0,doNotDispatch:true});
await save(join(out,'approval.json'),{status:'pending-user',reviewer:'user',approvedAt:null,approvedManifest:null,
  sourceHistory:'用户确认原始素材未用于调优',familyIndependence:'unknown',authorization:'本文件不代表核准或业务结果通过'});
const mdLink=(label,file)=>'['+label+'](<'+file.replaceAll('\\','/')+'>)';
const reviewIndex=[
  '# 十二例留出材料核准',
  '',
  '待核准；实际模型观测0。12例×3次=36个完整业务单元；10例全流程、2例模板修改，共96个阶段计划。',
  '请核对以下原图事实、共用容错/未知政策、尺寸和两份修改种子。核准只固定测量依据，不代表模型结果通过。',
  '',
  mdLink('逐例业务事实、状态、容错与家族边界',join(out,'proposal','review-plan.md')),
  '',
  mdLink('执行及独立审核程序',join(out,'proposal','execution-guide.md')),
  '',
  '| 案例 | 原图 | 核准清单 | 参考区域 | 修改任务 |',
  '|---|---|---|---|---|',
  ...cases.map(c=>{
    const seed=seedBindings.cases.find(s=>s.id===c.id);
    return '| '+c.id+' | '+mdLink('原图',c.sample)+' | '+mdLink('事实与未知',join(c.dir,'truth-checklist.json'))+
      ' | '+mdLink('部分区域',c.reference)+' | '+(seed?
        mdLink('改前',seed.beforePreview)+' / '+mdLink('目标改后',seed.afterPreview)+' / '+mdLink('仅允许的修改',seed.requirement):'素材到正式出图')+' |';
  }),
  '',
  '横版尺寸700×315.56mm为本次评估约定，源图实际物理尺寸未知；其他尺寸据原图生产注记。区域框只用于部分内容诊断，未冒称原始字体/字号真值。',
  '无名站英文 This is English Name 为原图占位文字，保留原文；不推论真实译名或完整英文线路能力。模板家族独立性未证实，按回归报告。',
  '审核者为用户本人。后续看原始成果及实际图片，隐藏生成过程自评；缺失分钟与结论保持unknown。',
  '',
  mdLink('36单元清单',join(out,'units.json'))+' · '+mdLink('订单预登记',join(out,'orders.json'))+' · '+
  mdLink('预算和停止政策',join(out,'budget-policy.json'))+' · '+mdLink('独立审核记录表',join(out,'review-forms.json')),
  '',
  '本包仍须用户核准并绑定票据20的不可变候选；此时不可派发模型。实际登记使用独立order-register，validation目录只用于离线准备核查。',
  '',
];
await write(join(out,'REVIEW.md'),reviewIndex.join('\n'));
const inventory=[];
const visit=async dir=>{
  for(const entry of await readdir(dir,{withFileTypes:true})){
    if(['validation','observations','approval.json','candidate-binding.json','contamination-log.md'].includes(entry.name))continue;
    const file=join(dir,entry.name);
    if(entry.isDirectory())await visit(file);
    else inventory.push({file:relative(out,file).replaceAll('\\','/'),sha256:hash(await readFile(file))});
  }
};
await visit(out);
inventory.sort((a,b)=>a.file.localeCompare(b.file));
await save(join(out,'preparation-manifest.json'),{
  preparedAt:new Date().toISOString(),status:'pending-user-and-ticket-20',units:36,cases:12,fullFlowCases:10,revisionCases:2,
  stagePlans:96,modelObservations:0,publicInputChecks:inputChecks.length,source,resources,
  materials:inventory,preparationSha256:hash(JSON.stringify(inventory)),
  limits:['原图字节是独立真值；自动核查仅为部分锚点','未知字体/二维码语义/未量化样式需人工判断','家族独立性未证实，不推论价签或完整英文线路','用户核准后仍须绑定20确切候选再派发'],
});
console.log('留出准备完成：12例、36单元、96阶段计划；'+inputChecks.length+'次无模型输入预检；待用户核准和20绑定。'+out);

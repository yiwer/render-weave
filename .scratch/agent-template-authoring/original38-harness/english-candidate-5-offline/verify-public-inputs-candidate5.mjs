// 只读准备包检查；公共产品入口，不调用Agent/模型，不批准或应用任何成果。
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname,resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {checkDslDocument,compileStaticSchema,loadWorkspace,checkDataset,parseRenderRequest,render,compareReference} from 'file:///F:/GenCode/render-weave/out/harness-acceptance-20/candidate-5/content/dist/index.js';
const root="F:/GenCode/render-weave/out/harness-original38-english-tfl161-preparation-02";
const read=async p=>JSON.parse(await readFile(join(root,p),'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const verifyManifest=async name=>{const manifest=await read(name);for(const entry of manifest.files){const path=resolve(root,entry.path);assert.ok(path.startsWith(root+'/')||path.startsWith(root+'\\'));const bytes=await readFile(path);assert.equal(bytes.length,entry.bytes);assert.equal(hash(bytes),entry.sha256,entry.path);}return manifest.files.length;};
const packageFiles=await verifyManifest('package-manifest.json');
const inputFiles=await verifyManifest('input-manifest.json');
const defs=await Promise.all(['key-point.schema.json','route-panel.schema.json'].map(p=>read('manual-input/workspace/'+p)));
const entries=defs.map(definition=>({ref:{name:definition.name,version:definition.version},definition}));
for(const entry of entries){assert.deepEqual(checkDslDocument(entry.definition).problems,[]);const actual=compileStaticSchema(entry,entries);assert.deepEqual(actual.problems,[]);assert.deepEqual(actual.compiled,await read('manual-input/workspace/'+entry.ref.name+'.compiled.json'));}
const workspace=await loadWorkspace({dir:join(root,'manual-input/workspace'),resourcesDir:join(root,'manual-input/resources')});assert.deepEqual(workspace.problems,[]);assert.equal(workspace.templates.length,0);
const checked=checkDataset(await readFile(join(root,'manual-input/workspace/dataset.json')),workspace);assert.deepEqual(checked.problems,[]);
const data=checked.dataset.data;assert.equal(data.keyPoints.length,14);assert.equal(data.keyPoints.filter(p=>p.minutes!==undefined).length,10);assert.equal(data.keyPoints.reduce((n,p)=>n+(p.symbols?.length??0),0),9);assert.equal(data.actualCurrentStopName,undefined);
const resources=workspace.resources.list();assert.equal(resources.length,9);for(const resource of resources)await workspace.resources.read(resource.id);
const request=await read('manual-input/request.json');assert.deepEqual(parseRenderRequest(request).problems,[]);
const reference=await read('manual-input/reference.json');assert.equal(reference.approvedRegions.length,39);assert.equal(new Set(reference.approvedRegions.map(r=>r.id)).size,39);assert.ok(reference.approvedRegions.every(r=>r.expectedFontSizeMm===undefined));
const measures=await read('measurement/measurements.json');for(const region of reference.approvedRegions){assert.deepEqual(region.sampleRegion,measures.find(m=>m.id===region.id).inkBoundsPx);}
const probe=await read('validation/resource-probe.template.json');assert.equal(probe.artboard.minFontSize,2);assert.deepEqual(checkDslDocument(probe).problems,[]);
const probeWorkspace={...workspace,templates:[{name:probe.name,document:probe}]};const image=await render(probeWorkspace,{...request,mode:'draft'},{comparisonEvidence:true});assert.deepEqual(image.problems,[]);assert.ok(image.image);
const comparison=await compareReference({workspace:probeWorkspace,request,baseline:reference,sample:{path:join(root,'render/page-13-200dpi.png'),sha256:reference.sampleSha256},includeImages:false});assert.equal(comparison.report.coverage.approvedRegionsTotal,39);assert.equal(comparison.report.coverage.approvedRegionsMatched,0);assert.equal(comparison.report.anomalies.filter(a=>a.kind==='missingRegion').length,39);
const approval=await read('approval.json'),plan=await read('scope-and-plan.json'),review=await read('review/independent-review.blank.json'),preparation=await read('stage-request.design.preparation.json'),stage=preparation.request;
assert.equal(preparation.format,'original38-stage-request-preparation/1');assert.equal(stage.format,'renderweave-stage-request/1');assert.equal(preparation.candidateId,null);assert.equal(preparation.bindingId,null);assert.equal(preparation.promotion.approvalRecord,null);
assert.equal(approval.status,'pending-user');assert.equal(approval.approved,null);assert.ok(plan.doNotDispatch&&preparation.doNotDispatch&&approval.doNotDispatch);assert.equal(plan.candidateId,null);assert.equal(plan.bindingId,null);assert.equal(plan.realModelObservations,0);
assert.equal(review.items.length,39);assert.ok(review.items.every(r=>r.firstConclusion===null&&r.correctedConclusion===null&&r.reviewMinutes===null));assert.equal(review.humanReviewMinutes,null);
assert.equal('sha256:'+hash(await readFile(stage.materials[0].file)),stage.materials[0].sha256);assert.match(stage.materials[0].sha256,/^sha256:[a-f0-9]{64}$/);
const executor=await read('validation/native-executor-preparation.json');assert.equal(stage.args[stage.args.indexOf('--claude')+1],executor.path);assert.equal('sha256:'+hash(await readFile(executor.path)),executor.sha256);assert.equal(stage.args[stage.args.indexOf('--max-turns')+1],'80');assert.equal(stage.args[stage.args.indexOf('--timeout-ms')+1],'3600000');
const old=resolve(root,'../harness-original38-english-tfl161-preparation'),oldManifest=JSON.parse(await readFile(join(old,'package-manifest.json'),'utf8'));
assert.equal(hash(await readFile(join(old,'package-manifest.json'))),'298da22f7fa4f735b46e5b93e6023f1a280f4e065b5fcfc03cc6e076ee5e7748');
for(const entry of oldManifest.files)assert.equal(hash(await readFile(join(old,entry.path))),entry.sha256);
const equivalence=await read('validation/candidate-engine-equivalence.json');assert.deepEqual(equivalence.differingFiles,['agent/tasks/next-round.md','agent/tasks/template-revision.md']);for(const [file,digest] of Object.entries(equivalence.distFiles)){for(const candidate of ['candidate-2','candidate-3'])assert.equal('sha256:'+hash(await readFile(resolve(root,'../harness-acceptance-20',candidate,'content',file))),digest);}
console.log(JSON.stringify({sameActualDistFiles:equivalence.sameActualDistFiles,stagePreparationWrapped:true,strictMaterialDigest:true,nativeExecutorExplicit:true,checkedAtUtc:new Date().toISOString(),preparationIntegrity:'pass',packageFiles,inputFiles,oldPackagePayloadFilesUnchanged:oldManifest.files.length,definitions:2,compiled:2,datasets:1,resources:9,keyPoints:14,minuteValues:10,symbolReferences:9,referenceRegions:39,reviewRows:39,publicPreflight:'pass',resourceProbeRenderProblems:0,referenceProbeMissingRegions:39,referenceProbeMeaning:'format/load only; deliberately not a correct or model-produced panel',sourcePdfSha256:hash(await readFile(join(root,'source/161-north-greenwich.original.pdf'))),modelsCalled:0,bindingCreated:false,applied:false,sourcePackageApprovalSnapshot:'pending-user',currentApproval:'approved-separately-in-material-approval.json',runtimeCandidate:'candidate-5',businessAcceptance:'not-run',humanMinutes:null},null,2));

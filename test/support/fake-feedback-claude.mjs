// 受控纠偏执行器；真实 MCP 调用，绝不连接模型服务。
import {cp, readdir, readFile, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
if (process.argv.includes('--version')) {console.log('feedback-mechanism-1'); process.exit(0);}
for await (const _ of process.stdin) {}
const [preset] = process.argv.slice(2);
const config = JSON.parse(await readFile(process.argv[process.argv.indexOf('--mcp-config') + 1], 'utf8'));
const server = config.mcpServers.rw;
const child = spawn(server.command, server.args, {env: {...process.env, ...server.env}, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
let next = 0, buffer = ''; const waiting = new Map();
child.stdout.on('data', chunk => {buffer += chunk; for (;;) {const end = buffer.indexOf('\n'); if (end < 0) break;
  const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); waiting.get(value.id)?.(value); waiting.delete(value.id);}});
const rpc = (method, params) => new Promise(resolve => {const id = ++next; waiting.set(id, resolve); child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');});
const call = async (name, args = {}) => {const value = await rpc('tools/call', {name, arguments: args});
  if (value.error || value.result?.isError) throw new Error(JSON.stringify(value));
  return JSON.parse(value.result.content.find(item => item.type === 'text').text);};
await rpc('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'feedback-mechanism', version: '1'}});
let contextObservation;
if(process.argv.includes('--context-probe')){
  const catalog=JSON.parse(await readFile('docs/context-catalog.json','utf8')),references=[];
  for(const stage of catalog.stages){
    const reply=await rpc('tools/call',{name:'dsl_reference',arguments:{name:stage.name,...(stage.pointer?{pointer:stage.pointer}:{})}});
    if(reply.error||reply.result?.isError)throw new Error('候选目录参考不可达');
    const text=reply.result.content.find(block=>block.type==='text').text;
    if(stage.heading&&!text.includes(stage.heading))throw new Error('参考缺少所需章节');
    references.push(stage.name);
  }
  contextObservation={references,pages:0,unknownTotal:0};
}
let isTemplate = false;
if (['calibration', 'collateral', 'stale', 'mixed', 'pending'].includes(preset)) {
  const files = (await readdir('candidates')).filter(name => name.endsWith('.json'));
  const paths = files.map(name => 'candidates/' + name);
  await writeFile('outcome.json', JSON.stringify({candidates: paths, pending: [], notes: '机制验证；未测部分仍未知'}));
  if(contextObservation){
    const before=await call('check_outcome');let offset=0;
    do{
      const page=await call('outcome_feedback',{reportId:before.feedback.reportId,offset,limit:3,groupBy:'target'});
      if(page.contentIdentity!==before.contentIdentity.id)throw new Error('分页检查身份漂移');
      contextObservation.pages++;contextObservation.unknownTotal=page.unknownTotal;offset=page.nextOffset;
    }while(offset!==null);
    await writeFile('context-observation.json',JSON.stringify(contextObservation));
  }
  const document = JSON.parse(await readFile(paths[0], 'utf8'));
  isTemplate = document.dslVersion === 'renderweave-template/1';
  if (preset === 'mixed' && isTemplate) {
    child.stdin.end(); await new Promise(resolve => child.on('close', resolve));
    console.log(JSON.stringify({type: 'result', subtype: 'success', is_error: true, result: 'API Error: 429 quota exhausted', num_turns: 1, usage: {input_tokens: 10, output_tokens: 20}})); process.exit(0);
  }
  const correct = (document.name ?? document.dataset?.name).endsWith('-zh') ? '科技园' : 'Science Park';
  if (isTemplate) {
    const first = await call('compare_reference');
    if (first.nextRegionOffset !== 20) throw new Error('第一页没有20项分页');
    const later = await call('compare_reference', {regionOffset: first.nextRegionOffset});
    if (!later.anomalies.some(item => item.regionId === 'region-22')) throw new Error('未实际取得后续页缺陷');
    await call('compare_reference', {regions: ['region-22']});
    const node = document.artboard.children[21]; node.content[0].text = correct; node.fontSize = 7; node.color = '#172B4D'; node.place.left = 60;
  } else if (document.fields) document.fields[1].name = 'stopName'; else document.data.stopName = correct;
  if (preset === 'collateral' || preset === 'mixed' && document.data) {if (document.fields) document.fields[0].displayName = '越界修改'; else document.data.routeNo = '99';}
  await writeFile(paths[0], JSON.stringify(document));
} else await cp(preset, process.cwd(), {recursive: true});
if (isTemplate) await call('compare_reference');
if (preset === 'pending') {const outcome = JSON.parse(await readFile('outcome.json', 'utf8')); outcome.pending = [{file: 'candidates/dataset.json', path: 'stopName', candidate: '错误候选', reason: 'conflicting', note: '受控反例'}]; await writeFile('outcome.json', JSON.stringify(outcome));}
const checked = await call('check_outcome');
if (preset === 'stale') {const path = 'candidates/definition.json'; const document = JSON.parse(await readFile(path, 'utf8')); document.fields[0].displayName = '检查后修改'; await writeFile(path, JSON.stringify(document));}
await writeFile('mechanism-observation.json', JSON.stringify({checked}));
child.stdin.end(); await new Promise(resolve => child.on('close', resolve));
console.log(JSON.stringify({type: 'system', subtype: 'init', model: process.env.ANTHROPIC_MODEL, claude_code_version: 'feedback-mechanism-1'}));
console.log(JSON.stringify({type: 'result', subtype: 'success', is_error: false, num_turns: 2, usage: {input_tokens: 10, output_tokens: 20,
  output_tokens_details: {thinking_tokens: 4}, cache_read_input_tokens: 0, cache_creation_input_tokens: 0}}));

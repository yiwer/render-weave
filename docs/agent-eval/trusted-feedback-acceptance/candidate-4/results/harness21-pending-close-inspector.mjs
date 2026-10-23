import {writeFile} from 'node:fs/promises';
const file='C:/Users/Administrator/.codex/visualizations/2026/10/23/01a167fb-6fcb-7771-8713-7be4f73bddf8/harness21-candidate4-pending-close-inspector.json';
const log={format:'harness-local-inspector-diagnostic/1',pid:125740,startedAt:new Date().toISOString(),scope:'仅 active resource 类型与调用位置；不读 env、scope、heap 或凭据；不改业务结果。',commands:[]};
const [target]=await (await fetch('http://127.0.0.1:9229/json/list')).json();
if(!target?.webSocketDebuggerUrl?.startsWith('ws://127.0.0.1:9229/'))throw Error('not loopback');
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
let sequence=0;const pending=new Map();let pausedResolve;const paused=new Promise(resolve=>pausedResolve=resolve);
function location(frame){return {functionName:frame.functionName,url:frame.url,lineNumber:frame.location?.lineNumber??frame.lineNumber,columnNumber:frame.location?.columnNumber??frame.columnNumber};}
function stack(value){return value?{description:value.description,callFrames:value.callFrames?.map(location),parent:stack(value.parent)}:undefined;}
ws.onmessage=event=>{const message=JSON.parse(event.data);if(message.id){const p=pending.get(message.id);if(p){pending.delete(message.id);message.error?p.reject(Error(JSON.stringify(message.error))):p.resolve(message.result)}}if(message.method==='Debugger.paused')pausedResolve({reason:message.params.reason,callFrames:message.params.callFrames.map(location),asyncStackTrace:stack(message.params.asyncStackTrace)});};
function command(method,params={}){const id=++sequence;log.commands.push({at:new Date().toISOString(),method,params});ws.send(JSON.stringify({id,method,params}));return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});setTimeout(()=>{if(pending.delete(id))reject(Error('diagnostic timeout '+method))},5000).unref()})}
try {
 log.resourcesBefore=(await command('Runtime.evaluate',{expression:'process.getActiveResourcesInfo()',returnByValue:true})).result.value;
 await command('Debugger.enable');await command('Debugger.setAsyncCallStackDepth',{maxDepth:8});
 await command('Debugger.pause');log.pause=await Promise.race([paused,new Promise((_,reject)=>setTimeout(()=>reject(Error('pause timeout')),5000))]);
 await command('Debugger.resume');
 log.resourcesAfter=(await command('Runtime.evaluate',{expression:'process.getActiveResourcesInfo()',returnByValue:true})).result.value;
 await command('Debugger.disable');
 // 调试连接的关闭仅改变 inspector 本身，不改变运行结果或等待中的 Promise。
 await command('Runtime.evaluate',{expression:"import('node:inspector').then(module=>setTimeout(()=>module.close(),50)); 'inspector-close-scheduled'",returnByValue:true});
} catch(error){log.error=String(error);try{await command('Debugger.resume')}catch{}try{await command('Runtime.evaluate',{expression:"import('node:inspector').then(module=>setTimeout(()=>module.close(),50)); 'inspector-close-scheduled'",returnByValue:true})}catch{}}
finally{ws.close();log.endedAt=new Date().toISOString();await writeFile(file,JSON.stringify(log,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(log));}

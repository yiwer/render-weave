import {writeFile} from 'node:fs/promises';
const [target]=await(await fetch('http://127.0.0.1:9229/json/list')).json();
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
let id=0;const pending=new Map(),events=[];
ws.onmessage=event=>{const m=JSON.parse(event.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id)}if(m.method==='Debugger.paused'){events.push({at:new Date().toISOString(),event:'paused',frames:m.params.callFrames.map(f=>({name:f.functionName,url:f.url,location:f.location}))});ws.send(JSON.stringify({id:++id,method:'Debugger.resume'}));}};
async function command(method,params={}){const n=++id;ws.send(JSON.stringify({id:n,method,params}));return Promise.race([new Promise(r=>pending.set(n,r)),new Promise(r=>setTimeout(()=>r({timeout:true}),1500))]);}
events.push({at:new Date().toISOString(),enable:await command('Debugger.enable')});
events.push({at:new Date().toISOString(),close:await command('Runtime.evaluate',{expression:'process._debugEnd(); "inspector closed"',returnByValue:true})});
ws.close();await writeFile('C:/Users/Administrator/.codex/visualizations/2026/10/23/01a167fb-6fcb-7771-8713-7be4f73bddf8/harness21-candidate4-inspector-close.json',JSON.stringify(events,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(events));

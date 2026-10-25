import fs from 'node:fs';
import {spawn} from 'node:child_process';
const directory=process.argv[2];
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)','harness-english-candidate5-stop-child'],{windowsHide:true,stdio:'ignore'});
fs.writeFileSync(directory+'/owned-pids.json',JSON.stringify({parent:process.pid,child:child.pid,modelCalls:0})+'\n',{flag:'wx'});
setInterval(()=>{},1000);

import fs from 'node:fs';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const root='F:/GenCode/render-weave';
const require=createRequire(root+'/out/harness-acceptance-20/candidate-5/content/package.json');
const {PNG}=require('pngjs');
const base=root+'/out/harness-original38-review/en-tfl161-correction1-candidate-5/';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const files=['first-actual-request.png','actual-request.png'].map(name=>{const bytes=fs.readFileSync(base+name);return {name,sha256:sha(bytes),image:PNG.sync.read(bytes)};});
const [a,b]=files.map(f=>f.image);
if(a.width!==b.width||a.height!==b.height)throw Error('Image dimensions differ');
let count=0,minX=Infinity,minY=Infinity,maxX=-1,maxY=-1,outsideRouteStrip=0;
for(let y=0;y<a.height;y++)for(let x=0;x<a.width;x++){
 const i=(y*a.width+x)*4;
 if([0,1,2,3].some(c=>a.data[i+c]!==b.data[i+c])){
  count++;minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);
  if(y<419||y>436)outsideRouteStrip++;
 }
}
const result={format:'original38-english-pixel-comparison/1',role:'automatic-diagnostic-not-independent-human-acceptance',images:files.map(({name,sha256,image})=>({name,sha256,width:image.width,height:image.height})),comparison:'Exact decoded RGBA values; no resizing or image rewriting',changedPixels:count,changedBounds:count?{x:minX,y:minY,width:maxX-minX+1,height:maxY-minY+1}:null,routeStripForScopeInspection:{minY:419,maxY:436},changedPixelsOutsideRouteStrip:outsideRouteStrip,humanAcceptance:null};
fs.writeFileSync(root+'/out/harness-original38-english-tfl161-final-candidate-5/pixel-comparison.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));

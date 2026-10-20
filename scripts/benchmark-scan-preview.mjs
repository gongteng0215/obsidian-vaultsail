import './node-host.mjs';
// Synthetic benchmark: no credentials, user notes, or real cloud access.
// --side baseline records the frozen 0.2.8 implementation before changes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { baiduHarness } from '../test/fixtures/baidu.ts';
import { bytes, hash, uuid, jsonBytes } from '../src/core/safety.ts';
const args = new Map(); for (let n=2;n<process.argv.length;n+=2) args.set(process.argv[n],process.argv[n+1]);
const sizes=(args.get('--sizes')??'7,100,1000').split(',').map(Number), rounds=Number(args.get('--rounds')??10), latency=Number(args.get('--latency')??2), devices=Number(args.get('--devices')??1);
if(sizes.some(n=>!Number.isInteger(n)||n<1||n>10000)||!Number.isInteger(rounds)||rounds<1||rounds>20||!Number.isInteger(devices)||devices<1||devices>4||!Number.isFinite(latency)||latency<0||latency>100)throw Error('Invalid benchmark parameters');
const ref='60d494a', output=path.resolve('dist/benchmark-scan-preview');fs.mkdirSync(output,{recursive:true});
const sources=['src/providers/baidu-provider.ts','src/sync/remote-vault.ts','src/sync/engine.ts'];
async function implementation(baseline){
  const bundle=await build({stdin:{contents:"export { BaiduProvider } from './src/providers/baidu-provider.ts'; export { RemoteVaultStore } from './src/sync/remote-vault.ts'; export { SyncEngine, newState } from './src/sync/engine.ts';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,
    plugins:baseline?[{name:'frozen-baseline',setup(b){b.onLoad({filter:/\.ts$/},a=>{const relative=path.relative(process.cwd(),a.path).replaceAll('\\','/');return sources.includes(relative)?{contents:execFileSync('git',['show',`${ref}:${relative}`],{encoding:'utf8'}),loader:'ts'}:undefined;});}}]:[]});
  const target=path.join(output,baseline?'baseline.mjs':'current.mjs');fs.writeFileSync(target,bundle.outputFiles[0].text);return import(pathToFileURL(target).href);
}
async function measure(impl,size){
  const h=baiduHarness(), vaultId=uuid(), deviceIds=Array.from({length:devices},()=>uuid()), base=`vaultsail/vaults/${vaultId}`;
  const notes=new Map(), staged=new Map(), latest=new Map();let state=impl.newState(), saved, counts, scan;
  const put=(relative,data)=>{const full='/apps/中文应用/'+relative; const parts=full.split('/');for(let i=3;i<parts.length;i++)h.dirs.add(parts.slice(0,i).join('/'));h.files.set(full,data);if(!h.ids.has(full))h.ids.set(full,String(h.ids.size+1));};
  put(base+'/vault.json',jsonBytes({schemaVersion:1,vaultId,displayName:'synthetic',createdAt:1}));
  const publish=(file,content,parents=[],deviceId=deviceIds[0])=>{const previous=latest.get(file);const data=bytes(content), op={schemaVersion:1,vaultId,opId:uuid(),deviceId,fileId:previous?.fileId??uuid(),path:file,parents,kind:'update',hash:hash(data),size:data.byteLength,createdAt:1};put(base+'/blobs/'+op.hash,data);put(base+'/ops/'+deviceId+'/'+op.opId+'.json',jsonBytes(op));latest.set(file,op);return op;};
  for(let i=0;i<size;i++){const file=`notes/${i}.md`,op=publish(file,'synthetic note '+i,[],deviceIds[i%devices]);notes.set(file,bytes('synthetic note '+i));state.bases[file]={fileId:op.fileId,hash:op.hash,heads:[op.opId]};state.knownOps.push(op.opId);}
  const local={paths:async()=>[...notes.keys()],stat:async p=>notes.has(p)?{size:notes.get(p).byteLength}:null,read:async p=>{counts.localReads++;return notes.get(p)?.slice(0)??null;},stage:async(id,data)=>{staged.set(id,data.slice(0));},staged:async id=>staged.get(id)?.slice(0)??null,
    preserve:async(p,data,id)=>id+'/'+p,readConflictCopy:async()=>null,writeConflictCopy:async()=>{throw Error('Unexpected conflict');},apply:async(p,data,expected)=>{assert.equal(notes.has(p)?hash(notes.get(p)):null,expected);if(data)notes.set(p,data.slice(0));else notes.delete(p);}};
  const disk={load:async()=>structuredClone(saved),save:async value=>{counts.cacheWrites++;saved=structuredClone(value);}};
  const fresh=()=>{const provider=new impl.BaiduProvider('/apps/中文应用',async input=>{counts.requests++;const q=new URL(input.url),method=q.searchParams.get('method');if(method==='list')counts.pages++;if(method==='filemetas')counts.metadata++;if(q.pathname.startsWith('/file/')){counts.downloads++;counts.readBytes+=h.files.get(decodeURIComponent(q.pathname.slice(6))).byteLength;}if(latency)await new Promise(r=>setTimeout(r,latency));return h.transport(input);},{accessToken:async()=> 'private-access'});return {provider,engine:new impl.SyncEngine(new impl.RemoteVaultStore(provider,disk,8,s=>{scan=s;}),local,{load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s);}},vaultId)};};
  let task=fresh();const results={};
  for(const scenario of ['cold','warm','restart','local-change','remote-change','concurrent-publication']){
    if(scenario==='restart')task=fresh();
    if(scenario==='local-change')notes.set('notes/0.md',bytes('locally changed note'));
    if(scenario==='remote-change'){const op=latest.get('notes/0.md');publish(op.path,'remote changed note',[state.bases[op.path].heads[0]],deviceIds.at(-1));}
    if(scenario==='concurrent-publication'){const a=latest.get('notes/0.md');publish(a.path,'remote branch one',[a.opId],deviceIds[0]);publish(a.path,'remote branch two',[a.opId],deviceIds.at(-1));}
    counts={requests:0,pages:0,metadata:0,downloads:0,readBytes:0,cacheWrites:0,localReads:0};scan=undefined;const started=performance.now();await task.provider.profile();
    if(scenario==='concurrent-publication'){const records=await task.engine.remote?.revisions(vaultId,undefined,true);assert.ok(records?.some(op=>op.hash===hash(bytes('remote branch one'))));assert.ok(records.some(op=>op.hash===hash(bytes('remote branch two'))));}
    else await task.engine.sync();
    results[scenario]={elapsedMs:performance.now()-started,...counts,scan};
    assert.equal(state.journals.length,0);
    if(scenario==='remote-change')assert.equal(hash(notes.get('notes/0.md')),hash(bytes('remote changed note')));
  }
  return results;
}
const requestedSide=args.get('--side'), sides=requestedSide==='baseline'?['baseline']:requestedSide==='current'?['current']:['baseline','current'], reports=[];
for(const side of sides){const impl=await implementation(side==='baseline');for(const size of sizes){const rows=[];for(let round=0;round<rounds;round++)rows.push(await measure(impl,size));const summary={};for(const scenario of Object.keys(rows[0])){const times=rows.map(r=>r[scenario].elapsedMs).sort((a,b)=>a-b);summary[scenario]={medianMs:times[Math.floor(times.length/2)],p95Ms:times[Math.ceil(times.length*.95)-1],...Object.fromEntries(['requests','pages','metadata','downloads','readBytes','cacheWrites','localReads'].map(k=>[k,rows[0][scenario][k]]))};}reports.push({side,size,devices,summary,rows});console.log(JSON.stringify({side,size,summary}));}}
const report={baselineRef:ref,simulated:true,scope:'Synthetic complete sync/scanning; not real Baidu throughput',latencyMs:latency,rounds,reports};
fs.writeFileSync(path.join(output,`report-${args.get('--side')??'comparison'}-${sizes.join('-')}-${devices}devices.json`),JSON.stringify(report,null,2));

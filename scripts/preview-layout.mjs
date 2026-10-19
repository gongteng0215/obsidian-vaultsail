// Local visual harness: real settings renderer + test-only Obsidian components.
// No vault, credentials, network provider, or account is attached.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const output = path.resolve('dist/layout'); fs.mkdirSync(output, { recursive: true });
// Use the installed host stylesheet locally; it must never enter the release package.
const hostCss = path.join(output, 'obsidian.css');
if (!fs.existsSync(hostCss)) {
  const archivePath = process.env.VAULTSAIL_OBSIDIAN_ASAR;
  if (!archivePath) throw new Error('Set VAULTSAIL_OBSIDIAN_ASAR to your installed resources/obsidian.asar.');
  const archive = fs.openSync(archivePath, 'r');
  try {
    const prefix = Buffer.alloc(16); fs.readSync(archive, prefix, 0, 16, 0);
    const header = Buffer.alloc(prefix.readUInt32LE(12)); fs.readSync(archive, header, 0, header.length, 16);
    const entry = JSON.parse(header.toString('utf8')).files['app.css'];
    const css = Buffer.alloc(entry.size); fs.readSync(archive, css, 0, css.length, 8 + prefix.readUInt32LE(4) + Number(entry.offset));
    fs.writeFileSync(hostCss, css);
  } finally { fs.closeSync(archive); }
}
const baselineCss = path.join(output, 'baseline.css');
if (!fs.existsSync(baselineCss)) fs.writeFileSync(baselineCss, execFileSync('git', ['show', '0.2.4:styles.css']));
const fixture = String.raw`
import { VaultSailSettingTab } from './src/ui/settings-tab.ts';
import { DEFAULT_SETTINGS } from './src/config.ts';
import { TransferCenterPanel } from './src/ui/transfer-center-panel.ts';
const proto = HTMLElement.prototype;
proto.empty = function() { this.replaceChildren(); };
proto.setText = function(text) { this.textContent = text; };
proto.createEl = function(tag, options = {}) { const el = this.appendChild(document.createElement(tag)); if (options.text) el.textContent = options.text; if (options.cls) el.className = options.cls; return el; };
proto.createDiv = function(options) { return this.createEl('div', options); };
const app = { vault: { getName: () => '研究笔记与附件资料库_长名称换行检查', configDir: '.obsidian' }, secretStorage: { getSecret: () => null } };
const progress = { phase: 'uploading', path: '资料/中文长文件名_跨设备同步的视频附件_338MiB.mp4', doneFiles: 0, totalFiles: 7, doneBytes: 0, totalBytes: 355100000, startedAt: Date.now() - 60000, updatedAt: Date.now(), activeFiles: 1, concurrency: 8, uploads: [{path:'资料/中文长文件名_跨设备同步的视频附件_338MiB.mp4',stage:'uploading',uploadedBytes:134217728,totalBytes:355100000,completedParts:32,totalParts:85,currentPart:33,attempt:1}] };
const plugin = new Proxy({ settings: { ...DEFAULT_SETTINGS, providerId: 'baidu', binding: { vaultId: '00000000-0000-4000-8000-000000000001', displayName: '跨设备资料库_很长的云端知识库名称', root:'/apps/VaultSail', accountHash:'demo', appKey:'demo' } },
auth:{status:()=>'connected',configurationIssue:()=>null}, authPhase:'idle', deviceSession:undefined, browserRequested:false, progress, busy:false, manifest:{version:${JSON.stringify(JSON.parse(fs.readFileSync('manifest.json','utf8')).version)}}, statusText:'正在上传视频附件，布局测试使用模拟数据。',
fileLimit:()=>512*1024*1024, queueSummary:()=>'正在执行手动同步；后续修改会合并进入队列。',blockedSummary:()=>'上次扫描没有超限或关联保护项。',cloudLocation:()=>'/apps/VaultSail/vaultsail/vaults/00000000-0000-4000-8000-000000000001',lastSuccess:()=>null,performanceText:()=>'连接检查 0.4 秒 · 云端扫描 7.1 秒 · 本地扫描 0.0 秒\n网络请求 39 次 · 令牌刷新 0 次' }, {get:(target,key)=>key in target?target[key]:(()=>{})});
const params = new URLSearchParams(location.search);
if (params.get('view') === 'transfers') {
  const now = Date.now();
  const names = [progress.path, '笔记/今日研究.md', '附件/实验流程图.png', '笔记/项目计划.md', '文献/参考资料.pdf', '附件/采样记录.csv', '附件/等待重试的文件.zip'];
  const states = ['running','succeeded','succeeded','unchanged','queued','queued','failed'];
  const sample = { context:'demo-vault',target:'研究笔记 → 百度网盘',busy:true,pauseRequested:false,queue:'正在执行手动同步；后续修改会合并进入下一轮。',progress,
    task:{version:1,id:'demo-task',context:'demo-vault',deviceId:'demo-device',sequence:1,mode:'manual',startedAt:now-60000,updatedAt:now,status:'running',truncated:false,
      files:names.map((path,index)=>({id:String(index),path,action:'upload',size:index===0?355100000:index===4?12345678:12345,state:states[index],reason:index===3?'unchanged':index===6?'stopped':'planned',updatedAt:now,...(index===6?{code:'network'}:{})}))},
    timings:{[progress.path]:{stage:'uploading',since:now-50000,elapsedMs:50000,stages:{preparing:4300,uploading:50000},sourcePreparationMs:5200,bytesPerSecond:838860,uploadRemainingSeconds:264}},bytesPerSecond:838860,historyWarning:false};
  if (params.get('phase') === 'verifying') { sample.progress.phase='verifying'; sample.progress.uploads[0].stage='verifying'; sample.progress.uploads[0].uploadedBytes=355100000; sample.progress.uploads[0].completedParts=85; sample.timings[progress.path].stage='verifying'; sample.timings[progress.path].elapsedMs=12000; sample.bytesPerSecond=0; }
  if (params.get('phase') === 'paused') { sample.busy=false; sample.task.status='paused'; sample.progress.phase='paused'; sample.task.files.forEach(row=>{if(row.state==='running')row.state='paused';if(row.state==='queued')row.state='not-run';});sample.bytesPerSecond=0; }
  if (params.get('phase') === 'parallel') sample.progress.uploads[0].activeParts=[33,34];
  if (params.get('phase') === 'retry') { sample.progress.uploads[0].activeParts=[];sample.progress.uploads[0].waitingParts=[{part:33,until:now+30000,attempt:2}];sample.progress.uploads[0].retryCount=1;sample.bytesPerSecond=0;delete sample.timings[progress.path].bytesPerSecond; }
  if (['scan','scan-reading'].includes(params.get('phase'))) {
    sample.progress.phase='scanning-remote'; sample.progress.uploads=[];
    sample.progress.scan={phase:'listing',devicesDone:2,devices:3,pages:5,listed:428,completed:0,cacheHits:0,read:0};
    sample.task.files=[]; sample.bytesPerSecond=0;
    if(params.get('phase')==='scan-reading')sample.progress.scan={phase:'reading',devicesDone:3,devices:3,pages:8,listed:428,completed:420,cacheHits:412,read:8};
  }
  const host = document.createElement('section'); document.querySelector('#settings-host').append(host);
  new TransferCenterPanel(host,{snapshot:()=>sample,subscribe:()=>()=>{},refresh:async()=>{},sync:()=>{},pause:()=>{sample.pauseRequested=true;},resume:()=>{},history:()=>{}});
} else {
  const view = new VaultSailSettingTab(app, plugin); document.querySelector('#settings-host').append(view.containerEl); view.containerEl.classList.add('vertical-tab-content'); view.display();
}
for (const id of ['width','zoom','font']) { const input = document.getElementById(id); input.value = params.get(id) || input.value; input.addEventListener('input', update); }
function update() {
  const width=Number(document.getElementById('width').value)||720, zoom=(Number(document.getElementById('zoom').value)||100)/100, font=(Number(document.getElementById('font').value)||100)/100;
  const shell=document.querySelector('#preview'); shell.style.width=width/zoom+'px'; shell.style.zoom=zoom;
  // Host themes define these on body, overriding inherited root values.
  for (const target of [document.documentElement, document.body]) {
    target.style.setProperty('--font-ui-small',13*font+'px'); target.style.setProperty('--font-ui-medium',15*font+'px');
    target.style.setProperty('--font-ui-smaller',12*font+'px'); target.style.setProperty('--input-height',30*font+'px');
  }
}
update(); const tab=params.get('tab');if(tab)document.getElementById('vaultsail-tab-'+tab)?.click();
`;
const result = await build({ stdin: { contents: fixture, resolveDir: process.cwd() }, bundle: true, format: 'iife', platform: 'browser', write: false,
  plugins: [{ name: 'obsidian-layout-harness', setup(builder) { builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.resolve('test/fixtures/obsidian.ts') })); } }] });
fs.writeFileSync(path.join(output, 'app.js'), result.outputFiles[0].text);
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1:4179');
  const files = { '/app.js': [path.join(output,'app.js'),'text/javascript'], '/obsidian.css': [path.join(output,'obsidian.css'),'text/css'], '/plugin.css': [path.resolve('styles.css'),'text/css'], '/baseline.css': [path.join(output,'baseline.css'),'text/css'] };
  if (files[url.pathname]) { const [file,type]=files[url.pathname];response.setHeader('Content-Type',type);response.end(fs.readFileSync(file));return; }
  if (url.pathname !== '/') { response.writeHead(404);response.end();return; }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html><head><meta charset="utf-8"><title>VaultSail 本地布局验证</title><link rel="stylesheet" href="/obsidian.css"><link rel="stylesheet" href="${url.searchParams.has('baseline')?'/baseline.css':'/plugin.css'}"><style>body{display:block;overflow:auto;height:auto;min-height:100vh;padding:20px;background:var(--background-secondary)}.test-controls{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:20px}.test-controls input{width:90px}#preview.modal.mod-settings{position:static;transform:none;max-width:none;max-height:none;height:auto;margin:0;padding:0;overflow:visible}#settings-host{width:100%;min-width:0}.vertical-tabs-container{height:auto}button{cursor:pointer}</style></head><body class="${url.searchParams.get('theme')==='light'?'theme-light':'theme-dark'}"><div class="test-controls"><label>设置区域宽度 <input id="width" type="number" value="720"></label><label>整体缩放 % <input id="zoom" type="number" value="100"></label><label>界面字号 % <input id="font" type="number" value="100"></label></div><main id="preview" class="modal mod-settings"><div class="vertical-tabs-container"><div id="settings-host" class="vertical-tab-content-container"></div></div></main><script src="/app.js"></script></body></html>`);
});
server.listen(4179, '127.0.0.1', () => console.log('Layout preview: http://127.0.0.1:4179/'));

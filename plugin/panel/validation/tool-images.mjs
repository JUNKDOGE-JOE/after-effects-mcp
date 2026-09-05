import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const panel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2]);
await fs.mkdir(output, { recursive: true });
const fixture = await build({
  absWorkingDir: panel, bundle: true, write: false, format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  stdin: { resolveDir: panel, loader: 'jsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { ChatScreen } from './src/screens/ChatScreen.jsx';
    import { StatusBar } from './src/components/shell/StatusBar.jsx';
    import { TabBar } from './src/components/shell/TabBar.jsx';
    const root = createRoot(document.getElementById('root'));
    window.keyInterests=[];
    window.cep_node={process:{platform:'win32'}};
    window.__adobe_cep__={registerKeyEventsInterest:value=>window.keyInterests.push(value)};
    window.clearPreview=()=>root.render(null);
    const canvas = document.createElement('canvas'); canvas.width=1600; canvas.height=900;
    const ctx=canvas.getContext('2d');
    window.images=['#c54d37','#276f60'].map((color,i)=>{ctx.fillStyle=color;ctx.fillRect(0,0,1600,900);
      ctx.fillStyle='#ffffff';ctx.fillRect(100,100,400,700);ctx.font='160px sans-serif';ctx.fillText('FRAME '+(i+1),550,480);
      return {src:canvas.toDataURL()};});
    window.reset = (lang, images=window.images) => {
      root.render(<React.Fragment>
        <StatusBar label="Connected"/><div style={{height:32,flex:'none'}}>Update available · 有新版本</div>
        <ChatScreen lang={lang} sessionTitle="Preview" onNewSession={()=>{}} attachmentDraft={{items:[],text:'continue'}}
          createTurnId={()=>'continue'} onSend={()=>{window.sent=true;}} entries={[{
          id:'preview',type:'tool-call',toolUseId:'preview',name:'ae_previewFrame',state:'ok',images,
          input:{times:[0,1]},text:JSON.stringify({frames:2,detail:'long content'.repeat(1000)})
        }]}/><TabBar active="chat" tabs={['chat','activity','tools','settings'].map(id=>({id,label:id,icon:'box'}))}/>
      </React.Fragment>);
    };
  ` },
});
const css = await fs.readFile(path.join(panel, '../client/dist/app.css'), 'utf8');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const page = await browser.newPage();
const ledger = [];
async function geometry(label) {
  const data = await page.evaluate(() => {
    const input=document.querySelector('textarea');
    const r=input.getBoundingClientRect();
    const image=document.querySelector('[data-tool-images] img');
    const ir=image?.getBoundingClientRect();
    return {width:innerWidth,height:innerHeight,scroll:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],
      input:[r.x,r.y,r.width,r.height],inputHit:input.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),
      image:ir && {width:ir.width,height:ir.height,naturalWidth:image.naturalWidth,fit:getComputedStyle(image).objectFit}};
  });
  assert.ok(data.scroll[0]<=data.width && data.scroll[1]<=data.height, label+' outer overflow');
  assert.ok(data.inputHit && data.input[1]>=0 && data.input[1]+data.input[3]<=data.height, label+' input accessible');
  if(data.image) assert.ok(data.image.width<=data.width && data.image.height<=241 && data.image.fit==='contain');
  ledger.push({label,disposition:'PASS',...data});
  return data.input;
}
try {
  for (const [width,height] of [[280,300],[420,480]]) for (const lang of ['zh','en']) {
    const label=[width,height,lang].join('-');
    await page.setViewportSize({width,height});
    await page.setContent('<div id="root"></div>');
    await page.addStyleTag({content:css});
    await page.addScriptTag({content:fixture.outputFiles[0].text});
    await page.evaluate(lang=>window.reset(lang),lang);
    await page.waitForFunction(()=>document.querySelector('[data-tool-images] img')?.naturalWidth===1600);
    assert.equal(await page.locator('pre').count(),0);
    const before=await geometry(label+' initial');
    const first=await page.locator('[data-tool-images] img').getAttribute('src');
    await page.getByTitle(lang==='zh'?'下一张':'Next image',{exact:true}).click();
    assert.notEqual(await page.locator('[data-tool-images] img').getAttribute('src'),first);
    assert.deepEqual(await geometry(label+' next'),before);
    await page.locator('[aria-expanded="false"]').click();
    assert.equal(await page.locator('pre').count(),2);
    assert.deepEqual(await geometry(label+' details'),before);
    await page.locator('[aria-expanded="true"]').press('Enter');
    await page.locator('[data-tool-images] img').scrollIntoViewIfNeeded();
    const visible = await page.locator('[data-tool-images] img').evaluate(el => {
      const r=el.getBoundingClientRect();
      return [0.1,0.5,0.9].every(v=>el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height*v)));
    });
    assert.ok(visible,label+' entire preview is visible inside the transcript');
    await page.screenshot({path:path.join(output,label+'.png')});
    await page.getByTitle(lang==='zh'?'查看大图':'View larger image',{exact:true}).click();
    const dialog=page.getByRole('dialog');
    await dialog.waitFor();
    const interest=JSON.stringify([{keyCode:27,ctrlKey:false,altKey:false,shiftKey:false}]);
    assert.deepEqual(await page.evaluate(()=>window.keyInterests),[interest]);
    const large=await dialog.locator('img').boundingBox();
    assert.ok(large.width>=250 && large.height>=180,label+' readable enlarged preview');
    await dialog.getByTitle(lang==='zh'?'上一张':'Previous image',{exact:true}).click();
    assert.equal(await dialog.locator('img').getAttribute('src'),first);
    assert.deepEqual(await page.evaluate(()=>window.keyInterests),[interest]);
    await page.screenshot({path:path.join(output,label+'-large.png')});
    await dialog.getByTitle(lang==='zh'?'关闭预览':'Close preview',{exact:true}).press('Escape');
    assert.equal(await page.getByRole('dialog').count(),0);
    assert.deepEqual(await page.evaluate(()=>window.keyInterests),[interest,'']);
    assert.ok(await page.getByTitle(lang==='zh'?'查看大图':'View larger image',{exact:true}).evaluate(el=>el===document.activeElement));
    await page.getByTitle(lang==='zh'?'查看大图':'View larger image',{exact:true}).click();
    await page.getByTitle(lang==='zh'?'关闭预览':'Close preview',{exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.keyInterests),[interest,'',interest,'']);
    assert.deepEqual(await geometry(label+' close large'),before);
    await page.locator('textarea').focus();
    assert.ok(await page.locator('textarea').evaluate(el=>el===document.activeElement));
    await page.getByTitle('发送 Send',{exact:true}).click();
    assert.equal(await page.evaluate(()=>window.sent),true);
    await page.evaluate(lang=>window.reset(lang,[{src:'file:///missing-preview.png'}]),lang);
    await page.getByRole('status').waitFor();
    assert.match(await page.getByRole('status').textContent(),lang==='zh'?/失效|失败/:/expired|failed/);
    await geometry(label+' expired');
    await page.evaluate(lang=>window.reset(lang,[window.images[0]]),lang);
    await page.waitForFunction(()=>document.querySelector('[data-tool-images] img')?.naturalWidth===1600);
    assert.equal(await page.getByRole('status').count(),0);
    assert.equal(await page.locator('[data-tool-images] img').getAttribute('src'),first);
    await geometry(label+' restored');
    await page.getByTitle(lang==='zh'?'查看大图':'View larger image',{exact:true}).click();
    await page.getByRole('dialog').waitFor();
    await page.evaluate(()=>window.clearPreview());
    await page.waitForFunction(()=>!document.querySelector('[data-tool-images]'));
    assert.deepEqual(await page.evaluate(()=>window.keyInterests),[interest,'',interest,'',interest,'']);
  }
  await fs.writeFile(path.join(output,'summary.json'),JSON.stringify({validationProfile:'offline',cases:ledger},null,2));
  console.log(JSON.stringify({passed:ledger.length}));
} finally { await browser.close(); }

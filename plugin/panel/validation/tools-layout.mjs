import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Uses an externally installed Playwright and Chrome; never connects to AE.
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
    import { ToolsScreen } from './src/screens/ToolsScreen.jsx';
    import { StatusBar } from './src/components/shell/StatusBar.jsx';
    import { TabBar } from './src/components/shell/TabBar.jsx';
    const root = createRoot(document.getElementById('root'));
    window.reset = (lang, kind, status, notice) => {
      const long = 'VeryLongName超长名称'.repeat(120);
      const schema = {properties:Object.fromEntries(Array.from({length:80},(_,i)=>['p'+i,{default:long}]))};
      window.item = {id:'fixture',name:long,description:long,content:('var x = 1; // '+long+'\\n').repeat(40),
        template:long.repeat(10),argsSchema:schema,args_schema:schema,status,kind:'jsx',template_type:kind,verified:true};
      window.calls=[]; window.fail=false;
      const output = () => { window.calls.push('run'); if(window.fail) throw new Error(long); return {rendered:long,result:long.repeat(10)}; };
      const api = {index:async()=>({artifacts:[window.item]}),search:async()=>({artifacts:[window.item]}),
        inspect:async()=>({artifact:window.item}),listSkills:async()=>({skills:[window.item]}),
        executeTool:async()=>output(),executeSkill:async()=>output(),renderSkill:async()=>output()};
      root.render(<React.Fragment key={Math.random()}>
        <StatusBar label="Connected"/><div style={{height:notice,flex:'none'}}>Notice 提示</div>
        <ToolsScreen api={api} lang={lang}/>
        <TabBar active="tools" tabs={['chat','activity','tools','settings'].map(id=>({id,label:id,icon:'box'}))}/>
      </React.Fragment>);
    };
    window.fetch = async (url, options={}) => {
      window.calls.push(url);
      return {ok:true,json:async()=>url.endsWith('/tool-library') ? {candidates:[{...window.item,status:'candidate'}],artifacts:[window.item]} :
        url.endsWith('/export') ? {path:'C:/exports/'+ 'long'.repeat(1000) +'.json'} : {ok:false,error:'Error错误'.repeat(1000)}};
    };
  ` },
  plugins: [{ name: 'isolated-platform', setup(builder) {
    builder.onResolve({ filter: /(?:cep\/platform\/index\.js|lib\/clipboard)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path.endsWith('clipboard')
      ? 'export async function copyText(text) { window.copied = text; }'
      : "export function createPlatformAdapter() { return {paths:{configRoot:'fixture',join:()=>''},fs:{readFileSync:()=> 'fixture-token'}}; }" }));
  } }],
});
const css = await fs.readFile(path.join(panel, '../client/dist/app.css'), 'utf8');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const page = await browser.newPage();
const ledger = [];
async function geometry(label) {
  const data = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')].filter(el => el.getBoundingClientRect().height && !el.closest('.tools-list'));
    return { width: innerWidth, height: innerHeight, scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
      buttons: buttons.map(el => {
        const r = el.getBoundingClientRect();
        const points = [[r.x+2,r.y+2],[r.right-2,r.bottom-2],[r.x+r.width/2,r.y+r.height/2]];
        return {text:el.textContent || el.title, x:r.x,y:r.y,w:r.width,h:r.height,disabled:el.disabled,
          hit:points.every(([x,y])=>el.contains(document.elementFromPoint(x,y)))};
      }), textHeight: document.querySelector('.tools-text-area')?.clientHeight };
  });
  assert.ok(data.scroll[0] <= data.width && data.scroll[1] <= data.height, label + ' outer overflow');
  for (const b of data.buttons) assert.ok(b.x >= 0 && b.y >= 0 && b.x+b.w <= data.width+0.1 && b.y+b.h <= data.height+0.1 && b.hit, label+' '+JSON.stringify(b));
  assert.ok(data.textHeight >= 20, label + ' usable text area');
  ledger.push({ label, disposition:'PASS', ...data });
  return data.buttons;
}
async function scrollCheck(label, selector='.tools-text-area') {
  const before = await geometry(label);
  const moved = await page.locator(selector).evaluate(el => { el.scrollTop=el.scrollHeight; return el.scrollTop; });
  assert.ok(moved > 0, label+' text scroll');
  assert.deepEqual(await geometry(label+' scrolled'), before, label+' fixed controls');
}
try {
  for (const [width,height] of [[280,300],[360,480],[420,480],[800,800]]) for (const lang of ['zh','en']) {
    await page.setViewportSize({width,height});
    await page.setContent('<div id="root"></div>');
    await page.addStyleTag({content:css});
    await page.addScriptTag({content:fixture.outputFiles[0].text});
    for (const state of ['candidate','saved','pinned','archived','deprecated','jsx','prompt']) {
      const skill = ['jsx','prompt'].includes(state);
      const label = [width,height,lang,state].join('-');
      await page.evaluate(({lang,state})=>window.reset(lang,state,state,24),{lang,state});
      if (skill) await page.getByRole('radio',{name:lang==='zh'?'技能':'Skills',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('[data-item-id]'));
      if (width<=560) await page.locator('.tools-selector').selectOption(skill?'skill:'+await page.evaluate(()=>window.item.name):'fixture');
      else await page.locator('[data-item-id]').first().click();
      await page.locator('.tools-detail__heading').waitFor({state:'attached'});
      await scrollCheck(label+' content');
      await page.getByRole('radio',{name:lang==='zh'?'参数':'Args',exact:true}).click();
      await scrollCheck(label+' args','.tools-args textarea');
      const actions = await page.locator('.tools-detail__actions button').allTextContents();
      const expected = {candidate:['沉淀','删除'],saved:['运行','置顶','归档','导出'],pinned:['运行','取消置顶','归档','导出'],archived:['恢复为已保存','删除'],deprecated:[],jsx:['渲染并复制','运行'],prompt:['渲染并复制']};
      const expectedEn = {candidate:['Promote','Delete'],saved:['Run','Pin','Archive','Export'],pinned:['Run','Unpin','Archive','Export'],archived:['Restore saved','Delete'],deprecated:[],jsx:['Render & copy','Run'],prompt:['Render & copy']};
      assert.deepEqual(actions,(lang==='zh'?expected:expectedEn)[state]);
      if (['saved','pinned','jsx','prompt'].includes(state)) {
        const run = page.locator('.tools-runner__actions button').first();
        await run.click();
        await page.waitForFunction(()=>document.querySelector('.tools-text-area pre')?.textContent.includes('rendered'));
        await scrollCheck(label+' result');
        await page.evaluate(()=>{window.fail=true;});
        await run.click();
        await page.locator('.tools-result-error').waitFor();
        await scrollCheck(label+' error');
        for (const invalid of ['{','{x']) {
          await page.getByRole('radio',{name:lang==='zh'?'参数':'Args',exact:true}).click();
          await page.locator('.tools-args textarea').fill(invalid);
          await run.click();
          await page.locator('.tools-result-error').waitFor();
          await geometry(label+' repeated invalid '+invalid);
        }
      }
      if (['saved','pinned'].includes(state)) {
        await page.getByRole('button',{name:lang==='zh'?'导出':'Export',exact:true}).click();
        await page.locator('.tools-feedback button').waitFor();
        await geometry(label+' export feedback');
      }
      await page.screenshot({path:path.join(output,label+'.png')});
    }
    await page.getByRole('button',{name:lang==='zh'?'导入':'Import',exact:true}).click();
    await page.locator('.tools-import-view textarea').fill('{'+ 'long json 长文本'.repeat(1000));
    await page.getByRole('button',{name:lang==='zh'?'导入 JSON':'Import JSON',exact:true}).click();
    await page.locator('.tools-feedback').waitFor();
    await scrollCheck([width,height,lang,'import'].join('-'), '.tools-import-view textarea');
    await page.screenshot({path:path.join(output,[width,height,lang,'import.png'].join('-'))});
    await page.getByRole('button',{name:lang==='zh'?'取消':'Cancel',exact:true}).click();
    assert.equal(await page.locator('.tools-import-view').count(),0);
  }
} catch (error) {
  ledger.push({disposition:'FAIL',error:error.message,sideEffects:'isolated browser only'});
  await page.screenshot({path:path.join(output,'failure.png')});
  throw error;
} finally {
  await fs.writeFile(path.join(output,'geometry.json'),JSON.stringify(ledger,null,2));
  await browser.close();
}
console.log(JSON.stringify({cases:ledger.length,disposition:'PASS',output}));

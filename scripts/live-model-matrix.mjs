// Live model-matrix smoke: drive both chat backends headless (no panel),
// one tiny no-tool turn per model, assert completion. Opt-in manual script:
//   node scripts/live-model-matrix.mjs
// Needs: claude login (sidecar path) + codex login. Costs a few cents total.
import { spawn } from 'node:child_process';

const CLAUDE_MODELS = ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
const CODEX_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'];
const PROMPT = '只回两个字母：ok';
const results = [];

function record(backend, model, ok, ms, detail = '') {
  results.push({ backend, model, ok, ms, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${backend} ${model} ${ms}ms ${detail}`);
}

// ---------- Claude sidecar: one process, per-turn model switch ----------
async function runClaude() {
  const child = spawn('node', ['plugin/sidecar/agent-sidecar.mjs', '--lang', 'zh'], {
    stdio: 'pipe', windowsHide: true, shell: false,
  });
  let buf = '';
  let resolveTurn = null;
  let sawText = false;
  child.stdout.on('data', (c) => {
    buf += String(c);
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const evt = msg.t === 'event' ? msg.event : null;
      if (!evt) continue;
      if (evt.type === 'text-delta' && evt.text) sawText = true;
      if ((evt.type === 'turn-end' || evt.type === 'error') && resolveTurn) {
        const r = resolveTurn; resolveTurn = null;
        r({ ok: evt.type === 'turn-end' && sawText, detail: evt.type === 'error' ? `${evt.kind}: ${String(evt.message).slice(0, 80)}` : '' });
      }
    }
  });
  for (const model of CLAUDE_MODELS) {
    sawText = false;
    const t0 = Date.now();
    const turn = new Promise((r) => { resolveTurn = r; });
    child.stdin.write(JSON.stringify({ t: 'user', text: PROMPT, permissionMode: 'none', model, effort: 'low' }) + '\n');
    const out = await Promise.race([turn, new Promise((r) => setTimeout(() => r({ ok: false, detail: 'timeout 120s' }), 120000))]);
    record('claude', model, out.ok, Date.now() - t0, out.detail);
  }
  child.kill();
}

// ---------- Codex app-server: one process, thread per model ----------
async function runCodex() {
  const child = spawn('codex', ['app-server'], { stdio: 'pipe', windowsHide: true, shell: true });
  let buf = '';
  const pending = new Map();
  let nextId = 1;
  let notif = () => {};
  const send = (method, params, timeoutMs = 60000) => {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return Promise.race([
      new Promise((r) => pending.set(id, r)),
      new Promise((_, rej) => setTimeout(() => rej(new Error(method + ' timeout')), timeoutMs)),
    ]);
  };
  child.stdout.on('data', (c) => {
    buf += String(c);
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && msg.result !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result); pending.delete(msg.id);
      } else if (msg.id !== undefined && msg.error !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)({ __error: msg.error }); pending.delete(msg.id);
      } else if (msg.method) {
        notif(msg);
      }
    }
  });
  await send('initialize', { clientInfo: { name: 'model-matrix', version: '0' }, capabilities: { experimentalApi: true } });
  for (const model of CODEX_MODELS) {
    const t0 = Date.now();
    try {
      const thread = await send('thread/start', { ephemeral: true, cwd: process.cwd(), model, approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } });
      const threadId = thread.threadId || (thread.thread && thread.thread.id);
      if (!threadId) { record('codex', model, false, Date.now() - t0, 'no threadId'); continue; }
      let sawText = false;
      const turnDone = new Promise((r) => {
        notif = (msg) => {
          if (msg.method === 'item/agentMessage/delta' && msg.params && msg.params.delta) sawText = true;
          if (msg.method === 'turn/completed') r({ ok: sawText });
          if (msg.method === 'error') r({ ok: false, detail: JSON.stringify(msg.params).slice(0, 80) });
        };
      });
      const turnAck = await send('turn/start', { threadId, input: [{ type: 'text', text: PROMPT }] }, 120000);
      if (turnAck && turnAck.__error) { record('codex', model, false, Date.now() - t0, turnAck.__error.message); continue; }
      const out = await Promise.race([turnDone, new Promise((r) => setTimeout(() => r({ ok: false, detail: 'timeout 120s' }), 120000))]);
      record('codex', model, out.ok, Date.now() - t0, out.detail || '');
    } catch (e) {
      record('codex', model, false, Date.now() - t0, String(e.message || e).slice(0, 80));
    }
  }
  child.kill();
}

await runClaude();
await runCodex();
console.log('\n=== MATRIX ===');
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.backend.padEnd(7)} ${r.model.padEnd(28)} ${String(r.ms).padStart(6)}ms ${r.detail}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);

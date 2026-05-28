/**
 * Integration test for all MCP tools via stdio transport.
 * Uses a running Electron app when MCP_CONNECT_PORT is set, otherwise starts the fixture.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const serverEntry = path.join(root, 'build', 'index.js');
const fixtureApp = path.join(root, 'fixtures', 'minimal-electron', 'main.cjs');
const connectPort = process.env.MCP_CONNECT_PORT
  ? Number.parseInt(process.env.MCP_CONNECT_PORT, 10)
  : null;

let nextId = 1;
const pending = new Map();

function sendNotification(proc, method, params = {}) {
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

function send(proc, method, params = {}) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout waiting for ${method} (id=${id})`));
    }, 120000);
    pending.set(id, { resolve, reject, timer });
  });
}

function parseResponses(proc) {
  createInterface({ input: proc.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
}

async function callTool(proc, name, args) {
  const result = await send(proc, 'tools/call', { name, arguments: args });
  const text = result?.content?.[0]?.text ?? '';
  return { text, isError: result?.isError === true };
}

function assertOk(label, { isError, text }) {
  if (isError || text.startsWith('Error:')) throw new Error(`${label} failed: ${text}`);
  console.log(`  OK: ${label}`);
  return JSON.parse(text);
}

async function resolveConnectPort(proc) {
  if (connectPort) return connectPort;
  const discovered = assertOk('discover_apps network', await callTool(proc, 'discover_apps', { scope: 'network' }));
  const ready = (discovered.endpoints || []).find((e) => e.active && e.pageTargets > 0);
  if (ready) return ready.port;
  const active = (discovered.endpoints || []).find((e) => e.active);
  if (active) {
    console.log(`  WARN: port ${active.port} active but no page targets yet`);
    return active.port;
  }
  return null;
}

async function main() {
  const proc = spawn(process.execPath, [serverEntry], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MCP_LOG_LEVEL: 'silent' },
  });
  parseResponses(proc);
  await new Promise((r) => setTimeout(r, 400));

  await send(proc, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-test', version: '1.0.0' },
  });
  sendNotification(proc, 'notifications/initialized', {});

  let appId;
  let targetId;
  let startedByTest = false;

  const port = await resolveConnectPort(proc);
  if (port) {
    console.log(`Connecting to running Electron on port ${port}...`);
    const connected = assertOk('manage_app connect', await callTool(proc, 'manage_app', { action: 'connect', port }));
    appId = connected.id;
  } else {
    console.log('No running debug port found — starting fixture app...');
    const started = assertOk(
      'manage_app start',
      await callTool(proc, 'manage_app', { action: 'start', appPath: fixtureApp, port: 9230 })
    );
    appId = started.id;
    startedByTest = true;
  }

  const managed = assertOk('discover_apps managed', await callTool(proc, 'discover_apps', { scope: 'managed' }));
  const entry = managed.managed.find((m) => m.id === appId);
  const targets = entry?.targets || [];
  const page =
    targets.find((t) => t.type === 'page' && !t.url?.startsWith('devtools://')) ||
    targets.find((t) => t.type === 'page') ||
    targets[0];
  if (!page) throw new Error(`No CDP page target for app ${appId}. Enable remote debugging and open a window.`);
  targetId = page.id;
  console.log(`  appId: ${appId}, targetId: ${targetId}, title: ${page.title || '(n/a)'}, url: ${page.url || '(n/a)'}`);

  assertOk('discover_apps all', await callTool(proc, 'discover_apps', { scope: 'all' }));
  assertOk('get_logs', await callTool(proc, 'get_logs', { appId }));
  assertOk('inspect_dom get_tree', await callTool(proc, 'inspect_dom', { appId, targetId, query: 'get_tree' }));
  assertOk(
    'inspect_dom verify_state',
    await callTool(proc, 'inspect_dom', {
      appId,
      targetId,
      query: 'verify_state',
      checks: [{ selector: 'body', exists: true }],
    })
  );

  const titleResult = assertOk(
    'execute_script document.title',
    await callTool(proc, 'execute_script', {
      appId,
      targetId,
      expression: 'document.title',
      options: { returnByValue: true },
    })
  );
  console.log(`  document.title: ${JSON.stringify(titleResult?.details?.result?.value ?? titleResult)}`);

  assertOk(
    'interact_with_dom hover body',
    await callTool(proc, 'interact_with_dom', { appId, targetId, selector: 'body', action: 'hover' })
  );

  if (startedByTest) {
    assertOk(
      'interact_with_dom click',
      await callTool(proc, 'interact_with_dom', { appId, targetId, selector: '#btn', action: 'click' })
    );
    assertOk('manage_app reload', await callTool(proc, 'manage_app', { action: 'reload', appId }));
    await new Promise((r) => setTimeout(r, 4000));
  } else {
    console.log('  SKIP: manage_app reload (external app)');
  }

  assertOk('manage_app stop', await callTool(proc, 'manage_app', { action: 'stop', appId }));

  console.log('\nAll tool tests passed.');
  proc.kill();
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err.message);
  process.exit(1);
});

// Isolated MCP browser driver for machines with Edge instead of Chrome.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
await mkdir('.dev/ui', { recursive: true });
await mkdir('.dev/browser-temp', { recursive: true });
const child = spawn(process.execPath, [resolve('node_modules/@playwright/mcp/cli.js'), '--isolated', '--headless', '--browser', 'msedge', '--output-dir', resolve('.dev/ui')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, TEMP: resolve('.dev/browser-temp'), TMP: resolve('.dev/browser-temp') } });
let next = 0;
const pending = new Map();
createInterface({ input: child.stdout }).on('line', line => {
  try { const value = JSON.parse(line); if (value.id !== undefined) { const task = pending.get(value.id); pending.delete(value.id); if (value.error) task?.reject(value.error); else task?.resolve(value.result); } } catch {}
});
child.stderr.on('data', data => process.stderr.write(data));
function request(method, params) { const id = ++next; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }); }
await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'redmine-ui-check', version: '1.0.0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
console.log(JSON.stringify((await request('tools/list', {})).tools.map(t => t.name)));
for await (const line of createInterface({ input: process.stdin })) {
  try {
    const { tool, args = {} } = JSON.parse(line);
    const result = await request('tools/call', { name: tool, arguments: args });
    for (const item of result.content ?? []) {
      if (item.type === 'image') { const path = resolve('.dev/ui/latest.png'); await writeFile(path, Buffer.from(item.data, 'base64')); console.log(`IMAGE ${path}`); }
      else if (item.type === 'text') console.log(item.text);
    }
  } catch (error) { console.log(JSON.stringify({ error: String(error) })); }
}
child.kill();

// Codex launches this configured MCP server in its own runtime. It keeps one
// private desktop bridge per user; it does not launch an agent or a model.
import readline from 'node:readline';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { startHost } from './native-host.mjs';
const root = join(homedir(), '.local/state/native-desktop-bridge');
const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
let server, acquiring = false;
async function ensure() {
  if (server || acquiring) return;
  acquiring = true;
  try { server = await startHost({ socketPath: join(root, 'host.sock'), callerThreadId: config.callerThreadId, claudeSessionDirectory: config.claudeSessionDirectory }); }
  catch (error) {
    if (/already running|EADDRINUSE/.test(error.message) && typeof process.execve === 'function') process.execve('/usr/bin/perl', ['/usr/bin/perl', join(homedir(), '.local/lib/native-desktop-bridge/native-mcp.pl')], process.env);
    else process.stderr.write(`Desktop bridge: ${error.message}\n`);
  }
  finally { acquiring = false; }
}
await ensure();
const parentPid = process.ppid;
const interval = setInterval(() => {
  // Keep the original desktop App as the trusted parent; do not become an orphan daemon.
  if (process.ppid !== parentPid) process.exit(0);
  void ensure();
}, 10000); interval.unref();
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (!Object.hasOwn(request, 'id')) return;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'native-desktop-bridge', version: '0.1.0' } };
  else if (request.method === 'tools/list') result = { tools: [] };
  else if (request.method === 'ping') result = {};
  else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); return; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
// A chat's MCP transport can close while the desktop and remote reader remain active.
// The singleton host serves all chats and must outlive that one transport.
input.on('close', () => { if (!server) process.exit(0); });

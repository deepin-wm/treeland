#!/usr/bin/env node
// Copyright (C) 2026 UnionTech Software Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0 OR LGPL-3.0-only OR GPL-2.0-only OR GPL-3.0-only
//
// Smoke test for the treeland-debug MCP server. Spawns mcp-server.mjs with a
// stub TREELAND_DEBUG_BIN (a node script pretending to be the treeland-debug
// CLI), drives the stdio JSON-RPC protocol and asserts the responses.
//
// Run: node test-mcp.mjs  (from tools/treeland-debug/mcp/)

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// --- stub treeland-debug CLI ----------------------------------------------
const stubDir = mkdtempSync(join(tmpdir(), 'tdbg-stub-'));
const stub = join(stubDir, 'treeland-debug');
writeFileSync(stub, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
// skip option/value pairs (--url X --timeout-ms N --json) to find the command verb
let i = 0;
while (i < args.length && args[i].startsWith('-')) {
  if (args[i] === '--url' || args[i] === '--timeout-ms') i += 2; else i += 1;
}
const cmd = args[i], rest = args.slice(i + 1);
if (cmd === 'windows' || cmd === 'tree') {
  console.log(JSON.stringify(cmd === 'windows'
    ? [{ id: 1, appId: 'dde-file-manager', title: 'Files', active: true, geometry: { x: 0, y: 0, width: 800, height: 600 } }]
    : { root: { children: [] } }));
  process.exit(0);
}
if (cmd === 'cursor') { console.log('{ "x": 320, "y": 240 }'); process.exit(0); }
if (cmd === 'clients') { console.log('[]'); process.exit(0); }
if (cmd === 'scene') { console.log('scene-dump-text'); process.exit(0); }
if (cmd === 'activate') { console.log('ok'); process.exit(0); }
if (cmd === 'event') {
  if (rest[0] === 'key' && rest[1] === 'Return') { console.log('ok'); process.exit(0); }
  process.exit(1);
}
if (cmd === 'screenshot') {
  const file = rest[rest.length - 1];
  fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')); // minimal PNG header
  console.log(file);
  process.exit(0);
}
console.error('treeland-debug: unknown command ' + cmd);
process.exit(1);
`);
chmodSync(stub, 0o755);

// --- drive the MCP server --------------------------------------------------
const server = spawn(process.execPath, [join(import.meta.dirname, 'mcp-server.mjs')], {
    env: { ...process.env, TREELAND_DEBUG_BIN: stub },
    stdio: ['pipe', 'pipe', 'inherit'],
});
let buf = '';
let idCounter = 0;
const pending = new Map();

server.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line)
            continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
        }
    }
});

function request(method, params) {
    const id = ++idCounter;
    return new Promise((resolve, reject) => {
        pending.set(id, resolve);
        server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 5000);
    });
}

let asserted = 0;
const check = (name, cond) => { assert.ok(cond, name); asserted++; };

try {
    // initialize handshake
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } });
    check('initialize result protocolVersion', init.result.protocolVersion === '2025-06-18');
    check('initialize capabilities.tools', !!init.result.capabilities.tools);

    // tools/list covers the full surface
    const list = await request('tools/list', {});
    const names = list.result.tools.map(t => t.name);
    for (const n of ['tree', 'cursor', 'windows', 'clients', 'focused', 'scene', 'activate', 'close',
                     'minimize', 'maximize', 'fullscreen', 'move', 'resize', 'workspace', 'move_cursor',
                     'event_motion', 'event_button', 'event_key', 'screenshot_output', 'screenshot_window'])
        check(`tool ${n} listed`, names.includes(n));

    // inspection call → parsed JSON text
    const w = await request('tools/call', { name: 'windows', arguments: {} });
    check('windows ok', w.result.content[0].text.includes('dde-file-manager'));

    // focused derived from windows active flag
    const f = await request('tools/call', { name: 'focused', arguments: {} });
    check('focused ok', JSON.parse(f.result.content[0].text).appId === 'dde-file-manager');

    // window control passes args through
    const act = await request('tools/call', { name: 'activate', arguments: { target: 'dde-file-manager' } });
    check('activate ok', act.result.content[0].text === 'ok');

    // event key args land as expected
    const key = await request('tools/call', { name: 'event_key', arguments: { key: 'Return' } });
    check('event_key ok', key.result.content[0].text === 'ok');

    // failure → isError
    const bad = await request('tools/call', { name: 'event_key', arguments: { key: 'NoSuchKey' } });
    check('error isError', bad.result.isError === true);

    // unknown tool → JSON-RPC error
    const unknown = await request('tools/call', { name: 'nope', arguments: {} });
    check('unknown tool error', unknown.error && unknown.error.code === -32602);

    // screenshot → image content block with base64 PNG
    const shot = await request('tools/call', { name: 'screenshot_window', arguments: { target: 1 } });
    const img = shot.result.content.find(c => c.type === 'image');
    check('screenshot image block', !!img);
    check('screenshot mime', img.mimeType === 'image/png');
    check('screenshot png magic', Buffer.from(img.data, 'base64').subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));

    console.log(`PASS: ${asserted} assertions`);
    server.kill();
    rmSync(stubDir, { recursive: true, force: true });
    process.exit(0);
} catch (e) {
    console.error('FAIL:', e.message);
    server.kill();
    rmSync(stubDir, { recursive: true, force: true });
    process.exit(1);
}
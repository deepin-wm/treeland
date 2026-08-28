#!/usr/bin/env node
// Copyright (C) 2026 UnionTech Software Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0 OR LGPL-3.0-only OR GPL-2.0-only OR GPL-3.0-only
//
// treeland-debug MCP server (Model Context Protocol, stdio transport).
//
// Zero-dependency Node.js server that exposes the treeland-debug CLI to AI
// clients as MCP tools. Every tool call maps to one one-shot
// `treeland-debug <command>` invocation against the running compositor's
// debug Remote Object, so it reuses the whole, already-tested CLI surface and
// consumes no compositor-side resources while idle.
//
// Configuration (environment variables):
//   TREELAND_DEBUG_BIN          binary to invoke (default: treeland-debug)
//   TREELAND_DEBUG_SUDO_USER    when set, run via `sudo -u <user> -- <bin>`
//                               (e.g. dde for a global treeland service)
//   TREELAND_DEBUG_URL          --url value for the remote object host
//   TREELAND_DEBUG_TIMEOUT_MS   per-request timeout (default: 30000)
//
// Protocol: newline-delimited JSON-RPC 2.0 over stdin/stdout. Logging goes to
// stderr only — stdout is reserved for the protocol.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

const SERVER_INFO = { name: 'treeland-debug', version: '1.0.0' };
const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// CLI invocation
// ---------------------------------------------------------------------------

function baseCommand() {
    const bin = process.env.TREELAND_DEBUG_BIN || 'treeland-debug';
    const sudoUser = process.env.TREELAND_DEBUG_SUDO_USER;
    const base = sudoUser ? ['sudo', '-u', sudoUser, '--', bin] : [bin];
    const url = process.env.TREELAND_DEBUG_URL;
    const timeout = parseInt(process.env.TREELAND_DEBUG_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS;
    return { base, url, timeout };
}

function runCli(extraArgs, { json = false, noPreview = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const { base, url } = baseCommand();
    const args = [];
    if (url)
        args.push('--url', url);
    args.push('--timeout-ms', String(timeoutMs));
    if (json)
        args.push('--json');
    if (noPreview)
        args.push('--no-preview');
    args.push(...extraArgs);

    return new Promise((resolve) => {
        const child = spawn(base[0], [...base.slice(1), ...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 15000);
        child.on('close', (code) => {
            clearTimeout(killer);
            resolve({ code: code ?? 1, stdout, stderr });
        });
        child.on('error', (err) => {
            clearTimeout(killer);
            resolve({ code: 1, stdout: '', stderr: String(err) });
        });
    });
}

function prettyJson(raw) {
    try {
        return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
        return raw;
    }
}

function textResult(text, isError = false) {
    return { content: [{ type: 'text', text: String(text).trim() || '(no output)' }], isError };
}

function cliResult(r, json) {
    if (r.code !== 0)
        return textResult((r.stderr || r.stdout).trim() || `treeland-debug exited with ${r.code}`, true);
    return textResult(json ? prettyJson(r.stdout) : r.stdout);
}

// Screenshots: the CLI writes PNG bytes to a file we choose; read them back,
// return the image inline (base64) so the AI can see it directly.
async function screenshotResult(cliArgs) {
    const tmp = join(tmpdir(), `treeland-debug-mcp-${randomBytes(6).toString('hex')}.png`);
    const r = await runCli([...cliArgs, tmp], { noPreview: true });
    if (r.code !== 0)
        return textResult((r.stderr || r.stdout).trim() || `treeland-debug exited with ${r.code}`, true);
    try {
        const data = await readFile(tmp);
        await unlink(tmp).catch(() => {});
        return {
            content: [
                { type: 'image', data: data.toString('base64'), mimeType: 'image/png' },
                { type: 'text', text: r.stdout.trim() || 'screenshot captured' },
            ],
        };
    } catch (e) {
        return textResult(`failed to read screenshot: ${e}`, true);
    }
}

// `focused` has no CLI subcommand (it only exists in the HTTP API); derive it
// from `windows --json` (the active flag).
async function focusedResult() {
    const r = await runCli(['windows'], { json: true });
    if (r.code !== 0)
        return textResult((r.stderr || r.stdout).trim() || `treeland-debug exited with ${r.code}`, true);
    try {
        const list = JSON.parse(r.stdout);
        const focused = (list || []).find((w) => w.active) || null;
        return textResult(JSON.stringify(focused, null, 2));
    } catch (e) {
        return textResult(`failed to parse windows JSON: ${e}`, true);
    }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const target = {
    type: 'string',
    description: 'Window target: numeric id (from `windows`) or appId (first match).',
};

const T = (name, description, inputSchema, argsFn, opts = {}) => ({
    name,
    description,
    inputSchema: { type: 'object', properties: inputSchema.properties, required: inputSchema.required || [], additionalProperties: false },
    argsFn,
    ...opts,
});

const tools = [
    // ---- inspection ----
    T('tree', 'Print the complete layout window tree as JSON.', {}, () => ['tree'], { json: true }),
    T('cursor', 'Print the current cursor position.', {}, () => ['cursor'], { json: true }),
    T('windows', 'List all toplevel windows as JSON (id, appId, title, geometry, state, active, ...).', {}, () => ['windows'], { json: true }),
    T('clients', 'List connected Wayland clients and the windows each owns (with pid/executable/command).', {}, () => ['clients'], { json: true }),
    T('focused', 'Return the currently focused (active) window, or null.', {}, () => [], { derive: 'focused' }),
    T('scene', 'Dump the QtQuick scene tree of one window (by id/appId) or, without a target, the whole render scene.', {
        properties: { target: { ...target, description: 'Optional window id or appId to dump; omit for the whole scene.' } },
    }, (a) => ['scene', ...(a.target ? [a.target] : [])]),

    // ---- window control ----
    T('activate', 'Activate (focus) a window.', { properties: { target } }, (a) => ['activate', a.target]),
    T('close', 'Close a window.', { properties: { target } }, (a) => ['close', a.target]),
    T('minimize', 'Minimize a window.', { properties: { target } }, (a) => ['minimize', a.target]),
    T('maximize', 'Toggle maximized state of a window.', { properties: { target } }, (a) => ['maximize', a.target]),
    T('fullscreen', 'Toggle fullscreen state of a window.', { properties: { target } }, (a) => ['fullscreen', a.target]),
    T('move', 'Move a window to (x, y).', {
        properties: { target, x: { type: 'number' }, y: { type: 'number' } },
        required: ['target', 'x', 'y'],
    }, (a) => ['move', a.target, String(a.x), String(a.y)]),
    T('resize', 'Resize a window to (width, height).', {
        properties: { target, width: { type: 'number' }, height: { type: 'number' } },
        required: ['target', 'width', 'height'],
    }, (a) => ['resize', a.target, String(a.width), String(a.height)]),
    T('workspace', 'Move a window to a workspace.', {
        properties: { target, workspaceId: { type: 'number' } },
        required: ['target', 'workspaceId'],
    }, (a) => ['workspace', a.target, String(a.workspaceId)]),

    // ---- input injection ----
    T('move_cursor', 'Move the cursor to (x, y).', {
        properties: { x: { type: 'number' }, y: { type: 'number' } },
        required: ['x', 'y'],
    }, (a) => ['move-cursor', String(a.x), String(a.y)]),
    T('event_motion', 'Pointer motion to (x, y).', {
        properties: { x: { type: 'number' }, y: { type: 'number' } },
        required: ['x', 'y'],
    }, (a) => ['event', 'motion', String(a.x), String(a.y)]),
    T('event_button', 'Send a pointer button event. Button: left|right|middle|code; action: press|release|click (default click).', {
        properties: {
            button: { type: 'string', description: 'left, right, middle, or a numeric Linux input code.' },
            action: { type: 'string', enum: ['press', 'release', 'click'], description: 'Default: click.' },
        },
        required: ['button'],
    }, (a) => ['event', 'button', a.button, a.action || 'click']),
    T('event_key', 'Send a keyboard event. Key: Qt::Key name (Escape, Return, Space, ...) or raw evdev code; action: press|release|tap (default tap).', {
        properties: {
            key: { type: 'string', description: "Key name (Qt::Key enum) or raw evdev keycode, e.g. 'Return', 'Escape', 'a'." },
            action: { type: 'string', enum: ['press', 'release', 'tap'], description: 'Default: tap.' },
        },
        required: ['key'],
    }, (a) => ['event', 'key', a.key, a.action || 'tap']),

    // ---- image capture ----
    T('screenshot_output', 'Grab an output as a PNG image (by id/name; primary output if omitted). Returns the image inline.', {
        properties: { name: { type: 'string', description: 'Optional output id or name; defaults to the primary output.' } },
    }, (a) => ['screenshot', 'output', a.name ?? ''], { kind: 'screenshot' }),
    T('screenshot_window', 'Grab a single window as a PNG image. Returns the image inline.', {
        properties: { target },
        required: ['target'],
    }, (a) => ['screenshot', 'window', a.target], { kind: 'screenshot' }),
];

// ---------------------------------------------------------------------------
// JSON-RPC handling
// ---------------------------------------------------------------------------

function send(id, result) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function sendError(id, code, message) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function handleCall(msg) {
    const { name, arguments: args } = msg.params || {};
    const tool = tools.find((t) => t.name === name);
    if (!tool)
        return sendError(msg.id, -32602, `Unknown tool: ${name}`);
    try {
        const a = args || {};
        let result;
        if (tool.kind === 'screenshot')
            result = await screenshotResult(tool.argsFn(a));
        else if (tool.derive === 'focused')
            result = await focusedResult();
        else
            result = cliResult(await runCli(tool.argsFn(a), { json: !!tool.json }), !!tool.json);
        send(msg.id, result);
    } catch (e) {
        sendError(msg.id, -32603, `tool ${name} failed: ${e}`);
    }
}

async function handle(msg) {
    switch (msg.method) {
    case 'initialize': {
        const pv = msg.params && typeof msg.params.protocolVersion === 'string'
            ? msg.params.protocolVersion
            : PROTOCOL_VERSION;
        send(msg.id, { protocolVersion: pv, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
        break;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
        break; // notification — no response
    case 'ping':
        send(msg.id, {});
        break;
    case 'tools/list':
        send(msg.id, {
            tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
        break;
    case 'tools/call':
        await handleCall(msg);
        break;
    default:
        sendError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed)
        return;
    let msg;
    try {
        msg = JSON.parse(trimmed);
    } catch {
        return; // not JSON — ignore
    }
    handle(msg).catch((e) => { if (msg.id !== undefined) sendError(msg.id, -32603, String(e)); });
});
rl.on('close', () => process.exit(0));
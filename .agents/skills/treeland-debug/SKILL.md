---
name: treeland-debug
description: Use this skill whenever a task asks you to debug, diagnose, reproduce, or analyze a problem in the running treeland compositor — window/workspace/input/output/rendering issues, crashes, hangs, focus problems, or requests to inspect live state. Trigger on `treeland-debug`, `debugSource`, `WindowTree` Remote Object, `QT_LOGGING_RULES`, treeland logging categories, `journalctl` for treeland, `org.deepin.Compositor1`, window tree inspection, input event injection, or screenshot capture from a live compositor. Pair with the systematic-debugging approach: reproduce, isolate, then fix at the root cause.
---

# Treeland Debug

## Scope
This skill tells you how to inspect and control a **running** treeland compositor to debug it. Use it when the problem is observable at runtime (wrong window state, focus/activation, input not landing, missing/blank output, crashes, hangs, performance). For build/test problems see `AGENTS.md` Build & Test; for protocol integration see the protocol skills; for DConfig see `treeland-dconfig-configuration`.

Primary repos and where things live:

- `src/core/` — lifecycle, QML engine glue (`src/core/qmlengine.*`, `src/core/treeland.*`).
- `src/surface/` — surface/window wrappers, state, visibility, geometry (`surfacewrapper.cpp`).
- `src/seat/` — seat management, `Helper` initialization hub, protocol wiring (`seat/helper.*`).
- `src/workspace/` — workspace model and switching.
- `src/modules/` — feature modules (window-management, input-manager, output-manager, dde-shell, …).
- `src/plugins/` + `src/effects/` — plugin & effect integration.
- `src/common/treelandlogging.*` — centralized logging categories.
- `waylib/` — the wlroots+QtQuick compositor framework underneath (outputs <-> `QQuickWindow`, surfaces <-> `QQuickItem`).
- `wlroots/` + `3rdparty/wlroots/` — vendored wlroots (raw C API via `<wlr_all.h>`).
- `tools/treeland-debug/` — the CLI you use to inspect/control the live compositor.

## Runtime context
treeland runs in two modes:

- **Global mode** (preferred, on DDM): one process manages all users; it runs as the **`dde`** user under systemd user service `treeland.service`, bus name `org.deepin.Compositor1`. `ExecStart=.../treeland.sh --lockscreen`.
- **User mode**: starts per-user as a normal window manager.

Because of global mode, most runtime debugging commands must run **as the `dde` user**: `sudo -u dde -- <cmd>`. The debug Remote Object's local socket is owner-only, so a non-`dde` user cannot connect.

## Enable the debug source (first step)
The `WindowTree` debug Remote Object is **off by default**. Turn it on once, then restart treeland:

```bash
sudo -u dde -- dde-dconfig set \
  -a org.deepin.dde.treeland \
  -r org.deepin.dde.treeland \
  -k debugSource \
  -v true
```

Restart treeland (or reboot/relogin) after changing it. `treeland-debug` connects to `local:org.deepin.dde.treeland.debug` object `WindowTree`.

## treeland-debug CLI
`treeland-debug` is an adb-style inspector/controller. Two modes: one-shot `treeland-debug <cmd> [args]` and REPL `treeland-debug shell`. Run every command as `dde`. `--json` gives machine-readable output for `tree`/`cursor`/`windows`/`clients`.

Global options: `--url <url>` (default `local:org.deepin.dde.treeland.debug`), `--name <name>` (default `WindowTree`), `--timeout-ms <n>` (default 30000), `--json`.

### Inspect
| Command | Output |
| --- | --- |
| `tree` | Full layout tree (JSON by default). `{"currentMode", "layers":[{name,layer,windows,workspaces:[{id,isActive,windows}]}]}` |
| `cursor` | Cursor position `{"x","y"}`. |
| `windows` | Toplevel windows table / JSON array. |
| `clients` | Clients + their windows (incl. `pid`, `executable`, `command`). |
| `top [interval-ms]` | Live `top`-like clients/windows view (Ctrl+C to quit). |
| `scene [id]` | QtQuick scene tree of one window (by id/appId) or the whole scene — for menus/popups/decorations not in the layout `tree`. |

Every window has a stable numeric `id` (and an `appId`); either is accepted by all control commands. Use `windows`/`clients`/`top` to discover ids.

### Window control
`activate`, `close`, `minimize`, `maximize`, `fullscreen`, `move <id> <x> <y>`, `resize <id> <w> <h>`, `workspace <id> <ws-id>`. Each prints `ok`/`failed`.

### Input injection
`move-cursor <x> <y>`, `event motion <x> <y>`, `event button <btn> [press|release|click]`, `event key <key> [press|release|tap]`. Pointer buttons use Linux input codes (`left`=0x110, `right`=0x111, `middle`=0x112); keys use Linux evdev keycodes or common names (`enter`, `esc`, `space`, `a`–`z`, `0`–`9`, `f1`–`f12`, arrows). Keys go to the **keyboard-focused** surface — `activate` a window first; pointer buttons go to the surface under the cursor — move the cursor there first.

### Screenshot
`screenshot output [name] [file]` and `screenshot window <id> [file]`. Rendered server-side, PNG bytes returned to the client, which writes the file and prints the path (auto path under `/tmp` if `file` omitted).

### Shell / listen
`shell` — interactive REPL. `listen [--port <p>] [--host <a>]` — HTTP/WebSocket server exposing the same capabilities for a browser frontend (`/api/*`, `ws://host:port/ws`). See `tools/treeland-debug/README.md` for the full REST/WS reference.

### Quick start
```bash
# enable once (then restart treeland)
sudo -u dde -- dde-dconfig set -a org.deepin.dde.treeland -r org.deepin.dde.treeland -k debugSource -v true

# inspect
sudo -u dde -- treeland-debug tree
sudo -u dde -- treeland-debug --json windows
sudo -u dde -- treeland-debug clients

# control
sudo -u dde -- treeland-debug activate dde-file-manager
sudo -u dde -- treeland-debug maximize 93824992268800
sudo -u dde -- treeland-debug close dde-file-manager

# inject input
sudo -u dde -- treeland-debug event key enter tap
sudo -u dde -- treeland-debug event button left click

# screenshot
sudo -u dde -- treeland-debug screenshot output /tmp/ss.png
sudo -u dde -- treeland-debug screenshot window 93824992268800
```

## Reading logs
treeland uses Qt logging categories, all centralized in `src/common/treelandlogging.*`. Category string ids follow `treeland.<module>[.<submodule>]` (e.g. `treeland.surface`, `treeland.input`, `treeland.workspace`, `treeland.output`, `treeland.seat`, `treeland.protocol`, `treeland.wallpaper`, `treeland.xwayland`, `treeland.shell.xdg`, `treeland.popup.focus`). waylib categories are in `waylib/src/server/wayliblogging.*` with ids `waylib.*`.

Control log verbosity with `QT_LOGGING_RULES`. In global mode, set it for the `treeland.service` user unit:

```bash
systemctl --user set-environment QT_LOGGING_RULES='treeland.surface.debug=true;treeland.input.debug=true'
```

To get logs out of a running global treeland, use journalctl filtered by the unit and user:

```bash
# recent logs from the global treeland service (runs as dde)
journalctl --user -u treeland.service -n 200 --no-pager
# or with full verbosity + follow
journalctl --user -u treeland.service -f
```

`treeland.sh` wrapper: on startup it checks `--try-exec`; if it fails with `failed to create dri2 screen` it falls back to `WLR_RENDERER=pixman` software rendering (VirtualBox without 3D). If a bug only reproduces with the hardware renderer, note that fallback may mask it.

## Diagnostic workflows
Start from the symptom and pick the smallest reliable check. Reproduce first, then isolate the layer (treeland vs waylib vs wlroots vs client).

**Wrong window state (max/min/fullscreen/tiling, geometry, visibility):**
1. `sudo -u dde -- treeland-debug --json windows` — read `state`, `visible`, `active`, `geometry`, `workspace`, `layer`, `frames`, `damage` for the target window (match by `appId`).
2. `treeland-debug tree` — confirm which layer/workspace the window sits in.
3. `treeland-debug scene <id>` — if the layout looks right but rendering is wrong, check the QtQuick scene (menus/popups/decorations).
4. Cross-check with logs: `QT_LOGGING_RULES='treeland.surface.debug=true;treeland.workspace.debug=true'`.

**Focus / activation wrong:**
1. `treeland-debug --json windows` — check `active` flags; `treeland-debug cursor` and `treeland-debug --json cursor-window` (HTTP API only) to see what's under the cursor.
2. `treeland-debug activate <id|appId>` and re-check.
3. Relevant categories: `treeland.seat`, `treeland.popup.focus`, `treeland.activation`.

**Input not landing / wrong target:**
1. `treeland-debug move-cursor <x> <y>` then `treeland-debug event button left click`; `treeland-debug event key enter tap`.
2. Confirm pointer/keyboard focus via `windows` (`active`) — keys go to keyboard-focused surface, buttons to surface under cursor.
3. Categories: `treeland.input`, `treeland.seat`, `waylib.input.pointer`, `waylib.seat`. Check seatd: `sudo journalctl -u dde-seatd -f` and that `LIBSEAT_BACKEND=seatd`/`SEATD_SOCK=/run/dde-seatd.sock` are set (see `misc/systemd/treeland.service.in`).

**Output blank / missing / wrong resolution:**
1. `treeland-debug tree` — confirm outputs present; `treeland-debug --json windows` per-output.
2. `treeland-debug screenshot output <name> <file>` to see what the compositor actually renders.
3. Categories: `treeland.output`, `waylib.output`, `waylib.output.drm`. If hardware rendering fails, the `treeland.sh` pixman fallback is active.

**Crash / hang:**
1. Check service state and restart logs: `journalctl --user -u treeland.service -n 200 --no-pager`.
2. If ASAN is enabled, logs go to `/tmp/treeland-asan*` files, not journalctl (see `treeland.service.in`).
3. Reproduce with minimal steps using `treeland-debug` (inject events, activate/close windows) and note the last actions before the crash.
4. For hangs, use `top`/`clients` to see if a client is stuck, and gdb attach (`sudo -u dde -- gdb -p <pid>`) if needed.

**Client-side suspicion:** check the client's pid via `treeland-debug clients`; verify the client is actually talking to the compositor (its `windows`, `frames` incrementing). A frozen client will show `frames` not advancing.

## Rules
- Run all live commands as `dde` (`sudo -u dde --`). The debug socket is owner-only.
- Use `--json` for machine-readable state you need to parse; use `windows`/`clients`/`top` to discover stable window ids before controlling them.
- Screenshots are a strong ground truth: if the layout `tree` is right but the image is wrong, the issue is in rendering/QtQuick scene, not layout.
- Prefer root-cause fixes; the live tool is for observation and reproduction, not a substitute for reading the code path that owns the failing state.
- When a runtime change is needed, prefer the appropriate skill: logging changes -> `logging-guidelines`; DConfig -> `treeland-dconfig-configuration`; protocol -> protocol skills.

## Verification
If your fix is code, build it (see `AGENTS.md`) and re-run the same `treeland-debug` inspection to confirm the live state now matches the expectation. If the fix changed observable behavior, state which `treeland-debug` command confirms it.

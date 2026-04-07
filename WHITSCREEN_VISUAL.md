# Visual Analysis: White Screen Issue

## Timeline of Events

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ USER CLICKS "SAVE CONFIG" BUTTON                                            │
└─────────────────────────┬───────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ RENDERER PROCESS (React/ConfigStep)                                         │
│ ┌───────────────────────────────────────────────────────────────────────┐   │
│ │ handleSave()                                                          │   │
│ │ - setSaving(true)                                                     │   │
│ │ - clearLogs()                                                         │   │
│ │ - clearTerminal()                                                     │   │
│ │ - Calls: window.electronAPI.onboard.run(config)                       │   │
│ └───────────────────────┬───────────────────────────────────────────────┘   │
└─────────────────────────┼───────────────────────────────────────────────────┘
                          │
                          ▼ (IPC Call)
┌─────────────────────────────────────────────────────────────────────────────┐
│ MAIN PROCESS (Electron)                                                     │
│ ┌───────────────────────────────────────────────────────────────────────┐   │
│ │ ipcMain.handle('onboard:run', async (event, config) => {             │   │
│ │   const result = await runOnboard(win(), config)                      │   │
│ │   return { success: true, botUsername: result.botUsername }           │   │
│ │ })                                                                    │   │
│ └───────────────────────┬───────────────────────────────────────────────┘   │
└─────────────────────────┼───────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ runOnboard() in onboarder.ts                                                │
│ [Sets up logging, reads config, etc.]                                       │
│ ┌───────────────────────────────────────────────────────────────────────┐   │
│ │ await runOneClickChannelSetup(win, config, runCmd, log, ocBin)        │   │
│ └───────────────────────┬───────────────────────────────────────────────┘   │
└─────────────────────────┼───────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ runOneClickChannelSetup() in onboarder.ts (Line 576)                        │
│ - Detects: channelType === 'wechat' and platform() === 'darwin'             │
│ ┌───────────────────────────────────────────────────────────────────────┐   │
│ │ try {                                                                 │   │
│ │   await runEmbeddedMacPtyScript(win, 'EasyClaw 微信渠道安装', ...)   │   │
│ │ } catch {                                                             │   │
│ │   // FALLS BACK HERE IF CRASH HAPPENS                                │   │
│ │   await runMacTerminalScript('EasyClaw 微信渠道安装', ...)            │   │
│ │ }                                                                     │   │
│ └───────────────────────┬───────────────────────────────────────────────┘   │
└─────────────────────────┼───────────────────────────────────────────────────┘
                          │
        ┌─────────────────┴──────────────────┐
        │                                    │
        ▼ (TRY)                             ▼ (CATCH - fallback)
┌─────────────────────────────────────────┐ ┌──────────────────────────────────┐
│ runEmbeddedMacPtyScript()                 │ │ runMacTerminalScript()            │
│ (Lines 503-565)                          │ │ (Lines 439-501)                  │
│                                          │ │                                  │
│ ┌────────────────────────────────────┐   │ │ ┌──────────────────────────────┐ │
│ │ spawn('script', [                  │   │ │ │ spawn('osascript', [         │ │
│ │   '-q',                            │   │ │ │   '-e',                      │ │
│ │   '/dev/null',                     │   │ │ │   'tell application...       │ │
│ │   'bash',                          │   │ │ │   activate Terminal'         │ │
│ │   scriptPath                       │   │ │ │ ])                           │ │
│ │ ], { env })                        │   │ │ └──────────────────────────────┘ │
│ │                                    │   │ │                                  │
│ │ PROBLEMS:                          │   │ │ PROBLEMS:                        │
│ │ ❌ Wrong tool (PTY recording)       │   │ │ ❌ Opens External Terminal.app    │
│ │ ❌ Environment conflict             │   │ │ ❌ Steals window focus           │
│ │ ❌ Resource/signal issues          │   │ │ ❌ Looks like white screen       │
│ │ ❌ No timeout                      │   │ │ ❌ No embedded output            │
│ │ ❌ SIGKILL received (exit 9)       │   │ │ ❌ Can't detect QR scanning      │
│ └────────────────────────────────────┘   │ │ └──────────────────────────────┘ │
└─────────────────────────────────────────┘ └──────────────────────────────────┘
        │ (CRASH)                                │ (Opens external app)
        ▼                                        ▼
┌─────────────────────────────────────────┐ ┌──────────────────────────────────┐
│ RENDERER PROCESS KILLED                  │ │ USER SEES WHITE SCREEN           │
│                                          │ │                                  │
│ render-process-gone {                    │ │ Terminal.app window took focus   │
│   reason: 'killed',                      │ │ ConfigStep is hidden behind it    │
│   exitCode: 9                            │ │ or shows blank white window       │
│ }                                        │ │                                  │
│                                          │ │ User sees:                       │
│ WHITE SCREEN SHOWN TO USER ❌            │ │ - White screen (no UI)           │
│                                          │ │ - No terminal output visible     │
│                                          │ │ - No progress indicator          │
│                                          │ │ - Can't monitor QR code          │
│                                          │ │                                  │
└─────────────────────────────────────────┘ └──────────────────────────────────┘
```

---

## Process Signal Flow

```
When spawn('script', ...) crashes:

┌──────────────┐
│ script child │  ← Gets signal or crashes
│  process     │
└──────┬───────┘
       │ SIGKILL (exit 9)
       ▼
┌──────────────────────────┐
│ Process Group            │ ← Signal propagates
│ (Parent + Children)      │   to entire group
└──────┬───────────────────┘
       │ Can propagate to parent (bash)
       │ Can affect renderer process group
       ▼
┌────────────────────────────────┐
│ Renderer Process Killed ❌     │
│ render-process-gone {          │
│   reason: 'killed',            │
│   exitCode: 9                  │
│ }                              │
└────────────────────────────────┘
       │
       ▼
┌────────────────────────────┐
│ WHITE SCREEN DISPLAYED ❌  │
└────────────────────────────┘
```

---

## Environment Variable Issue

```
┌─────────────────────────────────────────────────────────────────┐
│ Electron Process Environment (inherited by child)               │
├─────────────────────────────────────────────────────────────────┤
│ PATH=/usr/local/bin:/usr/bin:...                                │
│ npm_config_prefix=/path/to/npm                                  │
│ npm_config_cache=/path/to/cache                                 │
│ V8_PLATFORM_ARCH=x64          ← These cause problems             │
│ V8_PLATFORM_OS=mac            ← with `script` command            │
│ NODE_CHANNEL_FD=12            ← Broken pipe references           │
│ ELECTRON_RUN_AS_NODE=1        ← Wrong semantics                 │
│ ... (many more)                                                  │
└─────────────────────────────────────────────────────────────────┘
       │
       ▼ Passed to spawn('script', ...)
┌─────────────────────────────────────────────────────────────────┐
│ script Command (POSIX tool designed for terminal session recording)
│                                                                  │
│ Expects:                        Gets:                           │
│ • Simple shell environment      • Electron V8 environment       │
│ • Normal shell variables        • Module paths                  │
│ • User-level vars only          • Node-specific vars            │
│                                                                  │
│ Result: SIGKILL (exit 9) ❌                                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## IPC Stream Flow (CURRENTLY WORKS, BUT BLOCKED BY CRASH)

```
┌────────────────────────────────────────────────────────────────────────┐
│ Child Process Output                                                    │
│ (if it didn't crash)                                                    │
│                                                                         │
│ stdout: "$ npx -y @tencent-weixin/..."                                 │
│ stderr: (none)                                                          │
│ ...waiting for QR code...                                              │
│ stdout: "✓ QR Code Scanned!"                                           │
└────────────────────┬──────────────────────────────────────────────────┘
                     │ child.stdout.on('data', ...)
                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│ createTerminalOutputEmitter() - WORKS PERFECTLY                        │
│                                                                        │
│ - Batches output                                                       │
│ - Checks window safety                                                 │
│ - Sends via IPC                                                        │
└────────────────────┬───────────────────────────────────────────────────┘
                     │ win.webContents.send('terminal:output', chunk)
                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Renderer Process - IPC Listener                                        │
│ (In useTerminalStream hook)                                            │
│                                                                        │
│ window.electronAPI.terminal.onOutput((chunk) => {                      │
│   outputRef.current += chunk                                           │
│   setOutput(outputRef.current)                                         │
│ })                                                                     │
└────────────────────┬───────────────────────────────────────────────────┘
                     │ State update
                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│ EmbeddedTerminal Component                                              │
│                                                                        │
│ <div className="h-72 overflow-auto">                                  │
│   {content || '终端输出将在这里显示...'}                              │
│ </div>                                                                │
│                                                                        │
│ User sees:                                                             │
│ ┌──────────────────────────────────────────┐                          │
│ │ $ npx -y @tencent-weixin/...             │                          │
│ │ (waiting for input...)                   │                          │
│ │ ✓ QR Code Scanned!                       │                          │
│ │ (setup complete)                         │                          │
│ └──────────────────────────────────────────┘                          │
└────────────────────────────────────────────────────────────────────────┘

✅ This whole flow WORKS if the child process starts successfully!
❌ But spawn('script', ...) crashes before getting here
```

---

## Solution Architecture

```
OLD (BROKEN):
┌──────────────┐
│ spawn('script') ─────→ ❌ SIGKILL → White Screen
└──────────────┘

NEW (FIXED - SOLUTION A - Simplest):
┌──────────────────────────────────────────────────────────────────┐
│ spawn('bash', [scriptPath], { env: selectedEnv })               │
│                                                                  │
│ ✅ Direct bash execution                                         │
│ ✅ Clean stdout/stderr handling                                 │
│ ✅ Proper signal handling                                        │
│ ✅ Window stays responsive                                       │
│ ✅ Output streams to embedded terminal                           │
└──────────┬───────────────────────────────────────────────────────┘
           │ child.stdout.on('data', ...)
           │ child.stderr.on('data', ...)
           ▼
┌──────────────────────────────────────────────────────────────────┐
│ createTerminalOutputEmitter() - existing code works perfectly   │
└──────────┬───────────────────────────────────────────────────────┘
           │ win.webContents.send('terminal:output', chunk)
           ▼
┌──────────────────────────────────────────────────────────────────┐
│ Renderer displays output in EmbeddedTerminal component          │
│                                                                  │
│ ✅ User sees live progress                                       │
│ ✅ Can detect "QR Code Scanned" pattern                          │
│ ✅ No external window opens                                      │
│ ✅ No white screen                                               │
└──────────────────────────────────────────────────────────────────┘
```

---

## Root Cause Summary

| Issue | Cause | Impact | Solution |
|-------|-------|--------|----------|
| White screen on save | `spawn('script')` crashes with SIGKILL | Renderer killed, no UI | Replace with `spawn('bash')` |
| External Terminal opens | `runMacTerminalScript()` fallback | Can't monitor in app | Remove fallback entirely |
| No error recovery | No timeout, no try/catch handling | Process hangs = SIGKILL | Add timeout + better error handling |
| Window destruction race | `isDestroyed()` check not atomic | Crash during IPC send | Use catch-all try/catch |
| Wrong environment vars | Full Electron env to `script` command | Command conflicts | Only pass necessary vars |


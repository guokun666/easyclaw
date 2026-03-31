# Comprehensive Analysis: Electron White Screen Issue

## Executive Summary

The white screen after clicking "save config" is caused by **three critical issues in `src/main/services/onboarder.ts`**:

1. **PRIMARY**: `runEmbeddedMacPtyScript()` uses `spawn('script', ...)` which crashes the renderer process with SIGKILL (exit code 9)
2. **SECONDARY**: `runMacTerminalScript()` opens external Terminal.app, which looks like a white screen to the user
3. **TERTIARY**: No graceful error recovery when embedded terminal fails

---

## Detailed Issue Breakdown

### Issue #1: `runEmbeddedMacPtyScript` Crashes Renderer (Lines 503-565)

**Current Code:**
```javascript
const child = spawn('script', ['-q', '/dev/null', 'bash', scriptPath], {
  env
})
```

**What Happens:**
1. `script` is a POSIX utility designed for recording terminal sessions, NOT running shell commands
2. It creates a pseudo-terminal which may have I/O buffering issues
3. The spawned process inherits Electron's full environment (contains V8 references)
4. When script encounters resource constraints or environment conflicts, it crashes
5. The crash sends SIGKILL to the renderer process (exit code 9)
6. Window shows blank white screen with no error message

**Error Evidence:**
```
render-process-gone { reason: 'killed', exitCode: 9 }
```
- Exit code 9 = SIGKILL (forced termination)
- No graceful shutdown, no error handling

**Why the Renderer Dies:**
- When a spawned child process crashes with SIGKILL, it can propagate to parent process group
- Electron's V8 engine references in the environment variable may cause conflicts
- The `script` command is blocking the event loop or hogging resources
- No timeout mechanism to kill the stuck process

---

### Issue #2: `runMacTerminalScript` Opens External App (Lines 439-501)

**Current Code:**
```javascript
const child = spawn('osascript', [
  '-e', 'tell application "Terminal" to activate',
  '-e', `tell application "Terminal" to do script "bash \\\"${scriptArg}\\\""`
])
```

**User Experience:**
1. Click "save config" button in Electron app
2. osascript opens Terminal.app
3. Terminal.app window comes to focus
4. User sees blank Electron window (white screen) because Terminal is now active
5. User has NO VISIBILITY into terminal output in the app UI
6. User CAN'T detect QR code scanning success via embedded terminal
7. User has to manually switch back to Electron app

**Problems:**
- ❌ Not truly embedded (opens external app)
- ❌ Looks like white screen/app crashed
- ❌ No QR code detection automation possible
- ❌ Terrible user experience
- ❌ This is the FALLBACK when embedded terminal fails

---

### Issue #3: Error in `createTerminalOutputEmitter` Window Handling (Lines 121-186)

**Current Code:**
```javascript
const flush = (): void => {
  // ...
  try {
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      disposed = true
      return
    }
    win.webContents.send('terminal:output', payload)  // Race condition here
  } catch {
    disposed = true
    return
  }
}
```

**Race Condition:**
- Window could be destroyed BETWEEN `isDestroyed()` check and `send()` call
- When renderer crashes, cleanup doesn't happen properly
- Timers might continue firing after window is gone

---

### Issue #4: No Timeout Protection

**Problem:**
- `runEmbeddedMacPtyScript()` has no timeout
- If process hangs, no mechanism to kill it
- Eventually forces OS to SIGKILL the renderer

---

### Issue #5: Environment Variable Passing

**Current Code:**
```javascript
const child = spawn('script', ['-q', '/dev/null', 'bash', scriptPath], {
  env  // Full Electron environment
})
```

**Problems:**
- Full Electron environment includes V8 heap pointers, module paths, etc.
- These may conflict with `script` command expectations
- Some variables may cause POSIX tools to behave unpredictably

---

## What's Actually Working (Good News!)

✅ **Terminal Output Streaming**: The IPC-based streaming system is PERFECT
- `createTerminalOutputEmitter()` properly batches and sends output
- `terminal:output` event works reliably
- `terminal:exit` event properly signals completion

✅ **Renderer-Side Display**: The UI components are EXCELLENT
- `EmbeddedTerminal.tsx` displays output beautifully
- `useTerminalStream.ts` hook manages state cleanly
- QR code scanning could be detected via output patterns

✅ **Process Logging**: The `createInstallProgressEmitter()` works well for logs

---

## Complete Data Flow Analysis

### Current Flow (BROKEN):
```
ConfigStep.tsx
  ↓ handleSave()
  ↓ window.electronAPI.onboard.run()
  ↓ ipcMain.handle('onboard:run')
  ↓ runOnboard() [onboarder.ts]
  ↓ runOneClickChannelSetup() [onboarder.ts]
  ↓ runEmbeddedMacPtyScript() [CRASHES HERE]
    ↓ spawn('script', ['-q', '/dev/null', 'bash', scriptPath])
    ↓ Creates pseudoterminal with script command
    ↓ script command SIGKILL'd
    ↓ Renderer process killed
    ↓ White screen
  ↓ [Fallback tries to run runMacTerminalScript]
    ↓ spawn('osascript', [...Terminal.app...])
    ↓ Opens external Terminal.app
    ↓ User sees white Electron window
    ↓ Cannot monitor progress in app
```

### Desired Flow (SOLUTION):
```
ConfigStep.tsx
  ↓ handleSave()
  ↓ window.electronAPI.onboard.run()
  ↓ ipcMain.handle('onboard:run')
  ↓ runOnboard() [onboarder.ts]
  ↓ runOneClickChannelSetup() [onboarder.ts]
  ↓ runEmbeddedBashScript() [FIXED FUNCTION]
    ↓ spawn('bash', [scriptPath]) directly
    ↓ Capture stdout/stderr via pipes
    ↓ Stream to EmbeddedTerminal component via terminal:output
    ↓ User sees progress in app UI
    ↓ Can detect QR code patterns
    ↓ Proper error handling
  ↓ ConfigStep updates on success
```

---

## Recommended Solutions

### Solution A: Replace `script` with `bash` (RECOMMENDED - Simplest)

**Advantages:**
- ✅ No PTY/pseudo-terminal complexity
- ✅ Direct process control
- ✅ Proper signal handling (SIGTERM/SIGKILL)
- ✅ Clean stdout/stderr separation
- ✅ Works on all platforms
- ✅ Minimal code changes

**Implementation:**
```javascript
const child = spawn('bash', [scriptPath], {
  env: {
    PATH: env.PATH ?? process.env.PATH,
    npm_config_prefix: env.npm_config_prefix,
    npm_config_cache: env.npm_config_cache
    // Only pass necessary variables
  }
})
```

### Solution B: Use `node-pty` library (Alternative - Better UX)

**Advantages:**
- ✅ True PTY support (colors, interactive commands)
- ✅ Better for complex shell interactions
- ✅ User sees exactly what would appear in Terminal.app

**Disadvantages:**
- ❌ External dependency
- ❌ Native compilation required
- ❌ More complex code

---

## Step-by-Step Issue Recap

### Click "Save Config"

1. **User Action**: Clicks save button in ConfigStep
2. **Frontend**: Calls `window.electronAPI.onboard.run(config)`
3. **IPC**: Main process receives `onboard:run` handler
4. **Backend**: Calls `runOnboard()` with config
5. **OneClick Setup**: Since it's wechat/feishu one-click, calls `runOneClickChannelSetup()`
6. **Platform Check**: Detects macOS, calls `runEmbeddedMacPtyScript()`

### Process Spawning (CRASH POINT)

7. **Creates PTY**: Spawns `script -q /dev/null bash scriptPath`
8. **Why Script Fails**:
   - `script` is designed to record terminal sessions, not run commands
   - It expects different stdin/stdout behavior than regular bash
   - With full Electron environment, it has conflicts
9. **SIGKILL Received**: OS terminates the process with signal 9
10. **Renderer Crash**: Signal propagates up, killing renderer process
11. **White Screen**: No window content, just blank white

### Current Fallback (ALSO BROKEN)

12. **Exception Caught**: `catch` block in runOneClickChannelSetup
13. **Fallback Function**: Calls `runMacTerminalScript()`
14. **Opens Terminal.app**: Uses osascript to launch system Terminal
15. **Visible White Screen**: User's Electron window loses focus
16. **Cannot Monitor**: No way to detect QR code scanning in app

---

## Key Findings Summary

| Aspect | Status | Issue |
|--------|--------|-------|
| Terminal Output Streaming | ✅ Working | None |
| EmbeddedTerminal Component | ✅ Working | None |
| useTerminalStream Hook | ✅ Working | None |
| Process Spawning (script) | ❌ Broken | SIGKILL on renderer |
| Fallback (osascript) | ❌ Broken | Opens external app |
| Error Handling | ⚠️ Partial | No timeout, no recovery |
| Window Safety | ⚠️ Partial | Race condition on send |
| Environment Variables | ❌ Broken | Passes full Electron env |

---

## Next Steps

1. **Immediate**: Replace `spawn('script', ...)` with `spawn('bash', ...)`
2. **Handle Window Destruction**: Add better guards
3. **Add Timeout**: Kill process if stuck > 5 minutes
4. **Test QR Detection**: Verify output patterns can be monitored
5. **Remove External Terminal**: Never launch Terminal.app


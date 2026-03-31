# Electron App White Screen Issue Analysis

## Root Causes Identified

### 1. **runEmbeddedMacPtyScript (Line 503-565) - PRIMARY CULPRIT**
   
**The Issue:**
```javascript
const child = spawn('script', ['-q', '/dev/null', 'bash', scriptPath], {
  env
})
```

**Why It Crashes the Renderer:**
- `spawn('script', ...)` creates a pseudo-terminal but may consume significant resources
- The child process inherits the full Electron environment, including V8 engine references
- When the `script` command exits or crashes, it can trigger `SIGKILL` (exit code 9) on the renderer process
- The renderer process is getting killed, leaving a blank white screen

**Evidence from Error Log:**
```
render-process-gone { reason: 'killed', exitCode: 9 }
```
- Exit code 9 = SIGKILL (force terminated)
- This happens after clicking "save config" and the embedded terminal tries to start

### 2. **runMacTerminalScript (Line 439-501) - Fallback Issue**
   
**The Issue:**
```javascript
const child = spawn('osascript', [
  '-e', 'tell application "Terminal" to activate',
  '-e', `tell application "Terminal" to do script "bash \\\"${scriptArg}\\\""`
])
```

**Problems:**
- Opens external Terminal.app and brings it to focus
- User sees "white screen" because Terminal.app window takes focus, hiding the Electron app
- No terminal output is captured or shown in the UI
- User can't monitor QR code scanning success/failure
- Falls back to this when `runEmbeddedMacPtyScript` fails, making the issue worse

### 3. **Window Destruction Race Condition**

**The Issue in createTerminalOutputEmitter (Line 121-186):**
```javascript
const flush = (): void => {
  if (disposed || !queue) {
    timer = null
    return
  }
  
  try {
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      disposed = true
      timer = null
      return
    }
    win.webContents.send('terminal:output', payload)  // Could still fail
  } catch {
    disposed = true
    timer = null
    return
  }
  
  timer = null
}
```

**Problems:**
- Window might be destroyed between the `isDestroyed()` check and `send()` call
- If child process exits with SIGKILL, it might kill the renderer before cleanup
- No proper error handling for destroyed windows during stream emission

### 4. **Missing Timeout Protection**

**Issue:**
- `runEmbeddedMacPtyScript` doesn't have a timeout
- If the `script` command hangs or consumes too many resources, the process blocks indefinitely
- Eventually causes renderer process to be terminated by OS

### 5. **Environment Passing Issue**

**Issue in runEmbeddedMacPtyScript:**
```javascript
await new Promise<void>((resolve, reject) => {
  const child = spawn('script', ['-q', '/dev/null', 'bash', scriptPath], {
    env  // Full environment passed to spawned process
  })
```

**Problems:**
- Passing full `env` object to spawned process can include V8 heap references
- Some environment variables might conflict with system expectations
- The `script` command is a POSIX tool designed for different purposes (terminal session recording)

## Why This Causes White Screen

1. User clicks "save config" in ConfigStep
2. `handleSave()` calls `window.electronAPI.onboard.run()`
3. Main process calls `runOnboard()` → `runOneClickChannelSetup()`
4. For macOS (wechat/feishu one-click), calls `runEmbeddedMacPtyScript()`
5. `spawn('script', ...)` starts and begins streaming output
6. Process encounters resource issues or environmental conflict
7. OS sends SIGKILL to the process
8. Renderer process receives `render-process-gone` event with exitCode 9
9. Electron renders blank white screen (no error message, no UI)

## Current Architecture Problems

### What's Working:
- ✅ Terminal output streaming via IPC (`terminal:output` event)
- ✅ EmbeddedTerminal component to display output
- ✅ useTerminalStream hook to manage state
- ✅ Window destruction checks

### What's Broken:
- ❌ `spawn('script', ...)` crashes renderer with SIGKILL
- ❌ Fallback to external Terminal.app (not embedded)
- ❌ No timeout protection
- ❌ No resource limits
- ❌ No graceful error recovery

## Solution Architecture

### Replace `script` command with Node.js PTY solution:
1. Use `node-pty` library to create proper pseudoterminal
2. Run bash script in the PTY
3. Stream output via existing terminal:output IPC
4. Properly handle process termination
5. Add timeout and resource limits
6. Graceful error handling without renderer crash

### Alternative (if node-pty unavailable):
1. Use `spawn('bash', [scriptPath])` directly (no PTY)
2. Capture stdout/stderr via regular pipes
3. Stream output via IPC
4. Much simpler, no PTY-specific issues
5. User can still see all output in embedded terminal

### Never:
- Open external Terminal.app
- Use `osascript` to automate Terminal
- Use `script` command
- Pass full environment to spawned processes
- Create background processes that outlive the main process

const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

// Detecta la aplicación en primer plano sin módulos nativos:
// - Windows: un único PowerShell residente que consulta user32.
// - macOS: un único proceso JXA (NSWorkspace, sin permisos extra).
// - Linux (X11): xprop.
// Si algo no está disponible, simplemente no emite eventos.

const WIN_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
}
"@
$last = ''
while ($true) {
  $h = [Fg]::GetForegroundWindow(); $p = 0
  [void][Fg]::GetWindowThreadProcessId($h, [ref]$p)
  if ($p -ne 0) {
    $n = (Get-Process -Id $p).ProcessName
    if ($n -and $n -ne $last) { $last = $n; [Console]::Out.WriteLine($n); [Console]::Out.Flush() }
  }
  Start-Sleep -Milliseconds 700
}`;

const MAC_SCRIPT = `
ObjC.import('AppKit');
var last = '';
while (true) {
  var a = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  var n = a ? ObjC.unwrap(a.localizedName) : '';
  if (n && n !== last) { last = n; console.log(n); }
  delay(0.7);
}`;

class ForegroundWatcher extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.timer = null;
    this.current = '';
  }

  get running() { return !!(this.proc || this.timer); }

  start() {
    if (this.running) return;
    try {
      if (process.platform === 'win32') {
        // -EncodedCommand evita cualquier problema de comillas en la línea de comandos
        const encoded = Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64');
        this.spawnLines('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], 'stdout');
      } else if (process.platform === 'darwin') {
        this.spawnLines('osascript', ['-l', 'JavaScript', '-e', MAC_SCRIPT], 'stderr');
      } else {
        this.timer = setInterval(() => this.pollX11(), 1000);
      }
    } catch {
      this.stop();
    }
  }

  spawnLines(cmd, args, stream) {
    const proc = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    let buf = '';
    proc[stream].setEncoding('utf8');
    proc[stream].on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const name = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (name) this.set(name);
      }
    });
    proc.on('error', () => { if (this.proc === proc) this.proc = null; });
    proc.on('exit', () => { if (this.proc === proc) this.proc = null; });
  }

  pollX11() {
    execFile('xprop', ['-root', '_NET_ACTIVE_WINDOW'], { timeout: 800 }, (err, out) => {
      if (err) { if (err.code === 'ENOENT') this.stop(); return; }
      const m = /window id # (0x[0-9a-f]+)/i.exec(out);
      if (!m || m[1] === '0x0') return;
      execFile('xprop', ['-id', m[1], 'WM_CLASS'], { timeout: 800 }, (e2, out2) => {
        if (e2) return;
        const parts = [...out2.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
        const name = parts[parts.length - 1];
        if (name) this.set(name);
      });
    });
  }

  set(name) {
    if (name === this.current) return;
    this.current = name;
    this.emit('change', name);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.proc) { try { this.proc.kill(); } catch { /* nada */ } }
    this.proc = null;
  }
}

module.exports = { ForegroundWatcher };

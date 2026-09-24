import { execFile } from "node:child_process";

export type DesktopAction = { action: "screenshot" | "click" | "double_click" | "right_click" | "scroll" | "type" | "key"; x?: number; y?: number; text?: string; key?: string; delta?: number };
export function validateDesktopAction(input: Record<string, unknown>): DesktopAction {
  const action = String(input.action ?? "screenshot");
  if (!["screenshot", "click", "double_click", "right_click", "scroll", "type", "key"].includes(action)) throw new Error("Unbekannte Desktop-Aktion");
  if (["click", "double_click", "right_click"].includes(action) &&
      ![input.x, input.y].every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error("Koordinaten müssen zwischen 0 und 1 liegen");
  if (action === "type" && (typeof input.text !== "string" || input.text.length > 2000)) throw new Error("Text darf höchstens 2000 Zeichen enthalten");
  if (action === "key" && !/^(CTRL\+|ALT\+|SHIFT\+)?(ENTER|ESC|TAB|BACKSPACE|DELETE|LEFT|RIGHT|UP|DOWN|HOME|END|SPACE|[A-Z0-9])$/.test(String(input.key))) throw new Error("Nicht unterstützte Taste");
  if (action === "scroll" && (typeof input.delta !== "number" || !Number.isInteger(input.delta) || Math.abs(input.delta) > 10)) throw new Error("Scroll-Schritte müssen zwischen -10 und 10 liegen");
  return { action, x: input.x, y: input.y, text: input.text, key: input.key, delta: input.delta } as DesktopAction;
}

// Fixed code: user/model text is passed as JSON through the environment, never interpolated.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DuckyDesktop {
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint data, UIntPtr extra);
 [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
 [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] input, int size);
 [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }
 [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public KEY key; [FieldOffset(0)] public MOUSE mouse; }
 [StructLayout(LayoutKind.Sequential)] public struct KEY { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] public struct MOUSE { public int x,y; public uint data,flags,time; public UIntPtr extra; }
 public static void Text(string text) {
  foreach (char c in text) {
   var down = new INPUT { type=1, u=new UNION { key=new KEY { scan=c, flags=4 } } };
   var up = new INPUT { type=1, u=new UNION { key=new KEY { scan=c, flags=6 } } };
   if (SendInput(2, new [] { down, up }, Marshal.SizeOf(typeof(INPUT))) != 2) throw new Exception("Windows hat die Texteingabe blockiert");
  }
 }
}
'@
[void][DuckyDesktop]::SetProcessDPIAware()
$p = $env:DUCKY_DESKTOP_ACTION | ConvertFrom-Json
$r = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($p.action -in @('click','double_click','right_click')) {
 [void][DuckyDesktop]::SetCursorPos($r.Left + [int]($p.x * ($r.Width-1)), $r.Top + [int]($p.y * ($r.Height-1)))
 $down = 2; $up = 4
 if ($p.action -eq 'right_click') { $down=8; $up=16 }
 [DuckyDesktop]::mouse_event($down,0,0,0,[UIntPtr]::Zero)
 [DuckyDesktop]::mouse_event($up,0,0,0,[UIntPtr]::Zero)
 if ($p.action -eq 'double_click') {
  Start-Sleep -Milliseconds 70
  [DuckyDesktop]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
  [DuckyDesktop]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
 }
}
if ($p.action -eq 'scroll') {
 $delta = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]($p.delta * 120)),0)
 [DuckyDesktop]::mouse_event(2048,0,0,$delta,[UIntPtr]::Zero)
}
if ($p.action -eq 'type') { [DuckyDesktop]::Text($p.text) }
if ($p.action -eq 'key') {
 $parts = $p.key.Split('+'); $key = $parts[-1]
 $keys = @{ENTER=13;ESC=27;TAB=9;BACKSPACE=8;DELETE=46;LEFT=37;RIGHT=39;UP=38;DOWN=40;HOME=36;END=35;SPACE=32}
 $code = if ($keys.ContainsKey($key)) { $keys[$key] } else { [int][char]$key }
 $mod = 0
 if ($parts.Length -gt 1) { $mod = @{CTRL=17;ALT=18;SHIFT=16}[$parts[0]] }
 try {
  if ($mod) { [DuckyDesktop]::keybd_event($mod,0,0,[UIntPtr]::Zero) }
  [DuckyDesktop]::keybd_event($code,0,0,[UIntPtr]::Zero)
  [DuckyDesktop]::keybd_event($code,0,2,[UIntPtr]::Zero)
 } finally { if ($mod) { [DuckyDesktop]::keybd_event($mod,0,2,[UIntPtr]::Zero) } }
}
if ($p.action -ne 'screenshot') { Start-Sleep -Milliseconds 180 }
$bitmap = New-Object System.Drawing.Bitmap($r.Width,$r.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
 $graphics.CopyFromScreen($r.Left,$r.Top,0,0,$bitmap.Size)
 $scale = [Math]::Min(1,1600 / $r.Width)
 for ($attempt=0; $attempt -lt 8; $attempt++) {
  $small = New-Object System.Drawing.Bitmap([Math]::Max(1,[int]($r.Width*$scale)),[Math]::Max(1,[int]($r.Height*$scale)))
  $g = [System.Drawing.Graphics]::FromImage($small)
  $memory = New-Object System.IO.MemoryStream
  try {
   $g.DrawImage($bitmap,0,0,$small.Width,$small.Height)
   $small.Save($memory,[System.Drawing.Imaging.ImageFormat]::Jpeg)
   if ($memory.Length -le 138000) {
    @{screenshot=[Convert]::ToBase64String($memory.ToArray());format='jpeg';width=$small.Width;height=$small.Height;timestamp=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress
    break
   }
  } finally { $g.Dispose(); $small.Dispose(); $memory.Dispose() }
  $scale *= 0.8
 }
 if ($attempt -ge 8) { throw 'Bildschirmbild zu gross' }
} finally { $graphics.Dispose(); $bitmap.Dispose() }
`;

export async function runDesktopAction(input: DesktopAction, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (process.platform !== "win32") throw new Error("Desktopsteuerung benötigt einen lokalen Windows-Server");
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(SCRIPT, "utf16le").toString("base64")], {
      windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024, signal,
      env: { ...process.env, DUCKY_DESKTOP_ACTION: JSON.stringify(input) },
    }, (error, stdout, stderr) => {
      if (error) { reject(new Error(stderr.trim() || error.message)); return; }
      try { resolve(JSON.parse(stdout.trim()) as Record<string, unknown>); } catch { reject(new Error("Ungültige Desktop-Antwort")); }
    });
  });
}

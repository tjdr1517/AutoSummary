import { BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'

function nativeHandle(window: BrowserWindow): string {
  const buffer = window.getNativeWindowHandle()
  return (buffer.length >= 8 ? buffer.readBigUInt64LE() : BigInt(buffer.readUInt32LE())).toString()
}

export function placeWindowOnDesktop(window: BrowserWindow): void {
  if (process.platform !== 'win32' || window.isDestroyed()) return
  window.setAlwaysOnTop(false)
  window.setSkipTaskbar(true)
  const handle = nativeHandle(window)
  const source = [
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class Win32 {',
    '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
    '}'
  ].join(' ')
  const command = `Add-Type -TypeDefinition '${source}'; [Win32]::SetWindowPos([IntPtr]${handle}, [IntPtr]1, 0, 0, 0, 0, 0x0013) | Out-Null`
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command], {
    windowsHide: true,
    stdio: 'ignore'
  })
  child.unref()
}

export function revealDesktop(): void {
  if (process.platform !== 'win32') return
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
    '(New-Object -ComObject Shell.Application).MinimizeAll()'
  ], { windowsHide: true, stdio: 'ignore' })
  child.unref()
}

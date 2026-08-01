$out = 'C:\Users\A\AppData\Local\Temp\swap-out.txt'
try {
  $ae = Get-Process AfterFX -ErrorAction SilentlyContinue
  if ($ae) {
    $ae.CloseMainWindow() | Out-Null
    $ae.WaitForExit(45000) | Out-Null
    if (-not $ae.HasExited) { Stop-Process -Id $ae.Id -Force }
    Start-Sleep 2
  }
  Copy-Item 'C:\Users\A\AppData\Local\Temp\aemcp-build\dev-016\AeMcpNative.aex' `
    'C:\Program Files\Adobe\Adobe After Effects 2025\Support Files\Plug-ins\Extensions\AeMcpNative.aex' `
    -Force -ErrorAction Stop
  Start-Process 'C:\Program Files\Adobe\Adobe After Effects 2025\Support Files\AfterFX.exe'
  Set-Content $out 'SWAP-AND-START-OK'
} catch {
  Set-Content $out ('FAIL ' + $_.Exception.Message)
}

$out = 'C:\Users\A\AppData\Local\Temp\swap-out.txt'
try {
  $ae = Get-Process AfterFX -ErrorAction SilentlyContinue
  if ($ae) {
    $ae.CloseMainWindow() | Out-Null
    $ae.WaitForExit(30000) | Out-Null
    if (-not $ae.HasExited) { Stop-Process -Id $ae.Id -Force }
  }
  Copy-Item 'C:\Users\A\AppData\Local\Temp\aemcp-build\dev-012-probe\AeMcpNative.aex' `
    'C:\Program Files\Adobe\Adobe After Effects 2025\Support Files\Plug-ins\Extensions\AeMcpNative.aex' `
    -Force -ErrorAction Stop
  Set-Content $out 'SWAP-OK'
} catch {
  Set-Content $out ('FAIL ' + $_.Exception.Message)
}

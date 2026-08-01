$src = 'C:\Users\A\AppData\Local\Temp\aemcp-build\dev-011-probe\AeMcpNative.aex'
$out = 'C:\Users\A\AppData\Local\Temp\swap-out.txt'
$results = @()
try {
  Copy-Item $src 'C:\Program Files\Adobe\Adobe After Effects 2025\Support Files\Plug-ins\Extensions\AeMcpNative.aex' -Force -ErrorAction Stop
  $results += 'INSTALLED-EXTENSIONS'
  Remove-Item 'C:\Program Files\Adobe\Adobe After Effects 2025\Support Files\Plug-ins\AeMcpNative.aex' -Force -ErrorAction Stop
  $results += 'REMOVED-APPROOT'
  Remove-Item 'C:\Program Files\Adobe\Common\Plug-ins\7.0\MediaCore\AeMcpNative.aex' -Force -ErrorAction Stop
  $results += 'REMOVED-MEDIACORE'
  Set-Content $out ($results -join ' ')
} catch {
  Set-Content $out (($results -join ' ') + ' FAIL: ' + $_.Exception.Message)
}

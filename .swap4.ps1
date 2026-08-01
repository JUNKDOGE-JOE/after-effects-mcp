$out = 'C:\Users\A\AppData\Local\Temp\swap-out.txt'
$results = @()
foreach ($p in @(
  'C:\Program Files\Adobe\Adobe After Effects 2025\Support Files\Plug-ins\AeMcpNative.aex',
  'C:\Program Files\Adobe\Common\Plug-ins\7.0\MediaCore\AeMcpNative.aex'
)) {
  try {
    Remove-Item $p -Force -ErrorAction Stop
    $results += "REMOVED:$p"
  } catch {
    $results += "FAIL:$p " + $_.Exception.Message
  }
}
Set-Content $out ($results -join "`n")

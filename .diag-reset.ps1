$ae = Get-Process AfterFX -ErrorAction SilentlyContinue
if ($ae) {
  $ae.CloseMainWindow() | Out-Null
  $ae.WaitForExit(30000) | Out-Null
  if (-not $ae.HasExited) { Stop-Process -Id $ae.Id -Force }
  Write-Output 'AE-CLOSED'
} else {
  Write-Output 'AE-NOT-RUNNING'
}
$key = Get-ChildItem 'HKCU:\Software\Adobe\After Effects\25.6\PluginCache\zh_CN' -ErrorAction SilentlyContinue |
  Where-Object Name -match 'AeMcpNative'
if ($key) {
  $key | Remove-Item -Recurse -Force
  Write-Output 'CACHE-KEY-DELETED'
} else {
  Write-Output 'CACHE-KEY-ABSENT'
}

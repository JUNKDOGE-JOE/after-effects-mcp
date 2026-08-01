$ae = Get-Process AfterFX -ErrorAction SilentlyContinue
if (-not $ae) { Write-Output 'AE-NOT-RUNNING'; exit }
Write-Output ('AE-PID: ' + $ae.Id)
$hit = $ae.Modules | Where-Object { $_.ModuleName -match 'AeMcp' }
if ($hit) { $hit | ForEach-Object { Write-Output ('MODULE-LOADED: ' + $_.FileName) } }
else { Write-Output 'MODULE-NOT-LOADED' }

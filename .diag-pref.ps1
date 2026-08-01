Get-Process AfterFX -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 2
Write-Output 'AE-ALL-KILLED'
$pref = "$env:APPDATA\Adobe\After Effects"
Write-Output ('PREF-DIR: ' + $pref)
icacls $pref | Select-Object -First 5
Write-Output '--- 25.6 integrity ---'
icacls "$pref\25.6" | Select-Object -First 5
Write-Output '--- file owners sample ---'
Get-ChildItem "$pref\25.6" -File -ErrorAction SilentlyContinue |
  Select-Object -First 5 Name, @{n='Owner';e={(Get-Acl $_.FullName).Owner}} | Format-Table -AutoSize

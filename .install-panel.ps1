$out = 'C:\Users\A\AppData\Local\Temp\swap-out.txt'
try {
  $ae = Get-Process AfterFX -ErrorAction SilentlyContinue
  if ($ae) {
    $ae.CloseMainWindow() | Out-Null
    $ae.WaitForExit(45000) | Out-Null
    if (-not $ae.HasExited) { Stop-Process -Id $ae.Id -Force }
    Start-Sleep 2
  }
  $src = 'E:\Code\after-effects-mcp\.worktrees\issue-86-windows-native-exec-host\plugin'
  $dst = 'C:\Users\A\AppData\Roaming\Adobe\CEP\extensions\com.aemcp.panel'
  $backup = 'C:\Users\A\AppData\Roaming\Adobe\CEP\extensions\com.aemcp.panel.pre092-backup'
  if (Test-Path $backup) { Remove-Item $backup -Recurse -Force }
  Move-Item $dst $backup -ErrorAction Stop
  robocopy $src $dst /MIR /XD .git /NFL /NDL /NJH /NJS | Out-Null
  Start-Process 'C:\Program Files\Adobe\Adobe After Effects 2025\Support Files\AfterFX.exe'
  Set-Content $out 'PANEL-092-INSTALLED'
} catch {
  Set-Content $out ('FAIL ' + $_.Exception.Message)
}

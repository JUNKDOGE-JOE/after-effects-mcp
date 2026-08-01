$paths = @(
  'HKCU:\Software\Adobe\After Effects',
  'HKLM:\Software\Adobe\After Effects'
)
foreach ($base in $paths) {
  if (Test-Path $base) {
    Get-ChildItem $base -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match 'PluginCache|Plugin Cache|Cache' } |
      Select-Object -ExpandProperty Name
  }
}

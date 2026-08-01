Get-ChildItem 'HKCU:\Software\Adobe\After Effects\25.6\PluginCache' -Recurse -ErrorAction SilentlyContinue |
  Where-Object { $_.PSChildName -match 'AeMcpNative|Anywhere2' } |
  ForEach-Object {
    $props = Get-ItemProperty $_.PSPath
    Write-Output ($_.Name + '  Ignore=' + $props.Ignore)
  }
Write-Output '--- locale subkeys ---'
Get-ChildItem 'HKCU:\Software\Adobe\After Effects\25.6\PluginCache' -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty PSChildName

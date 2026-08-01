$hits = Get-ChildItem 'HKCU:\Software\Adobe\After Effects' -Recurse -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'AeMcpNative' }
$hits | Select-Object -ExpandProperty Name
foreach ($hit in $hits) {
  $props = Get-ItemProperty $hit.PSPath
  $props.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } |
    ForEach-Object { Write-Output ("{0} = {1}" -f $_.Name, $_.Value) }
}

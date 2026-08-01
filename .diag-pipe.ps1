$pipe = $null
try {
  $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'aemcp-n1-3cc532ae048a', [System.IO.Pipes.PipeDirection]::InOut)
  $pipe.Connect(5000)
  Write-Output 'PIPE-CONNECT-OK'
  $preface = New-Object byte[] 24
  [Array]::Copy([Text.Encoding]::ASCII.GetBytes('AEMCP-P1'), 0, $preface, 0, 8)
  $pipe.Write($preface, 0, 24)
  $pipe.Flush()
  $buffer = New-Object byte[] 57
  $read = $pipe.Read($buffer, 0, 57)
  Write-Output ("READ " + $read + " bytes: " + [Text.Encoding]::ASCII.GetString($buffer, 0, [Math]::Min($read, 21)))
} catch {
  Write-Output ('PIPE-FAIL ' + $_.Exception.Message)
} finally {
  if ($pipe) { $pipe.Dispose() }
}

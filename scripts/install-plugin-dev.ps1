# Fail-closed Windows development deployment for the CEP panel.
# Run from any directory. After Effects must be completely closed.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail-DevInstall([string]$Message) {
    throw "Dev install failed: $Message"
}

function Assert-RegularFile([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Fail-DevInstall "$Label is missing: $Path"
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Fail-DevInstall "$Label must not be a reparse point: $Path"
    }
}

function Get-TreeSnapshot([string]$Root) {
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $entries = [System.Collections.Generic.List[string]]::new()
    foreach ($item in @(Get-ChildItem -LiteralPath $rootPath -Force -Recurse)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Fail-DevInstall "plugin trees must not contain reparse points: $($item.FullName)"
        }
        $relative = $item.FullName.Substring($rootPath.Length).TrimStart('\')
        if ($item.PSIsContainer) {
            $entries.Add("D|$relative")
        } else {
            $digest = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
            $entries.Add("F|$relative|$($item.Length)|$digest")
        }
    }
    return @($entries | Sort-Object -CaseSensitive)
}

function Assert-TreeEqual([string]$Source, [string]$Destination) {
    $sourceSnapshot = @(Get-TreeSnapshot $Source)
    $destinationSnapshot = @(Get-TreeSnapshot $Destination)
    $difference = @(Compare-Object -ReferenceObject $sourceSnapshot `
        -DifferenceObject $destinationSnapshot -CaseSensitive)
    if ($difference.Count -ne 0) {
        Fail-DevInstall "deployed tree differs from source: $Destination"
    }
}

function Quote-PowerShellLiteral([string]$Value) {
    return "'" + $Value.Replace("'", "''") + "'"
}

try {
    $runningAe = @(Get-Process -ErrorAction Stop | Where-Object {
        $_.ProcessName -match '^(AfterFX|Adobe After Effects.*)$'
    })
} catch {
    Fail-DevInstall 'could not determine whether After Effects is running'
}
if ($runningAe.Count -ne 0) {
    Fail-DevInstall 'all Adobe After Effects / AfterFX processes must be closed before deployment'
}

$repoRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$pluginSrc = Join-Path $repoRoot 'plugin'
if (-not (Test-Path -LiteralPath $pluginSrc -PathType Container)) {
    Fail-DevInstall "plugin source directory is missing: $pluginSrc"
}
$pluginSourceItem = Get-Item -LiteralPath $pluginSrc -Force
if (($pluginSourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail-DevInstall "plugin source directory must not be a reparse point: $pluginSrc"
}

$requiredFiles = @(
    'CSXS\manifest.xml',
    'client\index.html',
    'client\dist\app.js',
    'host\server.js',
    'jsx\runtime.jsx',
    '.debug'
)
foreach ($relative in $requiredFiles) {
    Assert-RegularFile (Join-Path $pluginSrc $relative) "required plugin source file $relative"
}

$cepParent = [IO.Path]::GetFullPath(
    (Join-Path $env:APPDATA 'Adobe\CEP\extensions'))
$null = New-Item -ItemType Directory -Path $cepParent -Force
$cepParentItem = Get-Item -LiteralPath $cepParent -Force
if (-not $cepParentItem.PSIsContainer -or
    ($cepParentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail-DevInstall "CEP extension parent must be a regular, non-reparse directory: $cepParent"
}
$cepDir = Join-Path $cepParent 'com.aemcp.panel'
if (Test-Path -LiteralPath $cepDir) {
    $targetItem = Get-Item -LiteralPath $cepDir -Force
    if (-not $targetItem.PSIsContainer -or
        ($targetItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Fail-DevInstall "existing CEP target is not a regular directory: $cepDir"
    }
}

$installId = ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '.' +
    [guid]::NewGuid().ToString('N'))
$staging = Join-Path $cepParent ".com.aemcp.panel.staging.$installId"
$backup = Join-Path $cepParent ".com.aemcp.panel.backup.$installId"
$failedInstall = Join-Path $cepParent ".com.aemcp.panel.failed.$installId"
$restoreReplaced = Join-Path $cepParent ".com.aemcp.panel.replaced.$installId"
foreach ($generated in @($staging, $backup, $failedInstall, $restoreReplaced)) {
    if (Test-Path -LiteralPath $generated) {
        Fail-DevInstall "generated deployment path already exists: $generated"
    }
}

$completed = $false
$oldMoved = $false
$stageMoveStarted = $false

try {
    Write-Host '[1/5] Staging the complete plugin tree beside the final target...'
    $null = New-Item -ItemType Directory -Path $staging
    foreach ($child in @(Get-ChildItem -LiteralPath $pluginSrc -Force)) {
        Copy-Item -LiteralPath $child.FullName -Destination $staging -Recurse -Force
    }

    Write-Host '[2/5] Verifying the staged tree before touching the deployed panel...'
    foreach ($relative in $requiredFiles) {
        Assert-RegularFile (Join-Path $staging $relative) "staged plugin file $relative"
    }
    Assert-TreeEqual $pluginSrc $staging

    Write-Host '[3/5] Enabling CEP PlayerDebugMode before the atomic swap...'
    10..25 | ForEach-Object {
        $key = "HKCU:\Software\Adobe\CSXS.$_"
        if (-not (Test-Path -LiteralPath $key)) {
            $null = New-Item -Path $key -Force
        }
        Set-ItemProperty -LiteralPath $key -Name 'PlayerDebugMode' -Value '1' -Type String
    }

    Write-Host '[4/5] Atomically replacing the CEP panel while retaining the old install...'
    try {
        if (Test-Path -LiteralPath $cepDir) {
            Move-Item -LiteralPath $cepDir -Destination $backup
            $oldMoved = $true
        }
        $stageMoveStarted = $true
        Move-Item -LiteralPath $staging -Destination $cepDir
        Assert-TreeEqual $pluginSrc $cepDir
    } catch {
        $original = $_
        $rollbackErrors = [System.Collections.Generic.List[string]]::new()
        if ($stageMoveStarted -and (Test-Path -LiteralPath $cepDir)) {
            try { Move-Item -LiteralPath $cepDir -Destination $failedInstall }
            catch { $rollbackErrors.Add($_.Exception.Message) }
        }
        if ($oldMoved) {
            if (Test-Path -LiteralPath $backup) {
                try { Move-Item -LiteralPath $backup -Destination $cepDir }
                catch { $rollbackErrors.Add($_.Exception.Message) }
            } else {
                $rollbackErrors.Add("backup disappeared before rollback: $backup")
            }
        }
        if ($rollbackErrors.Count -ne 0) {
            throw "Deployment failed and automatic rollback was incomplete. " +
                "Original error: $($original.Exception.Message). " +
                "Rollback errors: $($rollbackErrors -join '; ')"
        }
        throw $original
    }

    $completed = $true
    Write-Host "[5/5] Installed and verified: $cepDir"
    Write-Host 'Restart After Effects, then open Window -> Extensions -> ae-mcp.'
    if ($oldMoved) {
        Write-Host "Backup retained at: $backup"
        Write-Host 'Restore command (run only while After Effects is closed):'
        $restoreCommand = ('& {{ $ErrorActionPreference = ''Stop''; ' +
            'Move-Item -LiteralPath {0} -Destination {1}; ' +
            'Move-Item -LiteralPath {2} -Destination {3}; }}' -f
            (Quote-PowerShellLiteral $cepDir),
            (Quote-PowerShellLiteral $restoreReplaced),
            (Quote-PowerShellLiteral $backup),
            (Quote-PowerShellLiteral $cepDir))
        Write-Host "  $restoreCommand"
    } else {
        Write-Host 'No prior CEP panel existed, so no backup was created.'
    }
} finally {
    if (-not $completed -and (Test-Path -LiteralPath $staging)) {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }
}

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
    # The dev-payload host service refuses to start without its vendored
    # Express (hostBridge HOST_RUNTIME_DEPENDENCIES_UNAVAILABLE), and the
    # claude sidecar refuses without its vendored Agent SDK. Both live in
    # gitignored node_modules, so a gutted checkout must fail the deploy, not
    # the panel (2026-08-12 incident: both directories shipped empty — the
    # panel came up dead and the claude channel probe failed).
    'host\node_modules\express\package.json',
    'sidecar\node_modules\@anthropic-ai\claude-agent-sdk\package.json',
    'jsx\runtime.jsx',
    '.debug'
)
foreach ($relative in $requiredFiles) {
    Assert-RegularFile (Join-Path $pluginSrc $relative) "required plugin source file $relative"
}

# Bundle freshness gate (#223): this deployment ships the committed dist tree
# verbatim, so a bundle that no longer matches the panel sources must never
# reach a real After Effects.
Write-Host '[1/6] Verifying the committed panel bundle matches the panel sources...'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    Fail-DevInstall 'node is required to verify the committed panel bundle before deployment'
}
$bundleVerifier = Join-Path $repoRoot 'plugin\panel\verify-bundle.mjs'
Assert-RegularFile $bundleVerifier 'panel bundle verifier'
& $nodeCommand.Source $bundleVerifier
if ($LASTEXITCODE -ne 0) {
    Fail-DevInstall 'plugin/client/dist does not match the panel sources: run "npm run build" in plugin/panel, then retry'
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

# CEP loads extensions by the manifest's bundle id and scans EVERY directory in
# the extensions folder — dot-prefixes and renames do not exclude anything. A
# retained backup inside the scan path therefore registers a second
# com.aemcp.panel, and the duplicate-id race can deadlock the AE main thread at
# startup (2026-08-11 incident). All generated artifacts (staging, backups,
# failed installs) must live OUTSIDE the scan path.
$vault = Join-Path (Split-Path -Parent $cepParent) 'aemcp-panel-backups'
$null = New-Item -ItemType Directory -Path $vault -Force
$vaultItem = Get-Item -LiteralPath $vault -Force
if (-not $vaultItem.PSIsContainer -or
    ($vaultItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail-DevInstall "backup vault must be a regular, non-reparse directory: $vault"
}

# Sweep legacy artifacts (from script versions that kept them beside the panel)
# out of the scan path before anything else registers them again.
foreach ($legacy in @(Get-ChildItem -LiteralPath $cepParent -Force |
    Where-Object { $_.Name -like '.com.aemcp.panel.*' })) {
    $destination = Join-Path $vault $legacy.Name
    if (Test-Path -LiteralPath $destination) {
        Fail-DevInstall "cannot relocate legacy artifact, vault entry already exists: $destination"
    }
    Move-Item -LiteralPath $legacy.FullName -Destination $destination
    Write-Host "Relocated legacy deployment artifact out of the CEP scan path: $($legacy.Name)"
}

# Fail closed if any OTHER directory still carries our manifest — a stray copy
# under any name would race the real panel for the extension id.
foreach ($entry in @(Get-ChildItem -LiteralPath $cepParent -Force -Directory |
    Where-Object { $_.Name -ne 'com.aemcp.panel' })) {
    $manifest = Join-Path $entry.FullName 'CSXS\manifest.xml'
    if ((Test-Path -LiteralPath $manifest -PathType Leaf) -and
        (Select-String -LiteralPath $manifest -Pattern 'com\.aemcp\.panel' -Quiet)) {
        Fail-DevInstall ("another directory in the CEP scan path registers com.aemcp.panel: " +
            "$($entry.FullName). Move it out of $cepParent and retry.")
    }
}

$installId = ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '.' +
    [guid]::NewGuid().ToString('N'))
$staging = Join-Path $vault ".com.aemcp.panel.staging.$installId"
$backup = Join-Path $vault ".com.aemcp.panel.backup.$installId"
$failedInstall = Join-Path $vault ".com.aemcp.panel.failed.$installId"
$restoreReplaced = Join-Path $vault ".com.aemcp.panel.replaced.$installId"
foreach ($generated in @($staging, $backup, $failedInstall, $restoreReplaced)) {
    if (Test-Path -LiteralPath $generated) {
        Fail-DevInstall "generated deployment path already exists: $generated"
    }
}

$completed = $false
$oldMoved = $false
$stageMoveStarted = $false

try {
    Write-Host '[2/6] Staging the complete plugin tree in the vault (outside the CEP scan path)...'
    $null = New-Item -ItemType Directory -Path $staging
    foreach ($child in @(Get-ChildItem -LiteralPath $pluginSrc -Force)) {
        Copy-Item -LiteralPath $child.FullName -Destination $staging -Recurse -Force
    }

    Write-Host '[3/6] Verifying the staged tree before touching the deployed panel...'
    foreach ($relative in $requiredFiles) {
        Assert-RegularFile (Join-Path $staging $relative) "staged plugin file $relative"
    }
    Assert-TreeEqual $pluginSrc $staging

    Write-Host '[4/6] Enabling CEP PlayerDebugMode before the atomic swap...'
    10..25 | ForEach-Object {
        $key = "HKCU:\Software\Adobe\CSXS.$_"
        if (-not (Test-Path -LiteralPath $key)) {
            $null = New-Item -Path $key -Force
        }
        Set-ItemProperty -LiteralPath $key -Name 'PlayerDebugMode' -Value '1' -Type String
    }

    Write-Host '[5/6] Atomically replacing the CEP panel while retaining the old install...'
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
    Write-Host "[6/6] Installed and verified: $cepDir"
    Write-Host 'Restart After Effects, then open Window -> Extensions -> ae-mcp.'
    if ($oldMoved) {
        Write-Host "Backup retained at: $backup"
        Write-Host 'Restore command (run only while After Effects is closed):'
        $restoreTemplate = ('& {{ $ErrorActionPreference = ''Stop''; ' +
            'Move-Item -LiteralPath {0} -Destination {1}; ' +
            'Move-Item -LiteralPath {2} -Destination {3}; }}')
        $restoreCommand = ($restoreTemplate -f
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

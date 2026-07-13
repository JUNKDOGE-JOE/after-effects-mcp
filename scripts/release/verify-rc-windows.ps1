[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Artifact,
    [Parameter(Mandatory = $true)][string]$Manifest,
    [Parameter(Mandatory = $true)][string]$CandidateSha,
    [Parameter(Mandatory = $true)][string]$RunId,
    [Parameter(Mandatory = $true)][string]$ArtifactId,
    [Parameter(Mandatory = $true)][string]$CodexVersion,
    [Parameter(Mandatory = $true)][string]$Ae25Path,
    [Parameter(Mandatory = $true)][string]$Ae26Path,
    [Parameter(Mandatory = $true)][string]$ZxpInstaller,
    [Parameter(Mandatory = $true)][string]$Out,
    [Parameter(Mandatory = $true)][string]$CommentOut
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Artifact = (Resolve-Path -LiteralPath $Artifact).Path
$Manifest = (Resolve-Path -LiteralPath $Manifest).Path
$Ae25Path = (Resolve-Path -LiteralPath $Ae25Path).Path
$Ae26Path = (Resolve-Path -LiteralPath $Ae26Path).Path
$ZxpInstaller = (Resolve-Path -LiteralPath $ZxpInstaller).Path
$Out = [IO.Path]::GetFullPath($Out)
$CommentOut = [IO.Path]::GetFullPath($CommentOut)
if ($Out -ceq $CommentOut) { throw 'Attestation and comment outputs must be distinct.' }
$NodePath = (Get-Command node -ErrorAction Stop).Source
if ([IO.Path]::GetFileName($Artifact) -cne 'ae-mcp-panel-v0.9.1-windows-x64.zxp') {
    throw 'Unexpected Windows RC artifact name.'
}
if ([IO.Path]::GetFileName($Ae25Path) -cne 'AfterFX.exe' -or
    [IO.Path]::GetFileName($Ae26Path) -cne 'AfterFX.exe') {
    throw 'AE executable inputs must identify AfterFX.exe.'
}
if ($env:PROCESSOR_ARCHITECTURE -cne 'AMD64' -or
    $env:PROCESSOR_ARCHITEW6432 -ceq 'ARM64') {
    throw 'Windows RC verification requires native x64 Windows.'
}
$OsInfo = Get-CimInstance Win32_OperatingSystem
if ([int]$OsInfo.BuildNumber -lt 26100) {
    throw 'Windows RC verification requires Windows 11 24H2 or newer.'
}
$OsVersion = $OsInfo.Version

$EvidenceRoot = Join-Path ([IO.Path]::GetTempPath()) ("ae-mcp-rc-" + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $EvidenceRoot
$CurrentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$null = & icacls.exe $EvidenceRoot '/inheritance:r' "/grant:r" "${CurrentIdentity}:(OI)(CI)F"
if ($LASTEXITCODE -ne 0) { throw 'Could not protect the RC evidence directory.' }
$Commands = [System.Collections.Generic.List[object]]::new()
$Failures = [System.Collections.Generic.List[string]]::new()

function Add-Result {
    param([string]$Label, [int]$ExitCode)
    $Commands.Add([ordered]@{ command = $Label; exitCode = $ExitCode })
    if ($ExitCode -ne 0) { $Failures.Add("$Label failed") }
}

function Invoke-Recorded {
    param([string]$Label, [scriptblock]$Action)
    try {
        $null = & $Action
        Add-Result -Label $Label -ExitCode 0
        return $true
    } catch {
        Add-Result -Label $Label -ExitCode 1
        return $false
    }
}

try {
    $ManifestObject = Get-Content -Raw -LiteralPath $Manifest | ConvertFrom-Json
    $ManifestEntry = @($ManifestObject.artifacts) | Where-Object {
        $_.name -ceq [IO.Path]::GetFileName($Artifact) -and [string]$_.artifactId -ceq $ArtifactId
    }
    if (@($ManifestEntry).Count -ne 1) { throw 'Artifact is not uniquely present in the manifest.' }
    $BundleEvidence = @($ManifestObject.evidence) | Where-Object { $_.platform -ceq 'windows-x64' }
    if (@($BundleEvidence).Count -ne 1) { throw 'Windows bundle evidence is not unique.' }
    $RuntimeManifestEntry = @($BundleEvidence[0].bundleManifest.files) | Where-Object {
        $_.path -ceq 'runtime/windows-x64/runtime-manifest.json'
    }
    if (@($RuntimeManifestEntry).Count -ne 1 -or
        [string]$RuntimeManifestEntry[0].sha256 -cnotmatch '^[a-f0-9]{64}$') {
        throw 'Runtime manifest evidence is invalid.'
    }
    $ExpectedRuntimeManifestSha256 = [string]$RuntimeManifestEntry[0].sha256
    $ExpectedLauncherSha256 = ''

    $PreflightOk = $true
    if (-not (Invoke-Recorded 'Get-FileHash -Algorithm SHA256 and bind manifest' {
        $Digest = (Get-FileHash -LiteralPath $Artifact -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($Digest -cne [string]$ManifestEntry.sha256) { throw 'Artifact digest mismatch.' }
    })) { $PreflightOk = $false }

    $Extracted = Join-Path $EvidenceRoot 'zxp'
    if (-not (Invoke-Recorded 'Get-AuthenticodeSignature for every packaged executable' {
        $null = New-Item -ItemType Directory -Path $Extracted
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($Artifact, $Extracted)
        $NativeFiles = @(Get-ChildItem -LiteralPath $Extracted -Recurse -File -Filter '*.exe')
        if ($NativeFiles.Count -lt 1) { throw 'No packaged executable was found.' }
        foreach ($NativeFile in $NativeFiles) {
            $Signature = Get-AuthenticodeSignature -LiteralPath $NativeFile.FullName
            if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
                throw 'Packaged executable signature is invalid.'
            }
        }
        $PackagedLauncher = Join-Path $Extracted 'platform\windows-x64\bin\ae-mcp.exe'
        if (-not (Test-Path -LiteralPath $PackagedLauncher -PathType Leaf) -or
            (Get-Item -LiteralPath $PackagedLauncher).LinkType) {
            throw 'Signed ZXP launcher evidence is missing.'
        }
        $script:ExpectedLauncherSha256 = (
            Get-FileHash -LiteralPath $PackagedLauncher -Algorithm SHA256
        ).Hash.ToLowerInvariant()
        if ($script:ExpectedLauncherSha256 -cnotmatch '^[a-f0-9]{64}$') {
            throw 'Signed ZXP launcher digest is invalid.'
        }
    })) { $PreflightOk = $false }

    if ($PreflightOk) {
        if (-not (Invoke-Recorded 'install exact signed ZXP' {
            & $ZxpInstaller '--install' $Artifact
            if ($LASTEXITCODE -ne 0) { throw 'ZXP installer failed.' }
        })) { $PreflightOk = $false }
    }

    $Ae25Version = '25.0-unavailable'
    $Ae26Version = '26.0-unavailable'
    try { $Ae25Version = (Get-Item -LiteralPath $Ae25Path).VersionInfo.ProductVersion } catch {}
    try { $Ae26Version = (Get-Item -LiteralPath $Ae26Path).VersionInfo.ProductVersion } catch {}
    if ($Ae25Version -notmatch '^25\.') { $Failures.Add('AE 25 version identity failed'); $PreflightOk = $false }
    if ($Ae26Version -notmatch '^26\.') { $Failures.Add('AE 26 version identity failed'); $PreflightOk = $false }

    $Launcher = Join-Path $env:USERPROFILE '.ae-mcp\bin\ae-mcp.exe'
    $RuntimeManifest = Join-Path $env:USERPROFILE '.ae-mcp\runtime\0.9.1\windows-x64\runtime-manifest.json'
    $Ae25Smoke = Join-Path $EvidenceRoot 'ae-mcp-ae25-smoke.json'
    $Ae26Smoke = Join-Path $EvidenceRoot 'ae-mcp-ae26-smoke.json'

    function Invoke-AeSmoke {
        param([string]$AePath, [int]$Major, [string]$SmokeOut)
        $AeProcess = $null
        try {
            $AeProcess = Start-Process -FilePath $AePath -PassThru
            for ($Attempt = 0; $Attempt -lt 60; $Attempt++) {
                if ((Test-Path -LiteralPath $Launcher -PathType Leaf) -and
                    (Test-Path -LiteralPath $RuntimeManifest -PathType Leaf)) { break }
                Start-Sleep -Seconds 2
            }
            if (-not (Test-Path -LiteralPath $Launcher -PathType Leaf) -or
                -not (Test-Path -LiteralPath $RuntimeManifest -PathType Leaf)) {
                throw 'Installed runtime did not appear.'
            }
            & $NodePath (Join-Path $RepoRoot 'scripts\release\smoke-installed-runtime.mjs') `
                --launcher $Launcher `
                --runtime-manifest $RuntimeManifest `
                --expected-platform windows-x64 `
                --expected-version 0.9.1 `
                --expected-runtime-manifest-sha256 $ExpectedRuntimeManifestSha256 `
                --expected-launcher-sha256 $ExpectedLauncherSha256 `
                --expected-ae-major ([string]$Major) `
                --out $SmokeOut
            if ($LASTEXITCODE -ne 0) { throw 'Installed-runtime smoke failed.' }
            Add-Result -Label "AE $Major installed-runtime smoke" -ExitCode 0
            return $true
        } catch {
            Add-Result -Label "AE $Major installed-runtime smoke" -ExitCode 1
            return $false
        } finally {
            if ($null -ne $AeProcess -and -not $AeProcess.HasExited) {
                $null = $AeProcess.CloseMainWindow()
                if (-not $AeProcess.WaitForExit(15000)) { Stop-Process -Id $AeProcess.Id -Force }
            }
        }
    }

    $Ae25Result = 'FAIL'
    $Ae26Result = 'FAIL'
    if ($PreflightOk -and (Invoke-AeSmoke -AePath $Ae25Path -Major 25 -SmokeOut $Ae25Smoke)) {
        $Ae25Result = 'PASS'
    }
    if ($PreflightOk -and (Invoke-AeSmoke -AePath $Ae26Path -Major 26 -SmokeOut $Ae26Smoke)) {
        $Ae26Result = 'PASS'
    }
    if (-not $PreflightOk) { $Failures.Add('Installed-runtime smoke skipped because RC preflight failed') }

    $CommandsJson = ConvertTo-Json -Compress -Depth 4 -InputObject @($Commands)
    $FailuresJson = ConvertTo-Json -Compress -InputObject @($Failures)
    & $NodePath (Join-Path $RepoRoot 'scripts\release\write-attestation.mjs') `
        --platform windows-x64 `
        --candidate-sha $CandidateSha `
        --run-id $RunId `
        --artifact-id $ArtifactId `
        --artifact $Artifact `
        --manifest $Manifest `
        --os-version "Windows $OsVersion" `
        --codex-version $CodexVersion `
        --ae25-version $Ae25Version `
        --ae25-result $Ae25Result `
        --ae26-version $Ae26Version `
        --ae26-result $Ae26Result `
        --commands-json $CommandsJson `
        --failures-json $FailuresJson `
        --out $Out `
        --comment-out $CommentOut
    if ($LASTEXITCODE -ne 0) { throw 'Attestation writer failed.' }
    foreach ($ProtectedOutput in @($Out, $CommentOut)) {
        $null = & icacls.exe $ProtectedOutput '/inheritance:r' "/grant:r" "${CurrentIdentity}:F"
        if ($LASTEXITCODE -ne 0) { throw 'Could not protect an attestation output.' }
    }
} finally {
    if (Test-Path -LiteralPath $EvidenceRoot) {
        Remove-Item -LiteralPath $EvidenceRoot -Recurse -Force
    }
}

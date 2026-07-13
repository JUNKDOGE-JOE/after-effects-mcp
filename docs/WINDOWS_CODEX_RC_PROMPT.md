# Windows x64 RC verifier handoff

Copy this prompt into Codex on the Windows verifier. Replace every required input with the immutable value from the merged RC PR; do not add a branch name or a “latest” artifact alias.

```text
You are the Windows x64 release verifier for ae-mcp. Test and report only; do not modify files, commit, push, or rebuild artifacts.

1. Fetch the repository and checkout the exact candidate SHA supplied below.
2. Confirm `git status --short` is empty and `git rev-parse HEAD` equals the candidate SHA.
3. Download only the specified GitHub Actions run/artifact ID.
4. Run `scripts/release/verify-rc-windows.ps1` with the supplied artifact and manifest.
5. Exercise AE 25.x and AE 26.x using the script checklist; capture failure evidence without changing source.
6. Post the exact comment emitted by `write-attestation.mjs` to the supplied merged RC PR.
7. If any step fails, report FAIL. Never convert a partial run into PASS.

Required inputs: repository, merged RC PR number, candidate SHA, workflow run ID, artifact ID, artifact filename, manifest filename.
```

The block above is the immutable instruction block from the release plan. Copy the complete template below into Windows Codex after replacing every angle-bracket placeholder. Do not use it with a branch, `latest`, a rerun, or an artifact name that differs by case.

The complete handoff additionally needs the two artifact IDs (the Windows ZXP and manifest), the exact AE 25 and AE 26 `AfterFX.exe` paths, the supported ZXP installer executable, and the current Windows Codex version. Run every PowerShell block in one PowerShell Core (`pwsh`) 7.3-or-newer session; the first block fails closed on any other shell or version.

````text
Use these immutable inputs exactly:

```powershell
if ($PSVersionTable.PSEdition -cne 'Core' -or
    $PSVersionTable.PSVersion -lt [version]'7.3') {
    throw 'Run the complete handoff in PowerShell Core 7.3 or newer (pwsh).'
}

$Repository = '<OWNER/REPOSITORY>'
$PrNumber = '<MERGED_RC_PR_NUMBER>'
$CandidateSha = '<CANDIDATE_SHA>'
$BuildRunId = '<BUILD_RUN_ID>'
$WindowsArtifactId = '<WINDOWS_ARTIFACT_ID>'
$WindowsArtifactName = 'ae-mcp-panel-v0.9.2-windows-x64.zxp'
$ManifestArtifactId = '<MANIFEST_ARTIFACT_ID>'
$ManifestArtifactName = 'artifact-manifest-v0.9.2.json'
$Ae25Path = '<AE25_AFTERFX_EXE>'
$Ae26Path = '<AE26_AFTERFX_EXE>'
$ZxpInstaller = '<ZXP_INSTALLER>'
$CodexVersion = '<CODEX_VERSION>'
```

Do not proceed while any placeholder remains. The build workflow `run_attempt` must equal 1. The two required artifact IDs, exact names, and not expired metadata must all agree. Treat every mismatch, duplicate, missing field, API error, ambiguous file, dirty checkout, or partial verifier run as fail closed.

The release verifier must expose the tested `-CommentOut` pass-through to the writer's tested `--comment-out` interface. That interface, rather than PowerShell stdout capture, must create one new UTF-8 comment file containing exactly `encodeAttestationComment(report)`. If the interface is absent, the file already exists, the writer does not create it, or its contract tests have not passed, post nothing and report a blocker.

1. Authenticate and verify the merged RC PR before downloading anything.

   - Run `gh auth status` for the account that is allowlisted to attest.
   - Read `repos/$Repository/pulls/$PrNumber` with `gh api`.
   - Require `merged == true`, `base.ref == main`, the repository identity to equal `$Repository`, and `merge_commit_sha` to equal `$CandidateSha`. This is the only PR that may receive the result.

2. Verify the exact build run and both artifact identities with GitHub APIs.

```powershell
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$PSNativeCommandUseErrorActionPreference = $true

$RequiredInputValues = @(
    $Repository, $PrNumber, $CandidateSha, $BuildRunId, $WindowsArtifactId,
    $ManifestArtifactId, $Ae25Path, $Ae26Path, $ZxpInstaller, $CodexVersion)
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or
    $PrNumber -notmatch '^[1-9][0-9]*$' -or
    $CandidateSha -cnotmatch '^[a-f0-9]{40}$' -or
    $BuildRunId -notmatch '^[1-9][0-9]*$' -or
    $WindowsArtifactId -notmatch '^[1-9][0-9]*$' -or
    $ManifestArtifactId -notmatch '^[1-9][0-9]*$' -or
    $RequiredInputValues.Where({
        [string]::IsNullOrWhiteSpace([string]$_) -or [string]$_ -match '<[^>]+>'
    }).Count -ne 0) {
    throw 'Required handoff inputs are missing or invalid.'
}

gh auth status | Out-Host
$Pr = gh api "repos/$Repository/pulls/$PrNumber" | ConvertFrom-Json -Depth 100
if ($Pr.merged -ne $true -or $Pr.base.ref -cne 'main' -or
    $Pr.base.repo.full_name -cne $Repository -or
    $Pr.merge_commit_sha -cne $CandidateSha) {
    throw 'The merged PR merge_commit_sha does not identify the candidate.'
}

$Run = gh api "repos/$Repository/actions/runs/$BuildRunId" |
    ConvertFrom-Json -Depth 100
$RunPath = ([string]$Run.path).Split('@')[0]
if ([string]$Run.id -cne $BuildRunId -or [int]$Run.run_attempt -ne 1 -or
    $Run.event -cne 'workflow_dispatch' -or $Run.status -cne 'completed' -or
    $Run.conclusion -cne 'success' -or $Run.head_sha -cne $CandidateSha -or
    $Run.head_branch -cne 'main' -or
    $RunPath -cne '.github/workflows/build-rc.yml' -or
    $Run.repository.full_name -cne $Repository -or
    $Run.head_repository.full_name -cne $Repository) {
    throw 'Build run identity, run_attempt, or conclusion is invalid.'
}
$Workflow = gh api "repos/$Repository/actions/workflows/$($Run.workflow_id)" |
    ConvertFrom-Json -Depth 100
if ($Workflow.path -cne '.github/workflows/build-rc.yml' -or
    $Workflow.state -cne 'active') {
    throw 'Build workflow identity is invalid.'
}

$Pages = gh api --paginate --slurp `
    "repos/$Repository/actions/runs/$BuildRunId/artifacts?per_page=100" |
    ConvertFrom-Json -Depth 100
$Artifacts = @($Pages | ForEach-Object { @($_.artifacts) })

function Get-ExactArtifactMetadata {
    param([string]$Id, [string]$Name)
    $ById = @($Artifacts | Where-Object { [string]$_.id -ceq $Id })
    $ByName = @($Artifacts | Where-Object { $_.name -ceq $Name })
    if ($ById.Count -ne 1 -or $ByName.Count -ne 1 -or
        [string]$ById[0].id -cne [string]$ByName[0].id -or
        $ById[0].name -cne $Name -or $ById[0].expired -ne $false -or
        [int64]$ById[0].size_in_bytes -le 0) {
        throw "Artifact ID, exact name, and not expired identity failed: $Name"
    }
    return $ById[0]
}

$null = Get-ExactArtifactMetadata $WindowsArtifactId $WindowsArtifactName
$null = Get-ExactArtifactMetadata $ManifestArtifactId $ManifestArtifactName
```

3. Create an isolated checkout and download by the exact run plus exact artifact name.

```powershell
$Root = Join-Path $env:TEMP ("ae-mcp-windows-rc-" + [guid]::NewGuid().ToString('N'))
$Checkout = Join-Path $Root 'repo'
$WindowsDownload = Join-Path $Root 'windows-artifact'
$ManifestDownload = Join-Path $Root 'manifest-artifact'
$EvidenceRoot = Join-Path $Root 'evidence'
$null = New-Item -ItemType Directory -Path $Root, $EvidenceRoot

gh repo clone $Repository $Checkout -- --no-checkout
Push-Location $Checkout
try {
    git fetch --no-tags origin $CandidateSha
    git checkout --detach $CandidateSha
    if ((git rev-parse HEAD) -cne $CandidateSha -or
        (git status --porcelain=v1 --untracked-files=all).Count -ne 0) {
        throw 'Exact-SHA checkout is not clean.'
    }
} finally {
    Pop-Location
}

gh run download $BuildRunId --repo $Repository --name $WindowsArtifactName `
    --dir $WindowsDownload
gh run download $BuildRunId --repo $Repository --name $ManifestArtifactName `
    --dir $ManifestDownload

function Get-UniqueDownloadedFile {
    param([string]$RootPath, [string]$Name)
    $Matches = @(Get-ChildItem -LiteralPath $RootPath -Recurse -File |
        Where-Object { $_.Name -ceq $Name })
    if ($Matches.Count -ne 1) { throw "Downloaded file is missing or ambiguous: $Name" }
    return $Matches[0].FullName
}

$WindowsArtifact = Get-UniqueDownloadedFile $WindowsDownload $WindowsArtifactName
$Manifest = Get-UniqueDownloadedFile $ManifestDownload $ManifestArtifactName
$ManifestObject = Get-Content -Raw -Encoding utf8 -LiteralPath $Manifest |
    ConvertFrom-Json -Depth 100
$ManifestEntries = @($ManifestObject.artifacts | Where-Object {
    [string]$_.artifactId -ceq $WindowsArtifactId -and
    $_.name -ceq $WindowsArtifactName -and $_.platform -ceq 'windows-x64' -and
    $_.role -ceq 'install'
})
$ArtifactSha256 = (Get-FileHash -LiteralPath $WindowsArtifact -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ManifestObject.candidateSha -cne $CandidateSha -or
    [string]$ManifestObject.workflowRunId -cne $BuildRunId -or
    $ManifestEntries.Count -ne 1 -or $ManifestEntries[0].sha256 -cne $ArtifactSha256) {
    throw 'Downloaded manifest does not bind the exact candidate, run, artifact ID, name, and SHA-256.'
}
```

4. Prepare the two real AE applications before starting the verifier.

   - AE 25 `AfterFX.exe` is supplied by `$Ae25Path`; AE 26 `AfterFX.exe` is supplied by `$Ae26Path`.
   - `$Ae25Path` and `$Ae26Path` must be existing, distinct files whose exact basename is `AfterFX.exe`; `$ZxpInstaller` must be the exact installed ZXP installer executable, and `$CodexVersion` must be the current Windows Codex version string.
   - There must be no unsaved AE work anywhere on the machine. Save and close every existing After Effects project first; never dismiss a save prompt or discard work.
   - The verifier launches AE 25 and AE 26 sequentially. For each version, use the GUI to open `Window -> Extensions -> ae-mcp` (or the equivalent Extensions submenu) and keep the ae-mcp panel open so its installed runtime becomes available. A headless process launch without opening the ae-mcp panel is not acceptance.

5. Run the exact verifier and consume only its direct comment file. Do not capture or publish the wrapper's stdout.

   The Node writer currently runs inside a PowerShell wrapper. An outer process capture receives the PowerShell success stream, not the raw Node writer stdout bytes; PowerShell may decode by line and re-encode with different newlines. A strict UTF-8 round trip over those captured bytes only proves that the re-encoded result is internally consistent. It cannot prove equality with the writer bytes. Therefore `RedirectStandardOutput`, `BaseStream.CopyToAsync`, pipelines, shell redirection, and reconstruction from the attestation JSON are forbidden for the comment body.

```powershell
foreach ($Path in @($Ae25Path, $Ae26Path, $ZxpInstaller)) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required executable is missing: $Path"
    }
}
if ([IO.Path]::GetFileName($Ae25Path) -cne 'AfterFX.exe' -or
    [IO.Path]::GetFileName($Ae26Path) -cne 'AfterFX.exe' -or
    [IO.Path]::GetFullPath($Ae25Path) -ceq [IO.Path]::GetFullPath($Ae26Path)) {
    throw 'AE 25 and AE 26 must be distinct AfterFX.exe files.'
}

$AttestationOut = Join-Path $EvidenceRoot 'windows-attestation.json'
$CommentBodyPath = Join-Path $EvidenceRoot 'comment-body.utf8'
if ((Test-Path -LiteralPath $AttestationOut) -or
    (Test-Path -LiteralPath $CommentBodyPath)) {
    throw 'Verifier output paths must not exist before the run.'
}

$VerifierNativeErrorPreference = $PSNativeCommandUseErrorActionPreference
try {
    # Preserve the exit code for canonical FAIL handling; all other native calls
    # retain fail-closed error behavior.
    $PSNativeCommandUseErrorActionPreference = $false
    & (Get-Command pwsh.exe -ErrorAction Stop).Source -NoProfile -File `
        (Join-Path $Checkout 'scripts\release\verify-rc-windows.ps1') `
        -Artifact $WindowsArtifact -Manifest $Manifest `
        -CandidateSha $CandidateSha -RunId $BuildRunId `
        -ArtifactId $WindowsArtifactId -CodexVersion $CodexVersion `
        -Ae25Path $Ae25Path -Ae26Path $Ae26Path `
        -ZxpInstaller $ZxpInstaller -Out $AttestationOut `
        -CommentOut $CommentBodyPath
    $VerifierExit = $LASTEXITCODE
} finally {
    $PSNativeCommandUseErrorActionPreference = $VerifierNativeErrorPreference
}

if (-not (Test-Path -LiteralPath $AttestationOut -PathType Leaf) -or
    -not (Test-Path -LiteralPath $CommentBodyPath -PathType Leaf)) {
    throw 'The verifier did not create both exclusive output files; post nothing and report a blocker.'
}
$CommentBytes = [IO.File]::ReadAllBytes($CommentBodyPath)

$Utf8Strict = [Text.UTF8Encoding]::new($false, $true)
try { $CommentBody = $Utf8Strict.GetString($CommentBytes) }
catch { throw 'The direct comment file is not one complete UTF-8 body; do not comment.' }
if ($CommentBytes.Length -eq 0 -or
    [Convert]::ToHexString($Utf8Strict.GetBytes($CommentBody)) -cne
      [Convert]::ToHexString($CommentBytes)) {
    throw 'The direct comment file did not survive a strict UTF-8 read; do not comment.'
}
```

Run the checked-in read-only validator before any comment inventory or POST. It must exit zero without stdout and without changing either file:

```powershell
& (Get-Command node.exe -ErrorAction Stop).Source `
    (Join-Path $Checkout 'scripts\release\validate-attestation-comment.mjs') `
    --comment $CommentBodyPath `
    --report $AttestationOut `
    --platform 'windows-x64' `
    --candidate-sha $CandidateSha `
    --run-id $BuildRunId `
    --artifact-id $WindowsArtifactId `
    --artifact-name $WindowsArtifactName `
    --artifact-sha256 $ArtifactSha256 `
    --verifier-exit ([string]$VerifierExit)
if ($LASTEXITCODE -ne 0) {
    throw 'Canonical attestation comment validation failed; post nothing and report a blocker.'
}
```

The validator requires exactly one marker and one fenced canonical JSON report, and requires all of these fields before any comment call:

- `platform == windows-x64`;
- `candidateSha == $CandidateSha`;
- `workflowRunId == $BuildRunId`;
- `artifactId == $WindowsArtifactId`;
- `artifactName == $WindowsArtifactName`;
- `artifactSha256 == $ArtifactSha256`;
- `result` is exactly `PASS` or `FAIL`.

Also require the decoded body to equal the report in `$AttestationOut`. If `$VerifierExit` is nonzero, only a fully valid canonical `FAIL` may continue; a `PASS` from a nonzero or partial run is a blocker. Never reconstruct, trim, reformat, or regenerate the direct comment file, and never turn partial evidence into PASS.

6. Read all PR comments, require a strictly zero-match idempotency inventory, create exactly one comment from a temporary JSON request file, then read back that same comment ID. Do not put the multiline body in a command-line field, and do not retry a failed or mismatched POST with a second comment.

   Any malformed or invalid marker-bearing entry in all PR comments must block posting. Across platform, candidate, run, and artifact ID/name/SHA-256, the number of exact existing matches must be strictly zero before the one POST.

   Exactly one Windows verifier session may hold coordination ownership for the same candidate/run/artifact identity. The zero-match inventory check and the POST are not atomic because GitHub issue comments provide no compare-and-swap operation. Forbid concurrent verifier runs; if exclusive coordination cannot be proven, post nothing and report a blocker.

```powershell
if ((git -C $Checkout status --porcelain=v1 --untracked-files=all).Count -ne 0) {
    throw 'Checkout changed during verification; do not comment.'
}

$Marker = '<!-- ae-mcp-rc-attestation:v1 -->'
$CommentInventoryPath = Join-Path $EvidenceRoot 'existing-pr-comments.json'
if (Test-Path -LiteralPath $CommentInventoryPath) {
    throw 'The PR comment inventory path must not already exist.'
}
$CommentPages = gh api --paginate --slurp `
    "repos/$Repository/issues/$PrNumber/comments?per_page=100" |
    ConvertFrom-Json -Depth 100 -NoEnumerate
$AllPrComments = @(
    foreach ($Page in @($CommentPages)) {
        foreach ($ExistingComment in @($Page)) { $ExistingComment }
    }
)
$CommentInventoryJson = ConvertTo-Json -Depth 100 -Compress -InputObject $AllPrComments
$CommentInventoryBytes = $Utf8Strict.GetBytes($CommentInventoryJson)
$CommentInventoryStream = [IO.File]::Open(
    $CommentInventoryPath, [IO.FileMode]::CreateNew,
    [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
    $CommentInventoryStream.Write(
        $CommentInventoryBytes, 0, $CommentInventoryBytes.Length)
} finally { $CommentInventoryStream.Dispose() }

$env:AE_MCP_COMMENT_INVENTORY = $CommentInventoryPath
$env:AE_MCP_REPO_CHECKOUT = $Checkout
$env:AE_MCP_EXPECTED_PLATFORM = 'windows-x64'
$env:AE_MCP_EXPECTED_CANDIDATE = $CandidateSha
$env:AE_MCP_EXPECTED_RUN = $BuildRunId
$env:AE_MCP_EXPECTED_ARTIFACT_ID = $WindowsArtifactId
$env:AE_MCP_EXPECTED_ARTIFACT_NAME = $WindowsArtifactName
$env:AE_MCP_EXPECTED_ARTIFACT_SHA256 = $ArtifactSha256
& (Get-Command node.exe -ErrorAction Stop).Source --input-type=module -e @'
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const root = process.env.AE_MCP_REPO_CHECKOUT.replaceAll('\\', '/');
const moduleUrl = (name) => pathToFileURL(`${root}/scripts/release/${name}`).href;
const { decodeAttestationComment } = await import(moduleUrl('comment-marker.mjs'));
const { validateAttestation } = await import(moduleUrl('attestation.mjs'));
const marker = '<!-- ae-mcp-rc-attestation:v1 -->';
const comments = JSON.parse(await readFile(process.env.AE_MCP_COMMENT_INVENTORY, 'utf8'));
if (!Array.isArray(comments)) throw new Error('PR comment inventory is invalid');
let exactMatches = 0;
for (const comment of comments) {
  const body = String(comment?.body ?? '');
  if (!body.includes(marker)) continue;
  if (!/^[1-9][0-9]*$/.test(String(comment?.id ?? ''))) {
    throw new Error('a marker-bearing PR comment has no stable ID');
  }
  let report;
  try { report = decodeAttestationComment(body); }
  catch { throw new Error(`malformed attestation marker comment blocks posting: ${comment.id}`); }
  const errors = validateAttestation(report);
  if (errors.length) {
    throw new Error(`invalid attestation marker comment blocks posting: ${comment.id}`);
  }
  if (report.platform === process.env.AE_MCP_EXPECTED_PLATFORM
      && report.candidateSha === process.env.AE_MCP_EXPECTED_CANDIDATE
      && String(report.workflowRunId) === process.env.AE_MCP_EXPECTED_RUN
      && String(report.artifactId) === process.env.AE_MCP_EXPECTED_ARTIFACT_ID
      && report.artifactName === process.env.AE_MCP_EXPECTED_ARTIFACT_NAME
      && report.artifactSha256 === process.env.AE_MCP_EXPECTED_ARTIFACT_SHA256) {
    exactMatches += 1;
  }
}
if (exactMatches !== 0) {
  throw new Error('platform/candidate/run/artifact attestation matches must be strictly zero');
}
'@
if ($LASTEXITCODE -ne 0) {
    throw 'The complete PR comment inventory is malformed, invalid, or non-idempotent; block.'
}

$RequestPath = Join-Path $EvidenceRoot 'github-comment-request.json'
if (Test-Path -LiteralPath $RequestPath) {
    throw 'The temporary GitHub request path must not already exist.'
}
$RequestJson = ConvertTo-Json -Compress -InputObject @{ body = $CommentBody }
$RequestBytes = $Utf8Strict.GetBytes($RequestJson)
$RequestStream = [IO.File]::Open(
    $RequestPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $RequestStream.Write($RequestBytes, 0, $RequestBytes.Length) }
finally { $RequestStream.Dispose() }

# This is the only comment-creation call in the handoff. --input avoids Windows
# command-line length limits and multiline argument rewriting.
# A timeout, transport error, truncated response, or any other uncertain POST
# outcome has unknown outcome: never retry and never issue a second POST.
$Created = gh api --method POST "repos/$Repository/issues/$PrNumber/comments" `
    --input $RequestPath | ConvertFrom-Json -Depth 100
$CommentId = [string]$Created.id
if ($CommentId -notmatch '^[1-9][0-9]*$') {
    throw 'GitHub did not return one comment ID; do not retry the POST.'
}
$ReadBack = gh api "repos/$Repository/issues/comments/$CommentId" |
    ConvertFrom-Json -Depth 100
if ([string]$ReadBack.id -cne $CommentId -or
    $ReadBack.issue_url -notmatch "/issues/$PrNumber$" -or
    $ReadBack.body -cne $CommentBody -or
    [Convert]::ToHexString($Utf8Strict.GetBytes([string]$ReadBack.body)) -cne
      [Convert]::ToHexString($CommentBytes)) {
    throw 'The same comment ID could not be read back byte-for-text unchanged; do not post again.'
}

$ReadBackBodyPath = Join-Path $EvidenceRoot 'read-back-comment.utf8'
$ReadBackBytes = $Utf8Strict.GetBytes([string]$ReadBack.body)
$ReadBackStream = [IO.File]::Open(
    $ReadBackBodyPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $ReadBackStream.Write($ReadBackBytes, 0, $ReadBackBytes.Length) }
finally { $ReadBackStream.Dispose() }
& (Get-Command node.exe -ErrorAction Stop).Source `
    (Join-Path $Checkout 'scripts\release\validate-attestation-comment.mjs') `
    --comment $ReadBackBodyPath --report $AttestationOut `
    --platform 'windows-x64' --candidate-sha $CandidateSha `
    --run-id $BuildRunId --artifact-id $WindowsArtifactId `
    --artifact-name $WindowsArtifactName --artifact-sha256 $ArtifactSha256 `
    --verifier-exit ([string]$VerifierExit)
if ($LASTEXITCODE -ne 0) {
    throw 'The same comment ID failed canonical field validation; do not post again.'
}
```

Decode the read-back body again and recheck the marker, candidate SHA, workflow run ID, Windows artifact ID, exact artifact name, and artifact SHA-256 field by field. Report the one comment URL/ID and PASS or FAIL result locally. If a valid canonical FAIL exists, post that exact FAIL body once. If no valid complete FAIL exists, post nothing and report a blocker. Never reconstruct a comment and never post PASS after any partial, ambiguous, dirty, or mismatched step.
````

Before posting, resolve the supplied repository and PR number from the Windows machine and verify that the candidate SHA belongs to that PR. The emitted comment must be resolvable on the current PR: post the direct `-CommentOut` file unchanged as one PR comment via a temporary JSON `--input` request, then read that same comment back and confirm the attestation marker, candidate SHA, workflow run ID, artifact ID, and artifact SHA-256 are visible. If the PR cannot be resolved, the direct comment file is unavailable, or the comment cannot be read back, report FAIL and do not post a reconstructed comment.

The verifier may inspect repository tests for diagnosis after a failure, but the only release result comes from the exact downloaded artifact and the installed-runtime smoke. It must not rebuild the artifact or edit the checkout.

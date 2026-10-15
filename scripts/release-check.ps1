$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$requiredFiles = @('manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.js', 'license-config.js', 'icon.png')

foreach ($file in $requiredFiles) {
  if (-not (Test-Path (Join-Path $projectRoot $file))) { throw "Missing required file: $file" }
}

$manifest = Get-Content (Join-Path $projectRoot 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.manifest_version -ne 3) { throw 'Manifest V3 is required.' }
if ([version]$manifest.version -le [version]'2.3') { throw 'Release version must be greater than 2.3.' }
if ($manifest.permissions -notcontains 'downloads') { throw 'The downloads permission is required for verified exports.' }
if ($manifest.host_permissions -contains 'https://*.workers.dev/*') { throw 'Replace the broad workers.dev permission with the exact deployed Worker origin before release.' }

$licenseConfig = Get-Content (Join-Path $projectRoot 'license-config.js') -Raw
if ($licenseConfig -match 'TWIMARK_LICENSE_API_BASE\s*=\s*""') { throw 'Set TWIMARK_LICENSE_API_BASE to the deployed Worker URL before release.' }
if ($licenseConfig -match 'PLAN-UUID') { throw 'Replace the placeholder TWIMARK_PLANS checkout URLs (MONTHLY/ANNUAL/LIFETIME-PLAN-UUID) with the Lemon Squeezy template links before release.' }
if ($licenseConfig -notmatch 'TWIMARK_FREE_POSTS_PER_THREAD') { throw 'license-config.js must define TWIMARK_FREE_POSTS_PER_THREAD for the free-tier truncation hook.' }

# Use whichever Node is on PATH. Fail loudly if none is found: silently
# skipping the syntax and regression checks would let a broken build ship.
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'Node.js was not found on PATH. Install Node 18+ so release checks can run.' }
$node = $nodeCommand.Source

foreach ($file in @('background.js', 'content.js', 'popup.js', 'license-config.js', 'workers/license-gateway/src/index.js')) {
  & $node --check (Join-Path $projectRoot $file)
  if ($LASTEXITCODE -ne 0) { throw "JavaScript syntax check failed: $file" }
}
& $node (Join-Path $projectRoot 'test\content-scan.test.mjs')
if ($LASTEXITCODE -ne 0) { throw 'content.js test suite failed.' }
& $node (Join-Path $projectRoot 'workers\license-gateway\test\run-tests.mjs')
if ($LASTEXITCODE -ne 0) { throw 'License gateway test suite failed.' }

Write-Host "Release checks passed for Twimark v$($manifest.version)."

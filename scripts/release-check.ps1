$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$requiredFiles = @('manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.js', 'icon.png')

foreach ($file in $requiredFiles) {
  if (-not (Test-Path (Join-Path $projectRoot $file))) { throw "Missing required file: $file" }
}

$manifest = Get-Content (Join-Path $projectRoot 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.manifest_version -ne 3) { throw 'Manifest V3 is required.' }
if ([version]$manifest.version -le [version]'2.3') { throw 'Release version must be greater than 2.3.' }
if ($manifest.permissions -notcontains 'downloads') { throw 'The downloads permission is required for verified exports.' }

$node = 'C:\Users\moham\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
if (Test-Path $node) {
  foreach ($file in @('background.js', 'content.js', 'popup.js')) {
    & $node --check (Join-Path $projectRoot $file)
    if ($LASTEXITCODE -ne 0) { throw "JavaScript syntax check failed: $file" }
  }
}

Write-Host "Release checks passed for Twimark v$($manifest.version)."

param([string]$OutputDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'release'))

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot 'release-check.ps1')

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$manifest = Get-Content (Join-Path $projectRoot 'manifest.json') -Raw | ConvertFrom-Json
$zip = Join-Path $OutputDirectory "twimark-$($manifest.version).zip"
if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }

$files = @('manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.js', 'icon.png')
Compress-Archive -Path ($files | ForEach-Object { Join-Path $projectRoot $_ }) -DestinationPath $zip -Force
Write-Host "Created $zip"

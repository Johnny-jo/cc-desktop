$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$versions = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'cpa-release.json') -Raw | ConvertFrom-Json
if ($versions.backend -notmatch '^8\.\d+\.\d+$' -or $versions.panel -notmatch '^\d+\.\d+\.\d+$') {
    throw 'Invalid pinned CPA release versions'
}
$destination = Join-Path $projectRoot "tools\cpa\$($versions.backend)"
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$archive = Join-Path $destination 'release.zip'
$backendUrl = "https://github.com/router-for-me/CLIProxyAPI/releases/download/v$($versions.backend)/CLIProxyAPI_$($versions.backend)_windows_amd64.zip"
$panelUrl = "https://github.com/router-for-me/Cli-Proxy-API-Management-Center/releases/download/v$($versions.panel)/management.html"
Write-Output "Downloading CPA $($versions.backend) and management panel $($versions.panel)"
Invoke-WebRequest -UseBasicParsing -Uri $backendUrl -OutFile $archive
Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force
$staticDir = Join-Path $destination 'static'
New-Item -ItemType Directory -Force -Path $staticDir | Out-Null
Invoke-WebRequest -UseBasicParsing -Uri $panelUrl -OutFile (Join-Path $staticDir 'management.html')
Write-Output "Prepared source files in $destination. Run pnpm prepare:vendor:cpa next."

# One-shot installer for viberelay on Windows (PowerShell).
#
#   irm https://github.com/<owner>/<repo>/releases/latest/download/install.ps1 | iex
#
# Environment overrides (set before invoking):
#   $env:VIBERELAY_VERSION  pin a release tag (default: latest)
#   $env:VIBERELAY_PREFIX   install prefix (default: $HOME\.viberelay)
#   $env:VIBERELAY_REPO     GitHub repo slug (default: YusufLisawi/viberelay)

$ErrorActionPreference = "Stop"

$Repo    = if ($env:VIBERELAY_REPO)    { $env:VIBERELAY_REPO }    else { "YusufLisawi/viberelay" }
$Version = if ($env:VIBERELAY_VERSION) { $env:VIBERELAY_VERSION } else { "latest" }
$Prefix  = if ($env:VIBERELAY_PREFIX)  { $env:VIBERELAY_PREFIX }  else { Join-Path $HOME ".viberelay" }

$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { throw "viberelay only ships 64-bit builds" }
$target = "bun-windows-$arch"
$asset = "viberelay-$target.zip"
$url = if ($Version -eq "latest") {
  "https://github.com/$Repo/releases/latest/download/$asset"
} else {
  "https://github.com/$Repo/releases/download/$Version/$asset"
}

$tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP "viberelay-install-$(Get-Random)")
try {
  Write-Host "→ downloading $url"
  $zip = Join-Path $tmp $asset
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

  Write-Host "→ extracting to $Prefix"
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $payload = Join-Path $tmp "viberelay-$target"

  if (Test-Path $Prefix) { Remove-Item -Recurse -Force $Prefix }
  New-Item -ItemType Directory -Path $Prefix | Out-Null
  Copy-Item -Recurse -Force "$payload\*" $Prefix

  $binDir = Join-Path $Prefix "bin"
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($userPath -notlike "*$binDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$binDir", "User")
    Write-Host "→ added $binDir to user PATH (restart shell to pick it up)"
  }

  Write-Host "✓ installed to $Prefix"
  Write-Host "run: viberelay status"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

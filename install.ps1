# KovaPresets installer.
#
#   irm https://pyvno.xyz/install.ps1 | iex
#
# Downloads the newest release from GitHub and runs it. No admin rights needed -
# KovaPresets installs for the current user only.

$ErrorActionPreference = 'Stop'
# Invoke-WebRequest renders a progress bar per chunk, which makes a ~100 MB
# download take minutes instead of seconds. Off for the duration.
$prevProgress = $ProgressPreference
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = 'pyvnoaim/kovapresets'
$installer = $null

try {
  Write-Host ''
  Write-Host '  KovaPresets' -ForegroundColor White
  Write-Host '  Presets for KovaaK'"'"'s - crosshairs, themes, sounds, HUD.' -ForegroundColor DarkGray
  Write-Host ''

  Write-Host '  Looking up the latest release...' -ForegroundColor DarkGray
  $release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{
    'User-Agent' = 'kovapresets-install'
  }
  $asset = $release.assets | Where-Object { $_.name -like '*.exe' } | Select-Object -First 1
  if (-not $asset) { throw "The latest release ($($release.tag_name)) has no installer attached." }

  $sizeMb = [math]::Round($asset.size / 1MB)
  Write-Host "  Downloading $($release.tag_name) ($sizeMb MB)..." -ForegroundColor DarkGray
  $installer = Join-Path ([IO.Path]::GetTempPath()) $asset.name
  Invoke-WebRequest $asset.browser_download_url -OutFile $installer

  Write-Host '  Installing...' -ForegroundColor DarkGray
  $proc = Start-Process -FilePath $installer -PassThru -Wait
  if ($proc.ExitCode -ne 0) { throw "The installer exited with code $($proc.ExitCode)." }

  Write-Host ''
  Write-Host '  Done. KovaPresets is in your Start menu.' -ForegroundColor Green
  Write-Host '  It updates itself from here on, no need to run this again.' -ForegroundColor DarkGray
  Write-Host ''
} catch {
  Write-Host ''
  Write-Host "  Install failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "  You can download it manually from https://github.com/$repo/releases/latest" -ForegroundColor DarkGray
  Write-Host ''
} finally {
  if ($installer -and (Test-Path $installer)) {
    Remove-Item $installer -Force -ErrorAction SilentlyContinue
  }
  $ProgressPreference = $prevProgress
}

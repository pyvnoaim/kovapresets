# KovaPresets installer.
#
#   irm https://raw.githubusercontent.com/pyvnoaim/kovapresets/main/install.ps1 | iex
#
# Downloads the newest release from GitHub and runs it. No admin rights needed -
# KovaPresets installs for the current user only.

$ErrorActionPreference = 'Stop'
# $IsWindows only exists on pwsh 6+; Windows PowerShell 5.1 is Windows-only anyway.
if ($env:OS -ne 'Windows_NT') {
  Write-Host 'KovaPresets is Windows-only. This looks like macOS/Linux - the installer would download a .exe it cannot run.' -ForegroundColor Red
  return
}
$prevProgress = $ProgressPreference
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = 'pyvnoaim/kovapresets'
$installer = $null

# Built from char codes so this file stays pure ASCII - PowerShell 5.1 reads
# BOM-less scripts as ANSI and would garble literal unicode.
$chk  = [string][char]0x2713            # check mark
$arw  = [string][char]0x2192            # right arrow
$rule = [string][char]0x2500 * 54       # horizontal line

function Write-Step([string]$text) {
  Write-Host -NoNewline "  $arw $text" -ForegroundColor DarkGray
}

function Write-Done([string]$text) {
  Write-Host -NoNewline "`r  $chk " -ForegroundColor Green
  Write-Host $text.PadRight(78) -ForegroundColor Gray
}

function Get-FileWithProgress([string]$url, [string]$path) {
  $req = [Net.HttpWebRequest]::Create($url)
  $req.UserAgent = 'kovapresets-install'
  $resp = $req.GetResponse()
  $total = $resp.ContentLength
  $in  = $resp.GetResponseStream()
  $out = [IO.File]::Create($path)
  $buf = New-Object byte[] 262144
  $done = 0L
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $lastDraw = -1000
  try {
    while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
      $out.Write($buf, 0, $n)
      $done += $n
      # Redraw at most 10x/second, plus once at the very end.
      if (($sw.ElapsedMilliseconds - $lastDraw) -ge 100 -or $done -eq $total) {
        $lastDraw = $sw.ElapsedMilliseconds
        $pct = if ($total -gt 0) { $done / $total } else { 0 }
        $filled = [math]::Max(0, [math]::Min(28, [int]($pct * 28)))
        $bar = ([string][char]0x2588 * $filled).PadRight(28, [char]0x2591)
        $speed = $done / 1MB / [math]::Max($sw.Elapsed.TotalSeconds, 0.001)
        $eta = if ($speed -gt 0 -and $total -gt $done) {
          [TimeSpan]::FromSeconds((($total - $done) / 1MB) / $speed).ToString('m\:ss')
        } else { '0:00' }
        Write-Host -NoNewline ("`r  $arw [$bar] {0,3}%  {1,5:N0} / {2:N0} MB  {3,5:N1} MB/s  ETA {4} " -f
          [int]($pct * 100), ($done / 1MB), ($total / 1MB), $speed, $eta) -ForegroundColor DarkCyan
      }
    }
  } finally {
    $out.Dispose(); $in.Dispose(); $resp.Dispose()
  }
}

try {
  Write-Host ''
  Write-Host '  KovaPresets' -ForegroundColor White
  Write-Host "  $rule" -ForegroundColor DarkGray
  Write-Host '  Presets for KovaaK'"'"'s - crosshairs, themes, sounds, HUD.' -ForegroundColor DarkGray
  Write-Host ''

  Write-Step 'Looking up the latest release...'
  $release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{
    'User-Agent' = 'kovapresets-install'
  }
  $asset = $release.assets | Where-Object { $_.name -like '*.exe' } | Select-Object -First 1
  if (-not $asset) { throw "The latest release ($($release.tag_name)) has no installer attached." }
  Write-Done "Latest release: $($release.tag_name)"

  if ($release.body) {
    # ponytail: raw markdown lines, capped at 8 - a full renderer is overkill here.
    $notes = ($release.body -split "`n" | ForEach-Object { $_.TrimEnd() } | Where-Object { $_ }) | Select-Object -First 8
    foreach ($line in $notes) { Write-Host "      $line" -ForegroundColor DarkGray }
    Write-Host ''
  }

  # GetFileName strips any path segments a hostile asset name could smuggle in.
  $installer = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetFileName($asset.name))
  Get-FileWithProgress $asset.browser_download_url $installer
  Write-Done ("Downloaded {0} ({1:N0} MB)" -f $asset.name, ($asset.size / 1MB))

  $proc = Start-Process -FilePath $installer -PassThru
  # Without -Wait, ExitCode reads $null unless the handle is cached first.
  $null = $proc.Handle
  $spin = '|/-\'
  $i = 0
  while (-not $proc.HasExited) {
    Write-Host -NoNewline "`r  $($spin[$i++ % 4]) Installing... (finish the setup window)" -ForegroundColor DarkGray
    Start-Sleep -Milliseconds 120
  }
  $proc.WaitForExit()
  if ($proc.ExitCode -ne 0) { throw "The installer exited with code $($proc.ExitCode)." }
  Write-Done 'Installed'

  Write-Host ''
  Write-Host "  $chk Done. KovaPresets is in your Start menu." -ForegroundColor Green
  Write-Host '    It updates itself from here on, no need to run this again.' -ForegroundColor DarkGray
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

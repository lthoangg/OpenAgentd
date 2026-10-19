# install.ps1 — one-command Windows installer for OpenAgentd.
#
# Usage (PowerShell):
#   irm https://raw.githubusercontent.com/lthoangg/openagentd/main/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/lthoangg/openagentd/main/install.ps1))) -Cli
#   .\install.ps1 -Version 3.0.0
#
# Default: downloads the official x64 MSI from GitHub Releases, verifies that
# it is an MSI compound document, then asks Windows Installer to install it
# elevated.
# -Cli: installs the `agentd` command-line binary (plus `openagentd`, its
# former name, kept as an alias) into
# %LOCALAPPDATA%\OpenAgentd\bin (verified against its .sha256), adds that
# folder to the user PATH, and removes an OpenAgentd v2 (Python) install
# made with uv or pipx.
#
# OPENAGENTD_RELEASES_URL overrides the releases base URL (tests).

[CmdletBinding()]
param(
    [string]$Version,
    [switch]$Cli,
    [string]$InstallDir
)

$ErrorActionPreference = "Stop"

$repo = "lthoangg/openagentd"
# The CLI binary; Install-Cli falls back to `openagentd` for releases from
# before the rename.
$script:BinName = "agentd"
$releasesUrl = if ($env:OPENAGENTD_RELEASES_URL) { $env:OPENAGENTD_RELEASES_URL.TrimEnd("/") } else { "https://github.com/$repo/releases" }

function Fail([string]$Message) {
    throw "OpenAgentd installer: $Message"
}

function Resolve-Version {
    if ($Version) {
        if ($Version -notmatch "^[A-Za-z0-9._-]+$") {
            Fail "invalid version: $Version"
        }
        return $Version.TrimStart("v")
    }

    Write-Host "==> Finding the latest OpenAgentd release"
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "$releasesUrl/latest"
        # Windows PowerShell 5.1 exposes the final URL as ResponseUri,
        # PowerShell 7 as RequestMessage.RequestUri.
        $final = $response.BaseResponse.ResponseUri
        if (-not $final) { $final = $response.BaseResponse.RequestMessage.RequestUri }
        $tag = ([uri]$final).Segments[-1].Trim("/")
    }
    catch {
        Fail "could not resolve the latest GitHub release: $($_.Exception.Message)"
    }

    if ($tag -notmatch "^v([A-Za-z0-9._-]+)$") {
        Fail "GitHub returned an unexpected release tag: $tag"
    }
    return $Matches[1]
}

function Test-MsiFile([string]$Path) {
    $signature = [byte[]](0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1)
    $stream = [IO.File]::OpenRead($Path)
    try {
        $header = New-Object byte[] $signature.Length
        if ($stream.Read($header, 0, $header.Length) -ne $signature.Length) {
            Fail "downloaded file is not a valid Windows Installer package"
        }
        for ($index = 0; $index -lt $signature.Length; $index++) {
            if ($header[$index] -ne $signature[$index]) {
                Fail "downloaded file is not a valid Windows Installer package"
            }
        }
    }
    finally {
        $stream.Dispose()
    }
}

# OpenAgentd v2 was a Python package; its uv/pipx shim would shadow or
# collide with the v3 binary.
function Remove-V2 {
    if (Get-Command uv -ErrorAction SilentlyContinue) {
        $tools = (& uv tool list 2>$null) -join "`n"
        if ($tools -match "(?m)^openagentd ") {
            Write-Host "==> Removing OpenAgentd v2 (installed with uv)"
            & uv tool uninstall openagentd
            if ($LASTEXITCODE -ne 0) { Fail "could not remove the v2 uv tool; run: uv tool uninstall openagentd" }
        }
    }
    if (Get-Command pipx -ErrorAction SilentlyContinue) {
        $pkgs = (& pipx list --short 2>$null) -join "`n"
        if ($pkgs -match "(?m)^openagentd ") {
            Write-Host "==> Removing OpenAgentd v2 (installed with pipx)"
            & pipx uninstall openagentd
            if ($LASTEXITCODE -ne 0) { Fail "could not remove the v2 pipx package; run: pipx uninstall openagentd" }
        }
    }
}

function Install-Cli([string]$ResolvedVersion) {
    if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64" -and $env:PROCESSOR_ARCHITEW6432 -ne "AMD64") {
        Fail "the Windows CLI is built for x64 only (found $env:PROCESSOR_ARCHITECTURE)"
    }
    $target = "x86_64-pc-windows-msvc"
    $dir = if ($InstallDir) { $InstallDir } elseif ($env:OPENAGENTD_INSTALL_DIR) { $env:OPENAGENTD_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "OpenAgentd\bin" }
    $asset = "openagentd-$ResolvedVersion-$target.zip"
    $url = "$releasesUrl/download/v$ResolvedVersion/$asset"
    $work = Join-Path ([IO.Path]::GetTempPath()) ("openagentd-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $work | Out-Null
    try {
        $archive = Join-Path $work $asset
        Write-Host "==> Downloading agentd $ResolvedVersion ($target)"
        Write-Host "    Source: $url"
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive
        Invoke-WebRequest -UseBasicParsing -Uri "$url.sha256" -OutFile "$archive.sha256"
        $expected = ((Get-Content -LiteralPath "$archive.sha256" -Raw).Trim() -split "\s+")[0].ToLower()
        $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLower()
        if (-not $expected -or $expected -ne $actual) {
            Fail "checksum mismatch for $asset (expected $expected, got $actual)"
        }

        $stage = Join-Path $work "stage"
        Expand-Archive -LiteralPath $archive -DestinationPath $stage
        $exe = Join-Path $stage "agentd.exe"
        if (-not (Test-Path -LiteralPath $exe)) {
            $script:BinName = "openagentd"
            $exe = Join-Path $stage "openagentd.exe"
        }
        if (-not (Test-Path -LiteralPath $exe)) { Fail "the archive does not contain agentd.exe" }
        & $exe --version | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail "the downloaded binary does not run on this machine" }

        Remove-V2

        Write-Host "==> Installing into $dir"
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        foreach ($file in Get-ChildItem -LiteralPath $stage -Filter "*.exe" -File) {
            $dest = Join-Path $dir $file.Name
            # A running agentd.exe cannot be overwritten but can be
            # renamed; the old copy is deleted on the next upgrade.
            if (Test-Path -LiteralPath $dest) {
                $old = "$dest.old"
                Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
                Move-Item -LiteralPath $dest -Destination $old -Force
            }
            Copy-Item -LiteralPath $file.FullName -Destination $dest
            Unblock-File -LiteralPath $dest
        }
        Write-Host "    $(& (Join-Path $dir "$($script:BinName).exe") --version)"
    }
    finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }

    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = @($userPath -split ";" | Where-Object { $_ })
    if ($entries -notcontains $dir) {
        $entries = @($dir) + $entries
        [Environment]::SetEnvironmentVariable("Path", $entries -join ";", "User")
        Write-Host "==> Added $dir to your user PATH (open a new terminal to use it)"
    }
    $env:Path = "$dir;$env:Path"
    # New terminals search the machine PATH before the user PATH, so a v2
    # install on the machine PATH (e.g. an all-users Python's Scripts) wins.
    $machine = @([Environment]::GetEnvironmentVariable("Path", "Machine") -split ";" | Where-Object { $_ })
    # The new name, then the old one (the alias here, or a v2 pip install).
    $commands = @(@("$($script:BinName).exe"), @("openagentd.exe", "openagentd.cmd", "openagentd.bat"))
    foreach ($names in $commands) {
        $found = $null
        foreach ($entry in ($machine + $entries)) {
            foreach ($name in $names) {
                $candidate = Join-Path ([Environment]::ExpandEnvironmentVariables($entry)) $name
                if (Test-Path -LiteralPath $candidate -ErrorAction SilentlyContinue) { $found = $candidate; break }
            }
            if ($found) { break }
        }
        if ($found -and ($found -ne (Join-Path $dir $names[0]))) {
            Write-Host "Warning: $found comes first on your PATH."
            if ($names[0] -eq "openagentd.exe") {
                Write-Host "    If it is OpenAgentd v2 installed with pip, remove it with: python -m pip uninstall openagentd"
            }
            break
        }
    }
}

$resolvedVersion = Resolve-Version

if ($Cli) {
    Install-Cli $resolvedVersion
    Write-Host ""
    Write-Host "==> Installed $($script:BinName) $resolvedVersion!"
    Write-Host "Next: run '$($script:BinName) --help', or '$($script:BinName) server start --wait'."
    Write-Host "      It uses the same config and data as OpenAgentd v2 and the desktop app."
    return
}

$asset = "OpenAgentd_${resolvedVersion}_x64_en-US.msi"
$url = "$releasesUrl/download/v$resolvedVersion/$asset"
$installerPath = Join-Path ([IO.Path]::GetTempPath()) $asset

try {
    Write-Host "==> Downloading OpenAgentd $resolvedVersion for Windows"
    Write-Host "    Source: $url"
    Invoke-WebRequest -Uri $url -OutFile $installerPath
    Test-MsiFile $installerPath
    Unblock-File -LiteralPath $installerPath

    Write-Host "==> Opening Windows Installer"
    $process = Start-Process -FilePath "msiexec.exe" `
        -ArgumentList @("/i", "`"$installerPath`"") `
        -Verb RunAs -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        Fail "Windows Installer exited with code $($process.ExitCode)"
    }
}
finally {
    if (Test-Path -LiteralPath $installerPath) {
        Remove-Item -LiteralPath $installerPath -Force
    }
}

Write-Host ""
Write-Host "==> Installed OpenAgentd $resolvedVersion!"
Write-Host "Next: open OpenAgentd from the Start menu."

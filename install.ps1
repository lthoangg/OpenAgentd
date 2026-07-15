# install.ps1 — one-command Windows desktop app installer for OpenAgentd.
#
# Usage (PowerShell):
#   irm https://raw.githubusercontent.com/lthoangg/openagentd/main/install.ps1 | iex
#   .\install.ps1
#   .\install.ps1 -Version 1.106.0
#
# Downloads the official x64 MSI from GitHub Releases, verifies that it is an
# MSI compound document, then asks Windows Installer to install it elevated.

[CmdletBinding()]
param(
    [string]$Version
)

$ErrorActionPreference = "Stop"

$repo = "lthoangg/openagentd"

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

    Write-Host "==> Finding the latest OpenAgentd desktop release"
    try {
        $response = Invoke-WebRequest -Uri "https://github.com/$repo/releases/latest"
        $tag = ([uri]$response.BaseResponse.ResponseUri).Segments[-1].Trim("/")
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

$resolvedVersion = Resolve-Version
$asset = "OpenAgentd_${resolvedVersion}_x64_en-US.msi"
$url = "https://github.com/$repo/releases/download/v$resolvedVersion/$asset"
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

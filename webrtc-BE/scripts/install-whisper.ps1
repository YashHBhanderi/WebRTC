# Installs whisper.cpp (native, no Python) and the most accurate model this PC can run - Windows
# counterpart of install-whisper.sh. Uses the official prebuilt release (no Visual Studio / CMake).
#
# Usage (PowerShell, from webrtc-BE):
#   powershell -ExecutionPolicy Bypass -File scripts\install-whisper.ps1 [-Model large-v3] [-InstallDir C:\whisper.cpp]
#   -Model: optional, e.g. large-v3, large-v3-q5_0, large-v3-turbo, medium - default chosen from RAM.
# Updates WHISPER_CPP_BIN / WHISPER_MODEL_DIR in webrtc-BE\.env when that file exists.
param(
    [string]$Model = "",
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "whisper.cpp")
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is very slow with the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Download([string]$Url, [string]$OutFile) {
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        & $curl.Source -L --fail --retry 3 -o $OutFile $Url
        if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
    } else {
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
    }
}

$binDir = Join-Path $InstallDir "bin"
$modelDir = Join-Path $InstallDir "models"
New-Item -ItemType Directory -Force -Path $binDir, $modelDir | Out-Null

# ---- whisper-cli.exe from the latest GitHub release
$cli = Get-ChildItem -Path $binDir -Recurse -Filter "whisper-cli.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $cli) {
    Write-Host "Finding the latest whisper.cpp release with Windows binaries..."
    # Not every release has binaries attached, so take the newest one that does (stable first)
    $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=30" -Headers @{ "User-Agent" = "install-whisper" }
    $withAsset = @($releases | Where-Object { $_.assets | Where-Object { $_.name -eq "whisper-bin-x64.zip" } })
    $release = ($withAsset | Where-Object { -not $_.prerelease } | Select-Object -First 1)
    if (-not $release) { $release = $withAsset | Select-Object -First 1 }
    if (-not $release) { throw "No recent whisper.cpp release has whisper-bin-x64.zip" }
    $asset = $release.assets | Where-Object { $_.name -eq "whisper-bin-x64.zip" } | Select-Object -First 1
    $zip = Join-Path $env:TEMP "whisper-bin-x64.zip"
    Write-Host "Downloading $($asset.name) ($($release.tag_name))..."
    Download $asset.browser_download_url $zip
    Expand-Archive -Path $zip -DestinationPath $binDir -Force
    Remove-Item $zip -Force
    $cli = Get-ChildItem -Path $binDir -Recurse -Filter "whisper-cli.exe" | Select-Object -First 1
    if (-not $cli) { throw "whisper-cli.exe not found in the release archive" }
}

# ---- model: the app lets whisper use 60% of RAM (WHISPER_MAX_MEMORY_MB); the rest stays for calls
if (-not $Model) {
    $ramMb = [int]((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB)
    $budget = [int]($ramMb * 0.6)
    if     ($budget -ge 4700) { $Model = "large-v3" }
    elseif ($budget -ge 1900) { $Model = "large-v3-q5_0" }
    elseif ($budget -ge 1100) { $Model = "large-v3-turbo-q5_0" }
    else                      { $Model = "base" }
    Write-Host "RAM $ramMb MB, whisper budget $budget MB -> $Model"
}
$modelFile = Join-Path $modelDir "ggml-$Model.bin"
if (-not (Test-Path $modelFile)) {
    Write-Host "Downloading model ggml-$Model.bin (this can take a while)..."
    $part = "$modelFile.part"
    Download "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$Model.bin" $part
    Move-Item -Force $part $modelFile
}

# ---- point the app at it
$envFile = Join-Path (Split-Path $PSScriptRoot -Parent) ".env"
if (Test-Path $envFile) {
    $settings = [ordered]@{ "WHISPER_CPP_BIN" = $cli.FullName; "WHISPER_MODEL_DIR" = $modelDir; "TRANSCRIPTION_PROVIDER" = "whisper-cpp" }
    $lines = [System.Collections.Generic.List[string]](Get-Content $envFile)
    foreach ($key in $settings.Keys) {
        $index = -1
        for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match "^\s*$key=") { $index = $i } }
        if ($index -ge 0) { $lines[$index] = "$key=$($settings[$key])" } else { $lines.Add("$key=$($settings[$key])") }
    }
    Set-Content -Path $envFile -Value $lines
    Write-Host "Updated WHISPER_CPP_BIN / WHISPER_MODEL_DIR in $envFile"
}

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Warning "FFmpeg is not on PATH - install it (winget install Gyan.FFmpeg) or set FFMPEG_PATH in .env"
}

Write-Host ""
Write-Host "whisper.cpp: $($cli.FullName)"
Write-Host "model:       $modelFile"
Write-Host "CPU cores:   $([Environment]::ProcessorCount) (the app uses half by default; WHISPER_THREADS overrides)"
Write-Host "Restart the backend to pick it up."

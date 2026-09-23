# Join a remote PC/phone to the open-source Headscale mesh (no router admin).
# Run on EVERY device that participates in cross-network audio/video calls.

$ErrorActionPreference = "Stop"
$vpnRoot = $PSScriptRoot

$loginServer = (Get-Content (Join-Path $vpnRoot "login-server.txt") -ErrorAction SilentlyContinue)
$authKey = (Get-Content (Join-Path $vpnRoot "authkey.txt") -ErrorAction SilentlyContinue)

if (-not $loginServer -or -not $authKey) {
  Write-Host "Missing login-server.txt or authkey.txt in vpn/. Copy them from the server PC." -ForegroundColor Red
  exit 1
}

$ts = "C:\Program Files\Tailscale\tailscale.exe"
if (-not (Test-Path $ts)) {
  Write-Host "Installing Tailscale client..." -ForegroundColor Yellow
  winget install --id Tailscale.Tailscale -e --accept-package-agreements --accept-source-agreements
}

Write-Host "Joining Headscale at $loginServer ..." -ForegroundColor Cyan
& $ts logout 2>$null
& $ts up --login-server=$loginServer --authkey=$authKey --accept-dns=false
Start-Sleep -Seconds 2
& $ts status
Write-Host ""
Write-Host "Done. Open the chat app over HTTPS (ngrok) and join a group call." -ForegroundColor Green

# Fully open-source cross-network A/V via Headscale (OSS Tailscale control server)
# https://github.com/juanfont/headscale

param(
  [switch]$SkipDockerPull
)

$ErrorActionPreference = "Stop"
$vpnRoot = $PSScriptRoot
Set-Location $vpnRoot

Write-Host ""
Write-Host "=== Open-source VPN mesh for group calls (Headscale) ===" -ForegroundColor Cyan
Write-Host ""

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host "Docker is required. Install Docker Desktop, then re-run this script." -ForegroundColor Red
  exit 1
}

Write-Host "1) Starting Headscale..." -ForegroundColor Yellow
docker compose up -d

Start-Sleep -Seconds 3

Write-Host "2) Creating user 'chat' (ignore error if exists)..." -ForegroundColor Yellow
docker exec chat-headscale headscale users create chat 2>$null

Write-Host "3) Creating reusable auth key..." -ForegroundColor Yellow
$keyOut = docker exec chat-headscale headscale preauthkeys create --user chat --reusable --expiration 2160h
$authKey = ($keyOut | Select-Object -Last 1).ToString().Trim()

if (-not $authKey) {
  Write-Host "Failed to create auth key. Check: docker logs chat-headscale" -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "Auth key:" -ForegroundColor Green
Write-Host $authKey -ForegroundColor Green
Write-Host ""

# Save key for later
$authKey | Set-Content -Path (Join-Path $vpnRoot "authkey.txt") -NoNewline

Write-Host "4) Next steps (do these on EVERY device that joins calls):" -ForegroundColor Yellow
Write-Host ""
Write-Host "  A. Install Tailscale client (open-source app):"
Write-Host "     Windows: winget install Tailscale.Tailscale"
Write-Host "     Or https://tailscale.com/download (client is OSS; we use Headscale server)"
Write-Host ""
Write-Host "  B. On THIS server PC, connect to Headscale:"
Write-Host "     tailscale logout"
Write-Host "     tailscale up --login-server=http://127.0.0.1:8080 --authkey=$authKey --accept-dns=false"
Write-Host ""
Write-Host "  C. Expose Headscale for remotes (keep app ngrok on :4200; use Cloudflare for :8080):"
Write-Host "     & `"C:\Program Files (x86)\cloudflared\cloudflared.exe`" tunnel --url http://127.0.0.1:8080"
Write-Host "     Save the https://....trycloudflare.com URL into vpn/login-server.txt"
Write-Host "     Set server_url in vpn/config/config.yaml to that URL, then: docker compose restart"
Write-Host ""
Write-Host "  D. On OTHER network devices (or run vpn/join-remote.ps1 with copied authkey + login-server):"
Write-Host "     tailscale up --login-server=https://YOUR-CLOUDFLARE-URL --authkey=$authKey --accept-dns=false"
Write-Host ""
Write-Host "  E. Restart webrtc backend. It will announce mediasoup on the 100.x mesh IP."
Write-Host ""
Write-Host "Auth key also saved to vpn/authkey.txt" -ForegroundColor Cyan
Write-Host ""

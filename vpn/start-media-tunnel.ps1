# Start OSS TCP tunnel for mediasoup (bore.pub) and write MEDIA_TUNNEL_* into webrtc-BE/.env
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$bore = Join-Path $PSScriptRoot "bin\bore.exe"
$envFile = Join-Path $root "webrtc-BE\.env"
$rtcPort = 40000
$logOut = Join-Path $PSScriptRoot "bore-tunnel.out.log"
$logErr = Join-Path $PSScriptRoot "bore-tunnel.err.log"

# Stop previous bore tunnels started by this script
Get-Process bore -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
Remove-Item $logOut, $logErr -Force -ErrorAction SilentlyContinue

Write-Host "Starting bore tunnel for localhost:$rtcPort ..." -ForegroundColor Cyan

$proc = Start-Process -FilePath $bore `
  -ArgumentList @("local", "$rtcPort", "--to", "bore.pub") `
  -RedirectStandardOutput $logOut `
  -RedirectStandardError $logErr `
  -PassThru `
  -WindowStyle Hidden

$deadline = (Get-Date).AddSeconds(25)
$remotePort = $null
while ((Get-Date) -lt $deadline -and -not $remotePort) {
  Start-Sleep -Milliseconds 500
  $text = ""
  if (Test-Path $logErr) {
    $text += (Get-Content $logErr -Raw -ErrorAction SilentlyContinue)
  }
  if (Test-Path $logOut) {
    $text += "`n" + (Get-Content $logOut -Raw -ErrorAction SilentlyContinue)
  }
  if ($text -match 'listening at bore\.pub:(\d+)') {
    $remotePort = [int]$Matches[1]
  } elseif ($text -match 'remote_port=(\d+)') {
    $remotePort = [int]$Matches[1]
  }
  if ($text) {
    ($text -split "`n") | Where-Object { $_.Trim() } | Select-Object -Last 3 | ForEach-Object {
      Write-Host $_.Trim()
    }
  }
  if ($proc.HasExited) { break }
}

if (-not $remotePort) {
  Write-Host "Could not detect bore remote port. Is mediasoup listening on $rtcPort?" -ForegroundColor Red
  if (Test-Path $logErr) { Get-Content $logErr }
  if (Test-Path $logOut) { Get-Content $logOut }
  exit 1
}

$hostIp = "159.223.110.159"
try {
  $resolved = (Resolve-DnsName bore.pub -Type A -ErrorAction Stop | Select-Object -First 1).IPAddress
  if ($resolved) { $hostIp = $resolved }
} catch { }

if (-not (Test-Path $envFile)) {
  Write-Host "Missing $envFile" -ForegroundColor Red
  exit 1
}

$content = Get-Content $envFile -Raw
if ($content -match 'MEDIA_TUNNEL_HOST=') {
  $content = $content -replace 'MEDIA_TUNNEL_HOST=.*', "MEDIA_TUNNEL_HOST=$hostIp"
} else {
  $content += "`r`nMEDIA_TUNNEL_HOST=$hostIp`r`n"
}
if ($content -match 'MEDIA_TUNNEL_PORT=') {
  $content = $content -replace 'MEDIA_TUNNEL_PORT=.*', "MEDIA_TUNNEL_PORT=$remotePort"
} else {
  $content += "MEDIA_TUNNEL_PORT=$remotePort`r`n"
}
if ($content -match 'MEDIA_ALLOW_TCP_TUNNEL=') {
  $content = $content -replace 'MEDIA_ALLOW_TCP_TUNNEL=.*', 'MEDIA_ALLOW_TCP_TUNNEL=true'
} else {
  $content += "MEDIA_ALLOW_TCP_TUNNEL=true`r`n"
}
if ($content -match 'MEDIA_PREFER_UDP=') {
  $content = $content -replace 'MEDIA_PREFER_UDP=.*', 'MEDIA_PREFER_UDP=true'
} else {
  $content += "MEDIA_PREFER_UDP=true`r`n"
}
Set-Content $envFile -Value $content -NoNewline

Write-Host ""
Write-Host "Tunnel ready: ${hostIp}:$remotePort -> 127.0.0.1:$rtcPort" -ForegroundColor Green
Write-Host "Updated $envFile" -ForegroundColor Yellow
Write-Host "IMPORTANT: Restart webrtc-BE now (Ctrl+C, then npm run dev)." -ForegroundColor Yellow
Write-Host "Keep this window open. PID=$($proc.Id)" -ForegroundColor Cyan
Wait-Process -Id $proc.Id

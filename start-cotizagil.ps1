# CotizAgil - Start API + Tunnel
Write-Host "Starting CotizAgil API..." -ForegroundColor Cyan

Set-Location "c:\Users\fabri\OneDrive\Documentos\APPS-AI\Agente cotizador final"

Get-Process -Name "node"  -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process -Name "ngrok" -ErrorAction SilentlyContinue | Stop-Process -Force

# Also make sure the SQL Server container is running
$container = podman ps --filter "name=sqlserver-cotizagil" --format "{{.Status}}" 2>$null
if (-not $container) {
    Write-Host "Starting SQL Server container..." -ForegroundColor Yellow
    podman start sqlserver-cotizagil 2>$null
    Start-Sleep -Seconds 8
}

Start-Sleep -Seconds 1

Start-Process -FilePath "node" -ArgumentList "src/index.js" -NoNewWindow -PassThru | Out-Null
Start-Sleep -Seconds 3

Start-Process -FilePath "ngrok" -ArgumentList "http", "3000", "--url=regime-level-character.ngrok-free.dev", "--config=C:\Users\fabri\AppData\Local\ngrok\ngrok-cotizagil.yml" -NoNewWindow -PassThru | Out-Null
Start-Sleep -Seconds 4

$health = Invoke-RestMethod -Uri "http://localhost:3000/health" -ErrorAction SilentlyContinue
$tunnel = (Invoke-RestMethod -Uri "http://localhost:4040/api/tunnels" -ErrorAction SilentlyContinue).tunnels[0].public_url

Write-Host ""
Write-Host "================================================" -ForegroundColor White
Write-Host "  API status : $($health.status)"                  -ForegroundColor Green
Write-Host "  Public URL : $tunnel"                            -ForegroundColor Green
Write-Host "  API Key    : cotizagil-api-key-2024"             -ForegroundColor Yellow
Write-Host "  Inspector  : http://localhost:4040"              -ForegroundColor Gray
Write-Host "================================================" -ForegroundColor White

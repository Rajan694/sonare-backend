# PowerShell version of runBE.sh.

Push-Location $PSScriptRoot
$ProgressPreference = 'SilentlyContinue'
try {

function Show-Usage {
    Write-Host "Usage: .\runBE.ps1 [dev|start]"
    Write-Host ""
    Write-Host "  dev     Run with tsx watch and reload on change (default)"
    Write-Host "  start   Run the compiled build from dist/"
    Write-Host ""
    Write-Host "Environment:"
    Write-Host "  PORT    Override the listen port (default from .env, 3010)"
    exit 1
}

$Mode = if ($args.Count -gt 0) { "$($args[0])" } else { 'dev' }
if ($Mode -notin 'dev', 'start') { Show-Usage }

if (-not (Test-Path node_modules)) {
    Write-Host "node_modules missing - run .\installBE.ps1 first."
    exit 1
}

if (-not (Test-Path .env)) {
    Write-Host ".env missing - run .\installBE.ps1 first."
    exit 1
}

if (Get-Command docker -ErrorAction SilentlyContinue) {
    docker compose -f docker-compose.dev.yml up -d mailpit
    Write-Host "Mailpit inbox: http://localhost:8025"
} else {
    Write-Host "Warning: docker not found - Mailpit will not start. SMTP will fail."
}

# The Piped upstream is private (contract D2) but the catalog is useless without
# it, so say plainly whether it is up rather than failing later per-request.
$pipedUrl = (Get-Content .env | Where-Object { $_ -cmatch '^PIPED_API_URL=' } | Select-Object -First 1) -replace '^PIPED_API_URL=', ''
if (-not $pipedUrl) { $pipedUrl = 'http://localhost:8090' }
try {
    $null = Invoke-WebRequest -Uri "$pipedUrl/healthcheck" -UseBasicParsing -TimeoutSec 3
    Write-Host "Piped upstream: up ($pipedUrl)"
} catch {
    Write-Host "Piped upstream: DOWN ($pipedUrl) - catalog and streaming will fail."
    Write-Host "  Start it with ..\sonare-piped-backend\runPiped.ps1"
}

if ($Mode -eq 'start') {
    if (-not (Test-Path dist)) {
        Write-Host "dist/ missing - building first."
        npm run build
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    npm run start
    exit $LASTEXITCODE
}

npm run dev
exit $LASTEXITCODE

} catch {
    # A missing command throws here instead of setting $LASTEXITCODE.
    Write-Host ($_ | Out-String)
    exit 1
} finally { Pop-Location }

# PowerShell version of installBE.sh.

Push-Location $PSScriptRoot
try {

function Invoke-Npm {
    $global:LASTEXITCODE = 0
    npm @args
    # $? also catches npm not being installed, which leaves $LASTEXITCODE alone.
    if (-not $? -or $LASTEXITCODE -ne 0) { exit $(if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }) }
}

function Test-Port([int]$Port) {
    $client = New-Object Net.Sockets.TcpClient
    try { $client.ConnectAsync('127.0.0.1', $Port).Wait(1000) -and $client.Connected } catch { $false } finally { $client.Dispose() }
}

Write-Host "=== Installing backend packages ==="
Invoke-Npm install

if (-not (Test-Path .env)) {
    Write-Host ""
    Write-Host "=== Creating .env from .env.example ==="
    Copy-Item .env.example .env
    Write-Host "Wrote .env - set DATABASE_URL and JWT_SECRET before running."
}

# Postgres and Redis are local, not dockerised. Fail early with something
# actionable rather than letting the server die on its first query.
$dbUrl = (Get-Content .env | Where-Object { $_ -cmatch '^DATABASE_URL=' } | Select-Object -First 1) -replace '^DATABASE_URL=', ''
$dbName = $dbUrl -replace '.*/([^/?]+).*', '$1'

Write-Host ""
Write-Host "=== Checking local services ==="
if (Test-Port 5432) {
    Write-Host "  postgres  : up on 5432"
} else {
    Write-Host "  postgres  : NOT reachable on 127.0.0.1:5432 - start it before running."
}
if (Test-Port 6379) {
    Write-Host "  redis     : up on 6379"
} else {
    Write-Host "  redis     : NOT reachable on 127.0.0.1:6379 - the API still runs, cache degrades to passthrough."
}

Write-Host ""
Write-Host "=== Database setup ($dbName) ==="
Invoke-Npm run db:create
Invoke-Npm run db:generate
Invoke-Npm run db:migrate

Write-Host ""
Write-Host "=== Building ==="
Invoke-Npm run build

Write-Host ""
Write-Host "Backend ready. Start it with .\runBE.ps1"
exit 0

} catch {
    # A missing command throws here instead of setting $LASTEXITCODE.
    Write-Host ($_ | Out-String)
    exit 1
} finally { Pop-Location }

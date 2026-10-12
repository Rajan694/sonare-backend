# PowerShell version of updateBE.sh: pull, install what changed, build, migrate, run.

Push-Location $PSScriptRoot
$ProgressPreference = 'SilentlyContinue'
try {

function Show-Usage {
    Write-Host "Usage: .\updateBE.ps1 [dev|prod] [--no-run]"
    Write-Host ""
    Write-Host "  dev       Pull, install, migrate, then .\runBE.ps1 dev (tsx watch) - the default"
    Write-Host "  prod      Pull, install, build, migrate, then .\runBE.ps1 start (the compiled build)"
    Write-Host "  --no-run  Stop after updating (..\update.ps1 starts things itself)"
    Write-Host ""
    Write-Host "Refuses to pull over uncommitted changes. npm packages are reinstalled only when"
    Write-Host "package.json or package-lock.json changed (or node_modules is missing)."
    exit 1
}

$Mode = 'dev'
$Run = $true
foreach ($a in $args) {
    switch ("$a") {
        { $_ -in 'dev', 'prod' } { $Mode = $_ }
        '--no-run' { $Run = $false }
        default { Show-Usage }
    }
}

function Invoke-Step([scriptblock]$Block) {
    & $Block
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if (-not (Test-Path .env)) {
    Write-Host ".env missing - run .\installBE.ps1 first."
    exit 1
}

# ---- pull ----
if (git status --porcelain --untracked-files=no) {
    Write-Host "Uncommitted changes here - commit or stash them before updating:"
    git status --short --untracked-files=no
    exit 1
}
$Branch = git rev-parse --abbrev-ref HEAD
if ($Branch -eq 'HEAD') { Write-Host 'Detached HEAD - check out a branch first.'; exit 1 }
$Before = git rev-parse HEAD
Write-Host "=== Pulling $Branch ==="
Invoke-Step { git pull --ff-only }
$After = git rev-parse HEAD
$Changed = if ($Before -ne $After) { @(git diff --name-only $Before $After) } else { @() }

# ---- install, build, migrate ----
if (-not (Test-Path node_modules) -or $Changed -contains 'package.json' -or $Changed -contains 'package-lock.json') {
    Write-Host ""
    Write-Host "=== Installing packages (npm ci) ==="
    Invoke-Step { npm ci }
}

Write-Host ""
if ($Mode -eq 'prod') {
    Write-Host "=== Building ==="
    Invoke-Step { npm run build }
    Write-Host ""
    Write-Host "=== Migrating the database ==="
    Invoke-Step { npm run db:migrate:prod }
} else {
    Write-Host "=== Migrating the database ==="
    Invoke-Step { npm run db:migrate }
}

if (-not $Run) {
    Write-Host ""
    Write-Host "Backend updated ($(git log -1 --format='%h %s'))."
    exit 0
}

Write-Host ""
if ($Mode -eq 'prod') { & .\runBE.ps1 start } else { & .\runBE.ps1 dev }
exit $LASTEXITCODE

} finally {
    Pop-Location
}

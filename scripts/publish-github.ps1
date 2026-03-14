[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$RepoUrl,

  [string]$Branch = "main",
  [string]$CommitMessage = "Initial release: Codex Claw",
  [switch]$SkipChecks
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Write-Step([string]$Message) {
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Test-HasCommit {
  git rev-parse --verify HEAD *> $null
  return $LASTEXITCODE -eq 0
}

function Test-HasStagedChanges {
  git diff --cached --quiet
  return $LASTEXITCODE -ne 0
}

if (-not $SkipChecks) {
  Write-Step "Running GitHub preflight checks"
  powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "github-check.ps1")
}

Write-Step "Ensuring git repository exists"
git rev-parse --is-inside-work-tree *> $null
if ($LASTEXITCODE -ne 0) {
  git init
}

Write-Step "Preparing branch $Branch"
if (Test-HasCommit) {
  git branch -M $Branch
} else {
  git checkout -B $Branch *> $null
}

Write-Step "Staging files"
git add .

$hasCommit = Test-HasCommit
$hasStagedChanges = Test-HasStagedChanges

if ($hasStagedChanges -or -not $hasCommit) {
  Write-Step "Creating commit"
  git commit -m $CommitMessage
} else {
  Write-Step "No new changes to commit"
}

Write-Step "Configuring remote origin"
git remote get-url origin *> $null
if ($LASTEXITCODE -eq 0) {
  git remote set-url origin $RepoUrl
} else {
  git remote add origin $RepoUrl
}

Write-Step "Pushing to GitHub"
git push -u origin $Branch

Write-Host ""
Write-Host "GitHub publish complete." -ForegroundColor Green

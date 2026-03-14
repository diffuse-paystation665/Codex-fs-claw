[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Write-Step([string]$Message) {
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Assert-GitIgnore([string]$PathValue) {
  $null = git check-ignore $PathValue 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw "Expected '$PathValue' to be ignored by git."
  }
}

function Get-ScanFiles {
  $allowedExtensions = @(".md", ".ts", ".json", ".yml", ".yaml", ".ps1", ".gitignore", ".example", ".txt")
  $excludedDirs = @(".git", "node_modules", "dist", "data", "logs", "output", ".playwright-cli")

  Get-ChildItem -Recurse -File | Where-Object {
    $fullName = $_.FullName
    foreach ($excluded in $excludedDirs) {
      if ($fullName -like "*\${excluded}\*") {
        return $false
      }
    }

    $extension = $_.Extension
    if ($_.Name -eq ".gitignore" -or $_.Name -eq ".env.example") {
      return $true
    }

    return $allowedExtensions -contains $extension
  }
}

function Find-RepositoryIssues {
  $issues = New-Object System.Collections.Generic.List[string]
  $files = Get-ScanFiles

  $secretPatterns = @(
    '(?im)^\s*FEISHU_APP_SECRET\s*=\s*(?!xxx|your|你的|example|changeme|placeholder)[^\s#]+',
    '(?im)^\s*OPENAI_API_KEY\s*=\s*(?!xxx|your|你的|example|changeme|placeholder)[^\s#]+',
    'ghp_[A-Za-z0-9]{20,}',
    'github_pat_[A-Za-z0-9_]{20,}',
    'sk-[A-Za-z0-9]{20,}'
  )

  $privacyPatterns = @(
    'C:\\Users\\[^\\]+\\',
    '@foxmail\.com',
    '@gmail\.com',
    '@163\.com'
  )

  foreach ($file in $files) {
    $content = Get-Content $file.FullName -Raw -ErrorAction SilentlyContinue
    if (-not $content) {
      continue
    }

    foreach ($pattern in $secretPatterns) {
      if ($content -match $pattern) {
        $issues.Add("Potential secret leak in $($file.FullName)")
        break
      }
    }

    foreach ($pattern in $privacyPatterns) {
      if ($content -match $pattern) {
        $issues.Add("Potential personal path/email in $($file.FullName)")
        break
      }
    }
  }

  return $issues
}

Write-Step "Checking git ignore rules"
Assert-GitIgnore ".env"
Assert-GitIgnore "data"
Assert-GitIgnore "logs"
Assert-GitIgnore "dist"
Assert-GitIgnore "node_modules"

if (-not $SkipBuild) {
  Write-Step "Running build"
  npm run build
}

if (-not $SkipTests) {
  Write-Step "Running tests"
  npm test
}

Write-Step "Scanning repository for obvious secrets and personal traces"
$issues = @(Find-RepositoryIssues)
if ($issues.Count -gt 0) {
  $issues | ForEach-Object { Write-Host $_ -ForegroundColor Yellow }
  throw "Repository scan failed. Please fix the issues above before publishing."
}

Write-Step "Checking git status"
git status --short

Write-Host ""
Write-Host "GitHub preflight passed." -ForegroundColor Green

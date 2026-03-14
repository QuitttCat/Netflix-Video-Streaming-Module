param(
  [switch]$SkipVolumeReset
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env from .env.example. Fill AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and S3_BUCKET_NAME, then re-run this script." -ForegroundColor Yellow
  exit 1
}

$required = @("AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "S3_BUCKET_NAME")
$envText = Get-Content ".env" -Raw
$missing = @()

foreach ($key in $required) {
  $match = [regex]::Match($envText, "(?m)^$key\s*=\s*(.*)$")
  if (-not $match.Success) {
    $missing += $key
    continue
  }
  $value = ($match.Groups[1].Value).Trim().Trim('"').Trim("'")
  if ([string]::IsNullOrWhiteSpace($value)) {
    $missing += $key
  }
}

if ($missing.Count -gt 0) {
  Write-Host "Missing required .env values: $($missing -join ', ')" -ForegroundColor Red
  Write-Host "These are required because seeded videos use S3 storage paths." -ForegroundColor Yellow
  exit 1
}

if (-not $SkipVolumeReset) {
  docker compose down -v
}

docker compose up -d --build

Write-Host "Application is up." -ForegroundColor Green
Write-Host "Open: http://localhost" -ForegroundColor Green
Write-Host "Tip: use -SkipVolumeReset to keep existing local DB/volumes." -ForegroundColor DarkGray

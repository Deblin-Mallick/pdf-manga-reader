param (
    [Parameter(Mandatory=$true)]
    [string]$UserId,

    [Parameter(Mandatory=$false)]
    [int]$Port = 8000,

    [Parameter(Mandatory=$false)]
    [string]$Action = "up" # up, down, restart, logs, status
)

# Load existing .env variables if .env file exists
if (Test-Path ".env") {
    Get-Content ".env" | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
            $parts = $line.Split("=", 2)
            $key = $parts[0].Trim()
            $val = $parts[1].Trim().Trim("'").Trim('"')
            if (-not [System.Environment]::GetEnvironmentVariable($key)) {
                [System.Environment]::SetEnvironmentVariable($key, $val, "Process")
            }
        }
    }
}

# Set environment variables for Compose
$env:USER_ID = $UserId
$env:PORT = $Port

$projectName = "manga-reader-$UserId"

# Detect whether to use 'docker compose' (V2) or 'docker-compose' (V1)
$useV2 = $false
try {
    $null = Get-Command "docker" -ErrorAction Stop
    $null = & docker compose version 2>$null
    if ($LASTEXITCODE -eq 0) {
        $useV2 = $true
    }
} catch {}

function Invoke-ComposeCommand {
    param ($Arguments)
    if ($useV2) {
        & docker compose -p $projectName $Arguments
    } else {
        & docker-compose -p $projectName $Arguments
    }
}

switch ($Action) {
    "up" {
        Write-Host "Starting stack for User: $UserId on Port: $Port..." -ForegroundColor Green
        if ($useV2) {
            docker compose -p $projectName up -d --build
        } else {
            docker-compose -p $projectName up -d --build
        }
    }
    "down" {
        Write-Host "Stopping stack for User: $UserId..." -ForegroundColor Yellow
        if ($useV2) {
            docker compose -p $projectName down
        } else {
            docker-compose -p $projectName down
        }
    }
    "restart" {
        Write-Host "Restarting stack for User: $UserId..." -ForegroundColor Green
        if ($useV2) {
            docker compose -p $projectName restart
        } else {
            docker-compose -p $projectName restart
        }
    }
    "logs" {
        if ($useV2) {
            docker compose -p $projectName logs -f
        } else {
            docker-compose -p $projectName logs -f
        }
    }
    "status" {
        if ($useV2) {
            docker compose -p $projectName ps
        } else {
            docker-compose -p $projectName ps
        }
    }
    Default {
        Write-Error "Invalid action: $Action. Use 'up', 'down', 'restart', 'logs', or 'status'."
    }
}

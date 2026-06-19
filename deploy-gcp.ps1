param (
    [Parameter(Mandatory=$true)]
    [string]$ProjectId,

    [Parameter(Mandatory=$false)]
    [string]$Region = "us-central1",

    [Parameter(Mandatory=$false)]
    [string]$AppName = "pdf-manga-reader"
)

$ErrorActionPreference = "Stop"

# 1. Parse local .env file if present for seeding secrets
$envVars = @{}
if (Test-Path ".env") {
    Write-Host "Parsing local .env file for configuration..." -ForegroundColor Gray
    Get-Content ".env" | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
            $parts = $line.Split("=", 2)
            $key = $parts[0].Trim()
            $val = $parts[1].Trim().Trim("'").Trim('"')
            $envVars[$key] = $val
        }
    }
}

# 2. Authenticate and configure GCP Project
Write-Host "Setting active GCP Project to: $ProjectId..." -ForegroundColor Green
gcloud config set project $ProjectId

# 3. Enable Required APIs
Write-Host "Enabling Google Cloud services (Cloud Run, Secret Manager, Cloud Build)..." -ForegroundColor Green
gcloud services enable run.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com

# 4. Provision and Seed Secrets in Secret Manager
$secrets = @("JWT_SECRET", "GOOGLE_CLIENT_ID", "DATABASE_URL")

foreach ($secretName in $secrets) {
    Write-Host "Checking secret: $secretName..." -ForegroundColor Gray
    $exists = gcloud secrets describe $secretName --project=$ProjectId 2>$null
    
    if (-not $exists) {
        Write-Host "Creating secret $secretName in Secret Manager..." -ForegroundColor Cyan
        gcloud secrets create $secretName --replication-policy="automatic" --project=$ProjectId
        
        # Determine value to seed
        $seedValue = ""
        if ($envVars.ContainsKey($secretName)) {
            $val = $envVars[$secretName]
            # Exclude default values
            if ($val -and $val -ne "generate-a-secure-random-string-here" -and $val -ne "1234567890-testclientid.apps.googleusercontent.com") {
                $seedValue = $val
            }
        }
        
        if ($seedValue) {
            Write-Host "Seeding $secretName with value from local .env..." -ForegroundColor Green
            # Write value to temp file to avoid CLI escaping issues
            $tempFile = [System.IO.Path]::GetTempFileName()
            [System.IO.File]::WriteAllText($tempFile, $seedValue)
            gcloud secrets versions add $secretName --data-file=$tempFile --project=$ProjectId
            Remove-Item $tempFile
        } else {
            Write-Host "No valid local value found for $secretName. Created empty placeholder. You must add a secret version in GCP Console!" -ForegroundColor Yellow
        }
    } else {
        Write-Host "Secret $secretName already exists in Secret Manager." -ForegroundColor Gray
    }
}

# 5. Grant Access to the Cloud Run Service Account
Write-Host "Fetching GCP Project Number..." -ForegroundColor Gray
$projectNumber = gcloud projects describe $ProjectId --format="value(projectNumber)"
if (-not $projectNumber) {
    throw "Failed to retrieve project number for project: $ProjectId"
}
$serviceAccount = "$($projectNumber.Trim())-compute@developer.gserviceaccount.com"

Write-Host "Granting Secret Accessor permissions to service account ($serviceAccount)..." -ForegroundColor Green
gcloud projects add-iam-policy-binding $ProjectId `
    --member="serviceAccount:$serviceAccount" `
    --role="roles/secretmanager.secretAccessor"

# 6. Build the Container with Cloud Build
Write-Host "Submitting build to Google Cloud Build (this compiles React and Python assets)..." -ForegroundColor Green
gcloud builds submit --tag gcr.io/$ProjectId/$AppName --project=$ProjectId

# 7. Deploy to Cloud Run linking the secrets
Write-Host "Deploying container to Google Cloud Run (Method 1: Env Injection)..." -ForegroundColor Green
gcloud run deploy $AppName `
    --image gcr.io/$ProjectId/$AppName `
    --platform managed `
    --region $Region `
    --allow-unauthenticated `
    --port 8000 `
    --set-secrets="JWT_SECRET=JWT_SECRET:latest,GOOGLE_CLIENT_ID=GOOGLE_CLIENT_ID:latest,DATABASE_URL=DATABASE_URL:latest" `
    --project=$ProjectId

Write-Host "Deployment completed successfully!" -ForegroundColor Green
Write-Host "Please ensure your DATABASE_URL secret is updated with a valid production PostgreSQL instance (e.g. Cloud SQL)." -ForegroundColor Yellow

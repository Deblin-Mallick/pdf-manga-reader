#!/bin/bash

set -e

if [ -z "$1" ]; then
  echo "Usage: ./deploy-gcp.sh <project-id> [region] [app-name]"
  exit 1
fi

PROJECT_ID=$1
REGION=${2:-us-central1}
APP_NAME=${3:-pdf-manga-reader}

# 1. Parse local .env file if present for seeding secrets
declare -A envVars
if [ -f .env ]; then
  echo "Parsing local .env file..."
  while IFS='=' read -r key val || [ -n "$key" ]; do
    # Skip comments and empty lines
    if [[ ! "$key" =~ ^# ]] && [ -n "$key" ] && [[ "$val" =~ [^\ ] ]]; then
      # Strip quotes
      clean_val=$(echo "$val" | sed -e 's/^["'\'' ]*//' -e 's/["'\'' ]*$//')
      envVars[$key]=$clean_val
    fi
  done < .env
fi

# 2. Authenticate and configure GCP Project
echo "Setting active GCP Project to: $PROJECT_ID..."
gcloud config set project "$PROJECT_ID"

# 3. Enable Required APIs
echo "Enabling Google Cloud services (Cloud Run, Secret Manager, Cloud Build)..."
gcloud services enable run.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com

# 4. Provision and Seed Secrets in Secret Manager
secrets=("JWT_SECRET" "GOOGLE_CLIENT_ID" "DATABASE_URL")

for secretName in "${secrets[@]}"; do
  echo "Checking secret: $secretName..."
  if ! gcloud secrets describe "$secretName" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo "Creating secret $secretName in Secret Manager..."
    gcloud secrets create "$secretName" --replication-policy="automatic" --project="$PROJECT_ID"
    
    # Determine value to seed
    seedValue=${envVars[$secretName]}
    if [ -n "$seedValue" ] && [ "$seedValue" != "generate-a-secure-random-string-here" ] && [ "$seedValue" != "1234567890-testclientid.apps.googleusercontent.com" ]; then
      echo "Seeding $secretName with value from local .env..."
      echo -n "$seedValue" | gcloud secrets versions add "$secretName" --data-file=- --project="$PROJECT_ID"
    else
      echo "No valid local value found for $secretName. Created empty placeholder. You must add a secret version in GCP Console!"
    fi
  else
    echo "Secret $secretName already exists in Secret Manager."
  fi
done

# 5. Grant Access to the Cloud Run Service Account
echo "Fetching GCP Project Number..."
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")
SERVICE_ACCOUNT="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

echo "Granting Secret Accessor permissions to service account ($SERVICE_ACCOUNT)..."
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SERVICE_ACCOUNT" \
  --role="roles/secretmanager.secretAccessor"

# 6. Build the Container with Cloud Build
echo "Submitting build to Google Cloud Build (this compiles React and Python assets)..."
gcloud builds submit --tag "gcr.io/${PROJECT_ID}/${APP_NAME}" --project="$PROJECT_ID"

# 7. Deploy to Cloud Run linking the secrets
echo "Deploying container to Google Cloud Run (Method 1: Env Injection)..."
gcloud run deploy "$APP_NAME" \
  --image "gcr.io/${PROJECT_ID}/${APP_NAME}" \
  --platform managed \
  --region "$REGION" \
  --allow-unauthenticated \
  --port 8000 \
  --set-secrets="JWT_SECRET=JWT_SECRET:latest,GOOGLE_CLIENT_ID=GOOGLE_CLIENT_ID:latest,DATABASE_URL=DATABASE_URL:latest" \
  --project="$PROJECT_ID"

echo "Deployment completed successfully!"
echo "Please ensure your DATABASE_URL secret is updated with a valid production PostgreSQL instance (e.g. Cloud SQL)."

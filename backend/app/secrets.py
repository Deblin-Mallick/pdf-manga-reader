import os

# Flag to prevent multiple redundant fetches
_secrets_loaded = False

def load_gcp_secrets():
    global _secrets_loaded
    if _secrets_loaded:
        return

    if os.environ.get("USE_GCP_SECRETS") != "true":
        return

    project_id = os.environ.get("GCP_PROJECT_ID")
    if not project_id:
        print("GCP SECRETS ERROR: USE_GCP_SECRETS is true but GCP_PROJECT_ID is not configured in env.")
        return

    try:
        from google.cloud import secretmanager
    except ImportError:
        print("GCP SECRETS ERROR: google-cloud-secret-manager package is not installed.")
        return

    print(f"Initializing GCP Secret Manager Client for project: {project_id}...")
    try:
        gcp_key_json = os.environ.get("GCP_SERVICE_ACCOUNT_KEY_JSON")
        if gcp_key_json:
            import json
            from google.oauth2 import service_account
            try:
                info = json.loads(gcp_key_json)
                credentials = service_account.Credentials.from_service_account_info(info)
                client = secretmanager.SecretManagerServiceClient(credentials=credentials)
                print("GCP SECRETS: Authenticated using in-memory Service Account JSON Key.")
            except Exception as auth_err:
                print(f"GCP SECRETS ERROR: Failed to parse in-memory GCP_SERVICE_ACCOUNT_KEY_JSON: {auth_err}")
                client = secretmanager.SecretManagerServiceClient()
        else:
            client = secretmanager.SecretManagerServiceClient()
        
        # We fetch these three standard secrets
        secrets_to_load = ["JWT_SECRET", "GOOGLE_CLIENT_ID", "DATABASE_URL"]
        
        for secret_name in secrets_to_load:
            resource_name = f"projects/{project_id}/secrets/{secret_name}/versions/latest"
            try:
                response = client.access_secret_version(request={"name": resource_name})
                secret_val = response.payload.data.decode("UTF-8").strip()
                if secret_val:
                    os.environ[secret_name] = secret_val
                    print(f"GCP SECRETS: Successfully loaded and injected {secret_name} from Secret Manager.")
            except Exception as e:
                # Log the error but continue (e.g. DATABASE_URL might not be configured if using SQLite)
                print(f"GCP SECRETS WARNING: Could not fetch {secret_name} from Secret Manager: {e}")
                
        _secrets_loaded = True
        
    except Exception as e:
        print(f"GCP SECRETS CRITICAL: Failed to initialize Secret Manager Client: {e}")

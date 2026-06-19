#!/bin/bash

if [ -z "$1" ]; then
  echo "Usage: ./manage-user-stack.sh <user-id> [port] [action]"
  echo "Actions: up (default), down, restart, logs, status"
  exit 1
fi

USER_ID=$1
PORT=${2:-8000}
ACTION=${3:-up}

# Load standard .env if available
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

export USER_ID=$USER_ID
export PORT=$PORT

PROJECT_NAME="manga-reader-${USER_ID}"

# Detect whether to use 'docker compose' (V2) or 'docker-compose' (V1)
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
else
  COMPOSE_CMD="docker-compose"
fi

case "$ACTION" in
  up)
    echo "Starting stack for User: $USER_ID on Port: $PORT using $COMPOSE_CMD..."
    $COMPOSE_CMD -p "$PROJECT_NAME" up -d --build
    ;;
  down)
    echo "Stopping stack for User: $USER_ID using $COMPOSE_CMD..."
    $COMPOSE_CMD -p "$PROJECT_NAME" down
    ;;
  restart)
    echo "Restarting stack for User: $USER_ID using $COMPOSE_CMD..."
    $COMPOSE_CMD -p "$PROJECT_NAME" restart
    ;;
  logs)
    $COMPOSE_CMD -p "$PROJECT_NAME" logs -f
    ;;
  status)
    $COMPOSE_CMD -p "$PROJECT_NAME" ps
    ;;
  *)
    echo "Invalid action: $ACTION. Supported: up, down, restart, logs, status"
    exit 1
    ;;
esac

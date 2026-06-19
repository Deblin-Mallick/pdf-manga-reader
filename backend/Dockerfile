# Stage 1: Build the React frontend
FROM node:20-slim AS frontend-builder
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --legacy-peer-deps
COPY frontend/ ./
RUN npm run build

# Stage 2: Serve with FastAPI backend
FROM python:3.11-slim
WORKDIR /app

# Install backend dependencies
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend source code
COPY backend/ .

# Copy compiled frontend static assets
COPY --from=frontend-builder /frontend/dist ./static

# Expose port
EXPOSE 8000

# Ensure directories for SQLite, file uploads and covers exist
RUN mkdir -p data uploads covers

# Command to run uvicorn with configurable worker processes (defaults to 2 workers in production)
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers ${WORKERS:-2}"]

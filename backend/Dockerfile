# Stage 1: Build the React frontend
FROM node:18-slim AS frontend-builder
WORKDIR /frontend
COPY frontend/package.json ./
RUN npm install
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

# Command to run uvicorn
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

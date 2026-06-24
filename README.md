# 📚 PDF & Manga Reader

A premium, high-performance, and fully containerized web application designed for reading PDF books and manga archives (`.cbz` / `.zip`). Built with a beautiful glassmorphic dark-mode user interface, it features smart page layouts, keyboard navigation, reading adjustment filters, and Google OAuth-based progress synchronization.

---

## ✨ Features

### 🗃️ Library Management & Dashboard
*   **Drag & Drop Upload**: Upload books and manga archives effortlessly through a modern drag-and-drop zone.
*   **On-the-Fly Thumbnail Generation**: Automatically extracts and scales page 1 of PDFs or ZIP files using HTML5 Canvas on the client-side for lightweight, network-friendly cover generation.
*   **Interactive Book Shelf**: Clean filter tabs (All, PDF, Manga, Completed), search utilities, and hover-triggered reading actions.
*   **Real-time Progress Tracking**: Circular or bar-based progress overlays displaying page indicators and reading completion percentages.

### 📄 Advanced PDF Reader
*   **Rendering engine**: Powered by `pdf.js` for crisp vector text and image scaling.
*   **Fit Width / Fit Height Modes**: Responsive fitting modes to adapt documents to your viewport.
*   **Zoom Controls**: Interactive zoom-in/zoom-out capabilities (from 50% to 300%).
*   **True Night Mode**: Interactive canvas-level color inversion filters for comfortable reading in low-light environments.

### 📖 Tailored Manga Reader
*   **CBZ & ZIP Archive Parsing**: Extract and read manga chapters packaged in `.zip` or `.cbz` image archives asynchronously.
*   **Flexible Layouts**:
    *   **Single Page Mode**: View single pages at a time.
    *   **Double Page Mode**: Side-by-side layout replicating a physical book/manga experience.
    *   **Webtoon Mode**: Continuous vertical scroll format for webcomics.
*   **Reading Direction**: Easily toggle between Right-to-Left (RTL - manga standard) and Left-to-Right (LTR) reading directions.
*   **Dynamic Pre-loading**: Uses an asynchronous sliding-window cache to pre-load neighboring pages in the background, ensuring near-instant page turns.
*   **Scan Tuning Overlay**: Live slider filters to adjust image **Brightness** and **Contrast** to clean up raw scans.

### 🔒 User Authentication & Synchronization
*   **Google OAuth 2.0 Integration**: Sign-in seamlessly to synchronize your library and exact reading state across multiple devices.
*   **Guest Mode Fallback**: Full library usability available out-of-the-box without sign-in, persisting records locally.
*   **Encrypted Tokens**: JWT-based session validation between React frontend and FastAPI backend.

---

## 🛠️ Tech Stack

| Component | Technology | Description |
| :--- | :--- | :--- |
| **Frontend** | React 18, TypeScript, Vite | Modern single-page application compiler |
| **PDF Rendering**| `pdfjs-dist` (v4) | Mozilla's standard PDF parser & renderer |
| **ZIP Extraction**| `jszip` | In-browser unpacking of `.cbz` / `.zip` archives |
| **Icons** | `lucide-react` | Clean SVG visual cues and styling icons |
| **Backend** | FastAPI (Python 3.10+) | High-performance asynchronous API framework |
| **Database** | SQLite / PostgreSQL | Relational storage for metadata and progress |
| **Security** | PyJWT, python-multipart | OAuth validation and secure session creation |
| **Image Processing**| `Pillow` | WebP conversion and cover generation |
| **Storage** | NFS Mount (`/mnt/library_storage`) | Server-mapped storage for library files |
| **Containerization**| Docker, Docker Compose | Single command multi-stage deployment build |

---

## 📂 Project Structure

```
├── backend/
│   ├── app/
│   │   ├── auth.py         # Google OAuth & local JWT authentication
│   │   ├── compression.py  # Gzip compression utilities (legacy)
│   │   ├── db.py           # SQLite / Postgres schema and session manager
│   │   └── main.py         # FastAPI routes, NFS storage paths, and range streaming
│   ├── covers/             # Cover thumbnails directory (ignored in git)
│   ├── Dockerfile          # Multi-stage production build (builds UI -> runs Python)
│   └── requirements.txt    # Python dependencies
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Dashboard.tsx    # Library search, upload, and authentication
│   │   │   ├── MangaReader.tsx  # Layout options, rendering, and image tuning
│   │   │   └── PDFReader.tsx    # PDF Canvas loader, zoom, and night-mode filters
│   │   ├── App.tsx         # Main entry, state routing, and sync loop
│   │   ├── index.css       # Core styling & custom glassmorphism styles
│   │   └── main.tsx        # React DOM initiator
│   ├── package.json        # Frontend configuration and Vite scripts
│   └── tsconfig.json       # TypeScript rule definitions
├── docker-compose.yml       # Docker orchestrator
├── package.json            # Root configuration (concurrent local runs)
└── .env.example            # Template for credential keys
```

---

## 💾 Storage Architecture (NFS)

Rather than storing binary files inside local uploads folders, the media library's backend storage pipeline is refactored to interface with a mounted NFS (Network File System) at `/mnt/library_storage/`.

### Directory Configuration Schema
- **ePub binaries**: `/mnt/library_storage/binaries/epubs/{book_id}.epub`
- **PDF binaries**:  `/mnt/library_storage/binaries/pdfs/{book_id}.pdf`
- **Manga pages**:  `/mnt/library_storage/manga/{book_id}/{chapter_id}/{page_number}.webp`

### Manga Extraction & WebP Optimization
When an administrator uploads a `.cbz` or `.zip` file:
1. The zip archive is unpacked to a temporary directory under `/tmp`.
2. All images are processed and converted to `.webp` using Pillow for size optimization.
3. The directory matrix is created and populated on the NFS (`/mnt/library_storage/manga/{book_id}/{chapter_id}/{page_number}.webp`).
4. A relative path page manifest is stored in the database, enabling page image streaming.
5. The cover is automatically generated from the first page in the manifest.
6. Temporary files inside `/tmp` are cleaned up immediately.

### Seek & Range Request Support
- Encompasses optimized streaming at `GET /books/:id/stream` and `GET /api/books/:id/file`.
- Supports chunk-seeking through HTTP `Range` headers, returning partial `206` responses with appropriate `Accept-Ranges`, `Content-Length`, and `Content-Range` headers.
- Handles NFS latency and network disconnections gracefully using safety-checked I/O operations (yielding `503 Service Unavailable` on filesystem failure instead of crashing).

---

## 🚀 Getting Started

### Prerequisites
Make sure you have the following installed on your machine:
*   [Node.js](https://nodejs.org/) (v18+)
*   [Python](https://www.python.org/) (v3.11+)

---

### Local Development Setup

Follow these steps to run the frontend and backend in concurrent development modes.

1.  **Clone the Repository**:
    ```bash
    git clone https://github.com/Deblin-Mallick/pdf-manga-reader.git
    cd pdf-manga-reader
    ```

2.  **Install Frontend Dependencies**:
    ```bash
    npm run install:frontend
    ```

3.  **Setup Backend Virtual Environment**:
    ```bash
    cd backend
    python -m venv .venv
    ```
    *   **Activate on Windows (PowerShell)**:
        ```powershell
        .venv\Scripts\Activate.ps1
        ```
    *   **Activate on macOS / Linux**:
        ```bash
        source .venv/bin/activate
        ```

4.  **Install Backend Dependencies**:
    ```bash
    pip install -r requirements.txt
    cd ..
    ```

5.  **Configure Environment Variables**:
    Copy `.env.example` into a new `.env` file at the root:
    ```bash
    copy .env.example .env
    ```
    Open `.env` and configure your credentials:
    *   `GOOGLE_CLIENT_ID`: Your credentials client ID from Google Cloud Console.
    *   `JWT_SECRET`: A secure random string used to sign backend session cookies.

6.  **Run Development Servers**:
    From the root directory, start the FastAPI backend and Vite dev server concurrently:
    ```bash
    npm run dev
    ```
    The application will be accessible at **`http://localhost:5173`** (Vite frontend proxying api calls to `http://localhost:8000`).

---

### 🐳 Running with Docker (Recommended)

The project includes a multi-stage `Dockerfile` and a `docker-compose.yml` configuration to orchestrate a two-container architecture (one for the FastAPI server/frontend and one for the PostgreSQL database). If the web server crashes or restarts, the database container remains running and unaffected.

1.  Create and configure the `.env` file in the root directory.
2.  Start the services:
    ```bash
    docker-compose up --build
    ```
3.  The web application will be running at **`http://localhost:8000`**.
4.  All cover images and the PostgreSQL database are persisted inside Docker-managed volumes (`covers` and `pgdata`). For the library storage, ensure that the host's NFS mount point `/mnt/library_storage` is passed/mounted into the backend container at `/mnt/library_storage` (e.g. via volume binding `/mnt/library_storage:/mnt/library_storage` in `docker-compose.yml`). This ensures that your files and databases are completely safe from deletion when updating stack builds or pulling new repository commits in Portainer.

---

## ⌨️ Shortcuts & Keyboard Controls

| Key | PDF Reader Action | Manga Reader Action |
| :--- | :--- | :--- |
| **Arrow Right** | Go to Next Page | RTL: Previous Page \| LTR: Next Page |
| **Arrow Left** | Go to Previous Page | RTL: Next Page \| LTR: Previous Page |
| **Spacebar** | Scroll View Down | Go to Next Page |

---

## 🔒 Security Configuration (Google OAuth 2.0)

To enable authentication:
1.  Go to the [Google Cloud Console](https://console.cloud.google.com/).
2.  Create a project, then navigate to **APIs & Services > Credentials**.
3.  Configure your OAuth consent screen and create an **OAuth client ID** for Web Applications.
4.  Add `http://localhost:5173` (development) and `http://localhost:8000` (production) to your **Authorized JavaScript origins**.
5.  Copy the client ID and paste it as `GOOGLE_CLIENT_ID` in your `.env` file.

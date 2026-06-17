import React, { useState, useRef, useEffect } from 'react';
import { Upload, Trash2, Book, FileText, Search, Play, Plus, BookOpen, LogIn } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import JSZip from 'jszip';
import { Book as BookType, User } from '../App';

// Setup PDF.js worker source via CDN for flawless Vite bundling
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.370/pdf.worker.min.mjs';

interface DashboardProps {
  books: BookType[];
  user: User | null;
  googleClientId: string;
  onSelectBook: (book: BookType) => void;
  onUploadSuccess: (book: BookType) => void;
  onDeleteBook: (bookId: string) => void;
  onInitGoogleAuth: () => void;
}

export default function Dashboard({
  books,
  user,
  googleClientId,
  onSelectBook,
  onUploadSuccess,
  onDeleteBook,
  onInitGoogleAuth,
}: DashboardProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string>('');
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | 'pdf' | 'cbz' | 'completed'>('all');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Trigger Google Login Button rendering if not logged in
  useEffect(() => {
    if (user?.id === 'guest' && googleClientId) {
      onInitGoogleAuth();
    }
  }, [user, googleClientId, onInitGoogleAuth]);

  // Handle drag events
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      await processFile(files[0]);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      await processFile(files[0]);
    }
  };

  // Helper to resize image using Canvas for covers
  const createThumbnailBlob = (imageBlob: Blob): Promise<Blob> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.src = URL.createObjectURL(imageBlob);
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxDim = 320;
        let w = img.width;
        let h = img.height;
        if (w > h) {
          if (w > maxDim) {
            h = Math.round((h * maxDim) / w);
            w = maxDim;
          }
        } else {
          if (h > maxDim) {
            w = Math.round((w * maxDim) / h);
            h = maxDim;
          }
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, w, h);
          canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else resolve(imageBlob);
          }, 'image/jpeg', 0.85);
        } else {
          resolve(imageBlob);
        }
      };
      img.onerror = () => resolve(imageBlob);
    });
  };

  // Extract pages and render page 1 as cover
  const processFile = async (file: File) => {
    const isPdf = file.name.toLowerCase().endsWith('.pdf');
    const isManga = file.name.toLowerCase().endsWith('.cbz') || file.name.toLowerCase().endsWith('.zip');

    if (!isPdf && !isManga) {
      alert('Supported formats: PDF, CBZ, and ZIP manga archives.');
      return;
    }

    setUploadStatus('Analyzing document...');
    setUploadProgress(10);

    try {
      const fileBuffer = await file.arrayBuffer();
      let totalPages = 1;
      let coverBlob: Blob | null = null;
      const title = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;

      if (isPdf) {
        // PDF Cover extraction
        const pdf = await pdfjsLib.getDocument({ data: fileBuffer }).promise;
        totalPages = pdf.numPages;
        
        // Render first page as Cover
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 0.6 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          await page.render({ canvasContext: ctx, viewport }).promise;
          coverBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
        }
      } else {
        // ZIP/CBZ Cover extraction
        const zip = await JSZip.loadAsync(fileBuffer);
        const fileNames = Object.keys(zip.files);
        // Find all image files
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'];
        const imageFiles = fileNames
          .filter((name) => imageExtensions.some((ext) => name.toLowerCase().endsWith(ext)) && !zip.files[name].dir)
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

        if (imageFiles.length === 0) {
          throw new Error('No images found in CBZ/ZIP archive');
        }

        totalPages = imageFiles.length;
        
        // Extract first image
        const firstImageFile = zip.files[imageFiles[0]];
        const imageBlobRaw = await firstImageFile.async('blob');
        coverBlob = await createThumbnailBlob(imageBlobRaw);
      }

      setUploadStatus('Uploading and compressing file...');
      setUploadProgress(40);

      // Construct Multipart form upload
      const formData = new FormData();
      formData.append('title', title);
      formData.append('type', isPdf ? 'pdf' : 'cbz');
      formData.append('total_pages', totalPages.toString());
      formData.append('file', file);
      if (coverBlob) {
        formData.append('cover', coverBlob, 'cover.jpg');
      }

      // XHR upload to capture progress
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/books');
      
      const jwtToken = localStorage.getItem('reader_jwt');
      if (jwtToken) {
        xhr.setRequestHeader('Authorization', `Bearer ${jwtToken}`);
      }

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const percent = 40 + Math.round((e.loaded / e.total) * 55);
          setUploadProgress(percent);
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const responseBook = JSON.parse(xhr.responseText);
          onUploadSuccess(responseBook);
          setUploadStatus('Upload complete!');
          setUploadProgress(100);
          setTimeout(() => {
            setUploadStatus('');
            setUploadProgress(0);
          }, 2000);
        } else {
          setUploadStatus('');
          alert('Upload failed: ' + xhr.responseText);
        }
      };

      xhr.onerror = () => {
        setUploadStatus('');
        alert('An error occurred during file upload.');
      };

      xhr.send(formData);

    } catch (err) {
      console.error(err);
      setUploadStatus('');
      alert(err instanceof Error ? err.message : 'Error processing document.');
    }
  };

  // Filter books based on search query and tabs
  const filteredBooks = books.filter((book) => {
    const matchesSearch = book.title.toLowerCase().includes(searchQuery.toLowerCase());
    if (!matchesSearch) return false;

    if (activeTab === 'pdf') return book.type === 'pdf';
    if (activeTab === 'cbz') return book.type === 'cbz';
    if (activeTab === 'completed') return book.current_page >= book.total_pages;
    
    return true;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '32px', maxWidth: '1200px', width: '100%', margin: '0 auto' }}>
      
      {/* Upload Zone */}
      <section 
        className={`glass-panel ${isDragging ? 'dragging-active' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{
          border: '2px dashed var(--border-glass)',
          padding: '40px',
          textAlign: 'center',
          cursor: 'pointer',
          position: 'relative',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '16px',
        }}
        onClick={() => fileInputRef.current?.click()}
      >
        <input 
          type="file" 
          ref={fileInputRef} 
          style={{ display: 'none' }} 
          accept=".pdf,.cbz,.zip"
          onChange={handleFileSelect}
        />
        
        {uploadStatus ? (
          <div style={{ width: '100%', maxWidth: '300px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <span style={{ fontSize: '0.95rem', color: 'var(--text-primary)', fontWeight: 500 }}>
              {uploadStatus}
            </span>
            <div style={{ width: '100%', height: '6px', backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: '3px', overflow: 'hidden' }}>
              <div 
                style={{ 
                  height: '100%', 
                  width: `${uploadProgress}%`, 
                  background: 'linear-gradient(90deg, var(--accent-primary), var(--accent-secondary))',
                  transition: 'width 0.2s ease-out'
                }} 
              />
            </div>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              {uploadProgress}%
            </span>
          </div>
        ) : (
          <>
            <div style={{ padding: '16px', borderRadius: '50%', background: 'rgba(139, 92, 246, 0.06)', color: 'var(--accent-primary)', display: 'inline-flex' }} className="pulse-glow">
              <Upload size={32} />
            </div>
            <div>
              <h3 style={{ fontSize: '1.2rem', marginBottom: '6px', color: '#fff' }}>Drag & Drop books or manga here</h3>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Supports PDF documents, .CBZ and .ZIP manga archives</p>
            </div>
            <button className="btn-primary" type="button" onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}>
              <Plus size={16} /> Choose File
            </button>
          </>
        )}
      </section>

      {/* Cloud Login CTA (for guest users) */}
      {user?.id === 'guest' && (
        <section className="glass-panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '24px', flexWrap: 'wrap', gap: '16px', background: 'radial-gradient(ellipse at bottom right, rgba(6, 182, 212, 0.08), transparent)' }}>
          <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
            <div style={{ padding: '12px', borderRadius: '12px', backgroundColor: 'rgba(6, 182, 212, 0.08)', color: 'var(--accent-secondary)' }}>
              <LogIn size={24} />
            </div>
            <div>
              <h3 style={{ fontSize: '1.1rem', marginBottom: '4px' }}>Want to sync library across devices?</h3>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                {googleClientId 
                  ? 'Sign in using your Google account to associate your files and reading progress.'
                  : 'Configure a Google Client ID in the top right Settings to enable secure Sign-In.'
                }
              </p>
            </div>
          </div>
          
          {googleClientId ? (
            <div id="google-signin-btn"></div>
          ) : (
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', border: '1px solid var(--border-glass)', borderRadius: '8px', padding: '8px 12px', backgroundColor: 'rgba(255,255,255,0.01)' }}>
              Awaiting OAuth configuration
            </div>
          )}
        </section>
      )}

      {/* Catalog Filters and Search */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
          
          {/* Tabs */}
          <div className="glass-panel" style={{ padding: '4px', display: 'flex', gap: '4px', borderRadius: '12px' }}>
            {(['all', 'pdf', 'cbz', 'completed'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: '8px 16px',
                  borderRadius: '8px',
                  fontSize: '0.85rem',
                  fontWeight: 500,
                  textTransform: 'capitalize',
                  backgroundColor: activeTab === tab ? 'rgba(255,255,255,0.06)' : 'transparent',
                  color: activeTab === tab ? '#fff' : 'var(--text-secondary)',
                  border: activeTab === tab ? '1px solid var(--border-glass)' : '1px solid transparent',
                }}
              >
                {tab === 'cbz' ? 'Manga (CBZ)' : tab === 'pdf' ? 'Books (PDF)' : tab}
              </button>
            ))}
          </div>

          {/* Search bar */}
          <div className="glass-panel" style={{ display: 'flex', alignItems: 'center', padding: '6px 16px', gap: '8px', width: '100%', maxWidth: '300px' }}>
            <Search size={16} style={{ color: 'var(--text-muted)' }} />
            <input 
              type="text" 
              placeholder="Search library..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ width: '100%', border: 'none', background: 'none', color: '#fff', fontSize: '0.9rem', outline: 'none' }}
            />
          </div>
        </div>

        {/* Shelf Books Grid */}
        {filteredBooks.length > 0 ? (
          <div className="shelf-grid">
            {filteredBooks.map((book) => {
              const progressPercentage = book.total_pages > 0 
                ? Math.round((book.current_page / book.total_pages) * 100)
                : 0;

              return (
                <div 
                  key={book.id} 
                  className="glass-panel glass-panel-interactive fade-in"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    position: 'relative',
                    height: '350px',
                  }}
                >
                  {/* Cover Section */}
                  <div style={{ flex: 1, position: 'relative', overflow: 'hidden', backgroundColor: '#0f0f15', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {book.cover_path ? (
                      <img 
                        src={book.cover_path} 
                        alt={book.title} 
                        style={{ width: '100%', height: '100%', objectFit: 'cover', transition: 'transform 0.5s ease' }} 
                        className="book-cover-img"
                      />
                    ) : (
                      /* Fallback Cover Gradient */
                      <div 
                        style={{ 
                          width: '100%', 
                          height: '100%', 
                          background: book.type === 'pdf' 
                            ? 'linear-gradient(135deg, #4c1d95 0%, #1e1b4b 100%)' 
                            : 'linear-gradient(135deg, #0f766e 0%, #0f172a 100%)',
                          display: 'flex',
                          flexDirection: 'column',
                          justifyContent: 'center',
                          alignItems: 'center',
                          padding: '16px',
                          textAlign: 'center'
                        }}
                      >
                        {book.type === 'pdf' ? <FileText size={42} style={{ color: 'var(--accent-primary)', marginBottom: '8px' }} /> : <BookOpen size={42} style={{ color: 'var(--accent-secondary)', marginBottom: '8px' }} />}
                        <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'rgba(255,255,255,0.7)', display: 'block', maxWidth: '100%', textOverflow: 'ellipsis', overflow: 'hidden' }}>{book.title}</span>
                      </div>
                    )}

                    {/* Format Tag */}
                    <div style={{ position: 'absolute', top: '10px', left: '10px', padding: '4px 8px', borderRadius: '4px', fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', backgroundColor: book.type === 'pdf' ? 'rgba(139,92,246,0.9)' : 'rgba(6,182,212,0.9)', color: '#fff' }}>
                      {book.type === 'pdf' ? 'pdf' : 'manga'}
                    </div>

                    {/* Actions Hover Overlay */}
                    <div className="card-overlay" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px', opacity: 0, transition: 'opacity 0.25s ease' }}>
                      <button 
                        onClick={() => onSelectBook(book)}
                        className="btn-primary" 
                        style={{ padding: '10px 16px', borderRadius: '50px' }}
                      >
                        <Play size={16} fill="white" /> Read
                      </button>
                      <button 
                        onClick={(e) => { e.stopPropagation(); onDeleteBook(book.id); }}
                        style={{ backgroundColor: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#ef4444', padding: '10px', borderRadius: '50%' }}
                        title="Delete Book"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>

                  {/* Metadata Section */}
                  <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px', borderTop: '1px solid var(--border-glass)' }}>
                    <h4 
                      style={{ 
                        fontSize: '0.95rem', 
                        whiteSpace: 'nowrap', 
                        overflow: 'hidden', 
                        textOverflow: 'ellipsis',
                        color: '#fff'
                      }}
                      title={book.title}
                    >
                      {book.title}
                    </h4>
                    
                    {/* Progress tracking */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        <span>Page {book.current_page} of {book.total_pages}</span>
                        <span>{progressPercentage}%</span>
                      </div>
                      <div style={{ width: '100%', height: '4px', backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: '2px', overflow: 'hidden' }}>
                        <div 
                          style={{ 
                            height: '100%', 
                            width: `${progressPercentage}%`, 
                            backgroundColor: progressPercentage >= 100 ? '#22c55e' : 'var(--accent-primary)',
                            borderRadius: '2px' 
                          }} 
                        />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="glass-panel" style={{ padding: '60px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
            <Book size={48} style={{ color: 'var(--text-muted)' }} />
            <div>
              <h3 style={{ fontSize: '1.2rem', color: '#fff', marginBottom: '4px' }}>No books matching filters</h3>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                {books.length === 0 ? 'Upload a PDF or CBZ file to start reading.' : 'Try changing your search query or shelf tabs.'}
              </p>
            </div>
          </div>
        )}
      </section>

      {/* local styling for card overlays */}
      <style>{`
        .glass-panel-interactive:hover .card-overlay {
          opacity: 1 !important;
        }
        .glass-panel-interactive:hover .book-cover-img {
          transform: scale(1.05);
        }
      `}</style>
    </div>
  );
}

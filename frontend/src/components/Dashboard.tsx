import React, { useState, useRef, useEffect } from 'react';
import { Upload, Trash2, Book, FileText, Search, Play, Plus, BookOpen, RefreshCw } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import JSZip from 'jszip';
import { motion, AnimatePresence } from 'framer-motion';
import { Book as BookType, User } from '../App';
import { cn } from '@/lib/utils';

// Setup PDF.js worker source via CDN for flawless Vite bundling
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';

interface DashboardProps {
  books: BookType[];
  user: User | null;
  googleClientId: string;
  onSelectBook: (book: BookType) => void;
  onUploadSuccess: (book: BookType) => void;
  onDeleteBook: (bookId: string) => void;
  onConvertBook: (bookId: string) => void;
  onInitGoogleAuth: () => void;
}

export default function Dashboard({
  books,
  user,
  googleClientId,
  onSelectBook,
  onUploadSuccess,
  onDeleteBook,
  onConvertBook,
  onInitGoogleAuth,
}: DashboardProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string>('');
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | 'pdf' | 'cbz' | 'completed'>('all');
  const [convertToEpub, setConvertToEpub] = useState(false);
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
      if (isPdf && convertToEpub) {
        formData.append('convert_to_epub', 'true');
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

    if (activeTab === 'pdf') return book.type === 'pdf' || book.type === 'epub';
    if (activeTab === 'cbz') return book.type === 'cbz';
    if (activeTab === 'completed') return book.current_page >= book.total_pages;
    
    return true;
  });

  return (
    <div className="flex flex-col gap-8 max-w-[1200px] w-full mx-auto">
      
      {/* Upload Zone */}
      <section 
        className={cn(
          "glass-panel border-2 border-dashed border-[var(--border-glass)] p-10 text-center cursor-pointer relative overflow-hidden flex flex-col items-center justify-center gap-4 transition-all duration-300",
          isDragging ? "border-[var(--accent-primary)] shadow-[var(--shadow-neon-purple)] bg-[rgba(139,92,246,0.05)]" : ""
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input 
          type="file" 
          ref={fileInputRef} 
          className="hidden" 
          accept=".pdf,.cbz,.zip"
          onChange={handleFileSelect}
        />
        
        {uploadStatus ? (
          <div className="w-full max-w-[300px] flex flex-col gap-3">
            <span className="text-sm font-medium text-[var(--text-primary)]">
              {uploadStatus}
            </span>
            <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
              <div 
                className="h-full bg-gradient-to-r from-[var(--accent-primary)] to-[var(--accent-secondary)] transition-all duration-200"
                style={{ width: `${uploadProgress}%` }} 
              />
            </div>
            <span className="text-xs text-[var(--text-muted)]">
              {uploadProgress}%
            </span>
          </div>
        ) : (
          <>
            <div className="p-4 rounded-full bg-[rgba(139,92,246,0.06)] text-[var(--accent-primary)] inline-flex pulse-glow">
              <Upload size={32} />
            </div>
            <div>
              <h3 className="text-lg font-semibold mb-1.5 text-white">Drag & Drop books or manga here</h3>
              <p className="text-xs text-[var(--text-secondary)]">Supports PDF documents, .CBZ and .ZIP manga archives</p>
            </div>
            <button className="btn-primary" type="button" onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}>
              <Plus size={16} /> Choose File
            </button>
            <div 
              onClick={(e) => e.stopPropagation()} 
              className="mt-2 flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-default"
            >
              <input 
                type="checkbox" 
                id="epub-convert-checkbox" 
                checked={convertToEpub} 
                onChange={(e) => setConvertToEpub(e.target.checked)}
                className="cursor-pointer accent-[var(--accent-primary)] w-4 h-4"
              />
              <label htmlFor="epub-convert-checkbox" className="cursor-pointer select-none">
                Convert PDF uploads to EPUB format
              </label>
            </div>
          </>
        )}
      </section>

      {/* Catalog Filters and Search */}
      <section className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          
          {/* Tabs */}
          <div className="glass-panel p-1 flex gap-1 rounded-xl">
            {(['all', 'pdf', 'cbz', 'completed'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  "px-4 py-2 rounded-lg text-xs md:text-sm font-medium capitalize border transition-all duration-200",
                  activeTab === tab 
                    ? "bg-white/5 text-white border-[var(--border-glass)]" 
                    : "bg-transparent text-[var(--text-secondary)] border-transparent hover:text-white"
                )}
              >
                {tab === 'cbz' ? 'Manga (CBZ)' : tab === 'pdf' ? 'Books (PDF/EPUB)' : tab}
              </button>
            ))}
          </div>

          {/* Search bar */}
          <div className="glass-panel flex items-center px-4 py-2 gap-2 w-full max-w-[300px]">
            <Search size={16} className="text-[var(--text-muted)]" />
            <input 
              type="text" 
              placeholder="Search library..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full border-none bg-transparent text-white text-sm outline-none placeholder:text-[var(--text-muted)]"
            />
          </div>
        </div>

        {/* Shelf Books Grid */}
        <AnimatePresence mode="popLayout">
          {filteredBooks.length > 0 ? (
            <motion.div 
              layout
              className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-6"
            >
              {filteredBooks.map((book) => {
                const progressPercentage = book.total_pages > 0 
                  ? Math.round((book.current_page / book.total_pages) * 100)
                  : 0;

                return (
                  <motion.div 
                    layout
                    key={book.id}
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={{ duration: 0.25 }}
                    className="glass-panel group flex flex-col overflow-hidden relative h-[350px] transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl hover:border-[var(--border-glass-active)]"
                  >
                    {/* Cover Section */}
                    <div className="flex-1 relative overflow-hidden bg-[#0f0f15] flex items-center justify-center">
                      {book.cover_path ? (
                        <img 
                          src={book.cover_path} 
                          alt={book.title} 
                          className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" 
                        />
                      ) : (
                        /* Fallback Cover Gradient */
                        <div 
                          className={cn(
                            "w-full h-full flex flex-col justify-center items-center p-4 text-center",
                            book.type === 'pdf' 
                              ? 'bg-gradient-to-br from-[#4c1d95] to-[#1e1b4b]' 
                              : 'bg-gradient-to-br from-[#0f766e] to-[#0f172a]'
                          )}
                        >
                          {book.type === 'pdf' ? (
                            <FileText size={42} className="text-[var(--accent-primary)] mb-2" />
                          ) : (
                            <BookOpen size={42} className="text-[var(--accent-secondary)] mb-2" />
                          )}
                          <span className="text-xs font-semibold text-white/70 block max-w-full truncate">{book.title}</span>
                        </div>
                      )}

                      {/* Format Tag */}
                      <div 
                        className={cn(
                          "absolute top-2.5 left-2.5 px-2 py-1 rounded text-[10px] font-semibold uppercase tracking-wider text-white",
                          book.type === 'pdf' ? 'bg-[var(--accent-primary)]/90' : 'bg-[var(--accent-secondary)]/90'
                        )}
                      >
                        {book.type === 'pdf' ? 'pdf' : 'manga'}
                      </div>

                      {/* Actions Hover Overlay */}
                      <div className="absolute inset-0 bg-black/60 flex items-center justify-center gap-4 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                        <button 
                          onClick={() => onSelectBook(book)}
                          className="btn-primary py-2.5 px-4 rounded-full"
                        >
                          <Play size={16} fill="white" /> Read
                        </button>
                        {book.type === 'pdf' && (
                          <button 
                            onClick={(e) => { e.stopPropagation(); onConvertBook(book.id); }}
                            className="bg-[var(--accent-primary)]/15 border border-[var(--accent-primary)]/30 text-[var(--accent-primary)] p-2.5 rounded-full hover:bg-[var(--accent-primary)]/30 transition-all duration-200"
                            title="Convert PDF to EPUB"
                          >
                            <RefreshCw size={16} />
                          </button>
                        )}
                        <button 
                          onClick={(e) => { e.stopPropagation(); onDeleteBook(book.id); }}
                          className="bg-red-500/15 border border-red-500/30 text-red-500 p-2.5 rounded-full hover:bg-red-500/30 transition-all duration-200"
                          title="Delete Book"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>

                    {/* Metadata Section */}
                    <div className="p-4 flex flex-col gap-2 border-t border-[var(--border-glass)]">
                      <h4 
                        className="text-sm font-semibold truncate text-white"
                        title={book.title}
                      >
                        {book.title}
                      </h4>
                      
                      {/* Progress tracking */}
                      <div className="flex flex-col gap-1">
                        <div className="flex justify-between text-[10px] text-[var(--text-secondary)]">
                          <span>Page {book.current_page} of {book.total_pages}</span>
                          <span>{progressPercentage}%</span>
                        </div>
                        <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
                          <div 
                            className={cn(
                              "h-full rounded-full transition-all duration-300",
                              progressPercentage >= 100 ? 'bg-green-500' : 'bg-[var(--accent-primary)]'
                            )}
                            style={{ width: `${progressPercentage}%` }} 
                          />
                        </div>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </motion.div>
          ) : (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="glass-panel p-16 text-center flex flex-col items-center gap-4"
            >
              <Book size={48} className="text-[var(--text-muted)]" />
              <div>
                <h3 className="text-lg font-semibold text-white mb-1">No books matching filters</h3>
                <p className="text-xs text-[var(--text-secondary)]">
                  {books.length === 0 ? 'Upload a PDF or CBZ file to start reading.' : 'Try changing your search query or shelf tabs.'}
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    </div>
  );
}

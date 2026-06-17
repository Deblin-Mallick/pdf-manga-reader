import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Layout, AlignJustify, Eye, Sun, Undo } from 'lucide-react';
import JSZip from 'jszip';
import { Book } from '../App';

interface MangaReaderProps {
  book: Book;
  token: string | null;
  onBack: () => void;
  onUpdateProgress: (
    bookId: string,
    progress: {
      current_page: number;
      zoom: number;
      view_mode: string;
      scroll_position: number;
      reading_direction: 'ltr' | 'rtl';
    }
  ) => void;
}

export default function MangaReader({
  book,
  token,
  onBack,
  onUpdateProgress,
}: MangaReaderProps) {
  const [zip, setZip] = useState<JSZip | null>(null);
  const [imageKeys, setImageKeys] = useState<string[]>([]);
  const [cachedUrls, setCachedUrls] = useState<{ [index: number]: string }>({});
  
  const [currentPage, setCurrentPage] = useState(book.current_page || 1);
  const [viewMode, setViewMode] = useState<string>(book.view_mode || 'single-page'); // single-page, double-page, webtoon
  const [readingDirection, setReadingDirection] = useState<'ltr' | 'rtl'>(book.reading_direction || 'rtl');
  const [brightness, setBrightness] = useState<number>(100);
  const [contrast, setContrast] = useState<number>(100);
  
  const [loading, setLoading] = useState(true);
  const [loadingText, setLoadingText] = useState('Downloading manga...');
  const containerRef = useRef<HTMLDivElement>(null);

  // Load zip and find files
  useEffect(() => {
    let isMounted = true;
    const loadZipFile = async () => {
      try {
        const headers: HeadersInit = {};
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        
        const response = await fetch(`/api/books/${book.id}/file`, { headers });
        if (!response.ok) {
          throw new Error('Failed to load manga file');
        }
        
        setLoadingText('Parsing CBZ/ZIP archive...');
        const buffer = await response.arrayBuffer();
        
        const loadedZip = await JSZip.loadAsync(buffer);
        const fileNames = Object.keys(loadedZip.files);
        
        // Find and sort all image entries
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'];
        const sortedKeys = fileNames
          .filter((name) => imageExtensions.some((ext) => name.toLowerCase().endsWith(ext)) && !loadedZip.files[name].dir)
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

        if (sortedKeys.length === 0) {
          throw new Error('No images found in CBZ/ZIP file.');
        }

        if (isMounted) {
          setZip(loadedZip);
          setImageKeys(sortedKeys);
          setLoading(false);
        }
      } catch (err) {
        console.error('Error reading manga:', err);
        alert(err instanceof Error ? err.message : 'Failed to load manga archive.');
        onBack();
      }
    };

    loadZipFile();

    return () => {
      isMounted = false;
      // Clean up object URLs to avoid memory leaks
      setCachedUrls((prev) => {
        Object.values(prev).forEach((url) => URL.revokeObjectURL(url));
        return {};
      });
    };
  }, [book.id, token, onBack]);

  // Extract page image on-demand
  const getPageUrl = useCallback(async (index: number): Promise<string> => {
    if (index < 0 || index >= imageKeys.length || !zip) return '';
    if (cachedUrls[index]) return cachedUrls[index];

    try {
      const file = zip.files[imageKeys[index]];
      const blob = await file.async('blob');
      const url = URL.createObjectURL(blob);
      setCachedUrls((prev) => ({ ...prev, [index]: url }));
      return url;
    } catch (err) {
      console.error(`Error loading page ${index}:`, err);
      return '';
    }
  }, [zip, imageKeys, cachedUrls]);

  // Pre-load sliding window of next 2 pages in background
  useEffect(() => {
    if (!zip || imageKeys.length === 0) return;

    const preload = async () => {
      // Preload current page, next page, and following
      const indicesToPreload = [currentPage - 1, currentPage, currentPage + 1];
      if (viewMode === 'double-page') {
        indicesToPreload.push(currentPage + 2);
      }
      
      for (const idx of indicesToPreload) {
        if (idx >= 0 && idx < imageKeys.length && !cachedUrls[idx]) {
          await getPageUrl(idx);
        }
      }
    };

    preload();
  }, [currentPage, zip, imageKeys, viewMode, cachedUrls, getPageUrl]);

  // Sync Progress to Backend
  const syncProgress = useCallback((page: number) => {
    onUpdateProgress(book.id, {
      current_page: page,
      zoom: 1.0,
      view_mode: viewMode,
      scroll_position: containerRef.current?.scrollTop || 0,
      reading_direction: readingDirection,
    });
  }, [book.id, viewMode, readingDirection, onUpdateProgress]);

  // Handle page flips
  const handleNext = useCallback(() => {
    const step = viewMode === 'double-page' ? 2 : 1;
    if (currentPage + step <= imageKeys.length) {
      const nextPage = currentPage + step;
      setCurrentPage(nextPage);
      syncProgress(nextPage);
    }
  }, [currentPage, imageKeys.length, viewMode, syncProgress]);

  const handlePrev = useCallback(() => {
    const step = viewMode === 'double-page' ? 2 : 1;
    if (currentPage - step >= 1) {
      const prevPage = currentPage - step;
      setCurrentPage(prevPage);
      syncProgress(prevPage);
    }
  }, [currentPage, viewMode, syncProgress]);

  // Keyboard Shortcuts (Arrow keys mapped to RTL/LTR)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        if (readingDirection === 'rtl') {
          handlePrev();
        } else {
          handleNext();
        }
      } else if (e.key === 'ArrowLeft') {
        if (readingDirection === 'rtl') {
          handleNext();
        } else {
          handlePrev();
        }
      } else if (e.key === 'Space') {
        e.preventDefault();
        handleNext();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleNext, handlePrev, readingDirection]);

  // Render Page Content based on View Mode
  const renderPagesContent = () => {
    if (loading || imageKeys.length === 0) return null;

    const filterStyle = {
      filter: `brightness(${brightness}%) contrast(${contrast}%)`,
      maxWidth: '100%',
      maxHeight: '100%',
      objectFit: 'contain' as const,
    };

    if (viewMode === 'webtoon') {
      // Continuous scroll Webtoon mode
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '100%', maxWidth: '800px', margin: '0 auto' }}>
          {imageKeys.map((_, index) => {
            const url = cachedUrls[index];
            // Only render loaded or nearby pages to prevent lag (lazy render)
            if (Math.abs(index - (currentPage - 1)) > 8 && !url) {
              return <div key={index} style={{ height: '500px', backgroundColor: '#09090c', borderBottom: '1px solid var(--border-glass)' }} />;
            }
            
            // Trigger load if not loaded
            if (!url) getPageUrl(index);

            return (
              <img 
                key={index} 
                src={url || ''} 
                alt={`Manga Page ${index + 1}`} 
                style={{ width: '100%', height: 'auto', display: 'block', ...filterStyle }}
                onLoad={() => {
                  // If page scrolls into active view, update current page
                  if (Math.abs(index - (currentPage - 1)) <= 1) {
                    // Update header in background
                  }
                }}
              />
            );
          })}
        </div>
      );
    }

    if (viewMode === 'double-page') {
      // Side-by-Side double-page spread
      const rightPageIndex = currentPage - 1;
      const leftPageIndex = currentPage;
      
      const rightUrl = cachedUrls[rightPageIndex];
      const leftUrl = cachedUrls[leftPageIndex];

      // Request load if missing
      if (rightPageIndex < imageKeys.length && !rightUrl) getPageUrl(rightPageIndex);
      if (leftPageIndex < imageKeys.length && !leftUrl) getPageUrl(leftPageIndex);

      const pageA = rightUrl ? <img src={rightUrl} alt="Page A" style={filterStyle} /> : <div style={{ flex: 1 }} />;
      const pageB = leftUrl && leftPageIndex < imageKeys.length ? <img src={leftUrl} alt="Page B" style={filterStyle} /> : <div style={{ flex: 1 }} />;

      return (
        <div style={{ display: 'flex', width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center', gap: '16px' }}>
          {readingDirection === 'rtl' ? (
            <>
              <div style={{ flex: 1, height: '100%', display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>{pageB}</div>
              <div style={{ flex: 1, height: '100%', display: 'flex', justifyContent: 'flex-start', alignItems: 'center' }}>{pageA}</div>
            </>
          ) : (
            <>
              <div style={{ flex: 1, height: '100%', display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>{pageA}</div>
              <div style={{ flex: 1, height: '100%', display: 'flex', justifyContent: 'flex-start', alignItems: 'center' }}>{pageB}</div>
            </>
          )}
        </div>
      );
    }

    // Default Single Page mode
    const activeUrl = cachedUrls[currentPage - 1];
    if (!activeUrl) getPageUrl(currentPage - 1);

    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        {activeUrl ? (
          <img src={activeUrl} alt={`Manga Page ${currentPage}`} style={filterStyle} />
        ) : (
          <div style={{ width: '40px', height: '40px', borderRadius: '50%', border: '3px solid var(--border-glass)', borderTopColor: 'var(--accent-primary)', animation: 'spin 1s linear infinite' }} />
        )}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: 'calc(100vh - 120px)', position: 'relative' }}>
      
      {/* Top Header Controls */}
      <div className="glass-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 24px', marginBottom: '16px', borderRadius: '12px', zIndex: 5 }}>
        <button onClick={onBack} style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)' }} className="hover-white">
          <ArrowLeft size={18} /> Back
        </button>
        <span style={{ fontSize: '0.95rem', fontWeight: 500, color: '#fff', flex: 1, minWidth: 0, maxWidth: '40%', textAlign: 'center', margin: '0 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {book.title}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          <span>Page</span>
          <input 
            type="number" 
            value={currentPage}
            onChange={(e) => {
              const val = parseInt(e.target.value);
              if (val >= 1 && val <= imageKeys.length) {
                setCurrentPage(val);
                syncProgress(val);
              }
            }}
            style={{ width: '60px', padding: '4px', borderRadius: '4px', border: '1px solid var(--border-glass)', backgroundColor: 'rgba(255,255,255,0.03)', color: '#fff', textAlign: 'center' }}
          />
          <span>of {imageKeys.length}</span>
        </div>
      </div>

      {/* Main Manga Panel */}
      <div 
        ref={containerRef}
        style={{
          flex: 1,
          overflow: 'auto',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          padding: viewMode === 'webtoon' ? '0' : '20px',
          backgroundColor: '#050507',
          borderRadius: '16px',
          border: '1px solid var(--border-glass)',
          position: 'relative',
        }}
      >
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
            <div style={{ width: '40px', height: '40px', borderRadius: '50%', border: '3px solid var(--border-glass)', borderTopColor: 'var(--accent-primary)', animation: 'spin 1s linear infinite' }} />
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{loadingText}</p>
          </div>
        ) : (
          renderPagesContent()
        )}
      </div>

      {/* Floating Bottom Layout Controls */}
      {!loading && viewMode !== 'webtoon' && (
        <div 
          className="glass-panel" 
          style={{ 
            position: 'absolute', 
            bottom: '24px', 
            left: '50%', 
            transform: 'translateX(-50%)', 
            display: 'flex', 
            alignItems: 'center', 
            gap: '20px', 
            padding: '12px 24px', 
            borderRadius: '50px',
            boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            zIndex: 10,
          }}
        >
          {/* Navigation */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <button 
              onClick={readingDirection === 'rtl' ? handleNext : handlePrev}
              disabled={readingDirection === 'rtl' ? currentPage >= imageKeys.length : currentPage <= 1}
              style={{ color: '#fff', padding: '6px', borderRadius: '50%', backgroundColor: 'rgba(255,255,255,0.03)' }}
              title="Previous Page (Key: Left/Right Arrow)"
            >
              <ChevronLeft size={20} />
            </button>
            <button 
              onClick={readingDirection === 'rtl' ? handlePrev : handleNext}
              disabled={readingDirection === 'rtl' ? currentPage <= 1 : currentPage >= imageKeys.length}
              style={{ color: '#fff', padding: '6px', borderRadius: '50%', backgroundColor: 'rgba(255,255,255,0.03)' }}
              title="Next Page (Key: Right/Left Arrow / Space)"
            >
              <ChevronRight size={20} />
            </button>
          </div>

          <div style={{ width: '1px', height: '20px', backgroundColor: 'var(--border-glass)' }} />

          {/* Reading Direction */}
          <button 
            onClick={() => {
              const dir = readingDirection === 'rtl' ? 'ltr' : 'rtl';
              setReadingDirection(dir);
              onUpdateProgress(book.id, {
                current_page: currentPage,
                zoom: 1.0,
                view_mode: viewMode,
                scroll_position: 0,
                reading_direction: dir,
              });
            }}
            style={{ 
              color: 'var(--text-secondary)',
              display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', fontWeight: 500
            }}
            title="Toggle LTR / RTL Mode"
          >
            <Undo size={14} style={{ transform: readingDirection === 'rtl' ? 'scaleX(-1)' : 'none' }} />
            <span>{readingDirection === 'rtl' ? 'RTL' : 'LTR'}</span>
          </button>

          <div style={{ width: '1px', height: '20px', backgroundColor: 'var(--border-glass)' }} />

          {/* View Modes */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button 
              onClick={() => { setViewMode('single-page'); syncProgress(currentPage); }}
              style={{ 
                color: viewMode === 'single-page' ? 'var(--accent-secondary)' : 'var(--text-secondary)',
                display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', fontWeight: 500
              }}
            >
              <Layout size={16} /> <span className="desktop-only">Single</span>
            </button>
            <button 
              onClick={() => { setViewMode('double-page'); syncProgress(currentPage); }}
              style={{ 
                color: viewMode === 'double-page' ? 'var(--accent-secondary)' : 'var(--text-secondary)',
                display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', fontWeight: 500
              }}
            >
              <Layout size={16} style={{ transform: 'rotate(90deg)' }} /> <span className="desktop-only">Double</span>
            </button>
            <button 
              onClick={() => { setViewMode('webtoon'); syncProgress(currentPage); }}
              style={{ 
                color: viewMode === 'webtoon' ? 'var(--accent-secondary)' : 'var(--text-secondary)',
                display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', fontWeight: 500
              }}
            >
              <AlignJustify size={16} /> <span className="desktop-only">Webtoon</span>
            </button>
          </div>

          <div style={{ width: '1px', height: '20px', backgroundColor: 'var(--border-glass)' }} />

          {/* Image tuning */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }} title="Adjust Brightness">
              <Sun size={14} style={{ color: 'var(--text-muted)' }} />
              <input 
                type="range" 
                min="60" 
                max="140" 
                value={brightness}
                onChange={(e) => setBrightness(parseInt(e.target.value))}
                style={{ width: '60px', accentColor: 'var(--accent-primary)' }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }} title="Adjust Contrast">
              <Eye size={14} style={{ color: 'var(--text-muted)' }} />
              <input 
                type="range" 
                min="60" 
                max="140" 
                value={contrast}
                onChange={(e) => setContrast(parseInt(e.target.value))}
                style={{ width: '60px', accentColor: 'var(--accent-secondary)' }}
              />
            </div>
          </div>

        </div>
      )}

      {/* Floating webtoon exit triggers */}
      {viewMode === 'webtoon' && (
        <button 
          onClick={() => setViewMode('single-page')}
          className="glass-panel"
          style={{ 
            position: 'absolute', 
            bottom: '24px', 
            right: '24px', 
            padding: '10px 16px', 
            borderRadius: '50px',
            fontSize: '0.8rem',
            fontWeight: 600,
            color: 'var(--accent-secondary)',
            border: '1px solid var(--border-glass)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            zIndex: 10
          }}
        >
          Exit Webtoon
        </button>
      )}

      <style>{`
        .hover-white:hover { color: #fff !important; }
      `}</style>
    </div>
  );
}

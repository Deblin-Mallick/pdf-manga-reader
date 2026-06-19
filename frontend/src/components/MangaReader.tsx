import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Layout, AlignJustify, Eye, Sun, Undo } from 'lucide-react';
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
  const localKey = `reader_prefs_${book.id}`;
  const savedPrefs = (() => { try { return JSON.parse(localStorage.getItem(localKey) || '{}'); } catch { return {}; } })();

  const [pages, setPages] = useState<string[]>([]);
  const [mediaToken, setMediaToken] = useState<string | null>(null);
  
  const [currentPage, setCurrentPage] = useState(book.current_page || 1);
  const [viewMode, setViewMode] = useState<string>(book.view_mode || 'single-page'); // single-page, double-page, webtoon
  const [readingDirection, setReadingDirection] = useState<'ltr' | 'rtl'>(book.reading_direction || 'rtl');
  const [brightness, setBrightness] = useState<number>(savedPrefs.brightness ?? 100);
  const [contrast, setContrast] = useState<number>(savedPrefs.contrast ?? 100);

  // Persist ephemeral prefs to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem(localKey, JSON.stringify({ brightness, contrast }));
  }, [brightness, contrast, localKey]);
  
  const [loading, setLoading] = useState(true);
  const [loadingText, setLoadingText] = useState('Initializing reader...');
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch short-lived media token
  const fetchMediaToken = useCallback(async () => {
    try {
      const headers: HeadersInit = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const res = await fetch(`/api/books/${book.id}/media-token`, {
        method: 'POST',
        headers,
      });
      if (!res.ok) throw new Error('Failed to fetch media token');
      const data = await res.json();
      setMediaToken(data.token);
      return data.token;
    } catch (err) {
      console.error('Error fetching media token:', err);
      return null;
    }
  }, [book.id, token]);

  // Load manga manifest and media token on mount
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);

  useEffect(() => {
    let isMounted = true;
    
    const loadMangaData = async () => {
      try {
        const headers: HeadersInit = {};
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        
        // 1. Fetch media token first (needed to render pages)
        setLoadingText('Requesting media access...');
        const mToken = await fetchMediaToken();
        if (!mToken) {
          throw new Error('Could not obtain media access token');
        }
        
        // 2. Fetch page manifest
        setLoadingText('Fetching page entries...');
        const res = await fetch(`/api/books/${book.id}/manga/pages`, { headers });
        if (!res.ok) {
          throw new Error('Failed to fetch page manifest');
        }
        const data = await res.json();
        
        if (isMounted) {
          setPages(data.pages || []);
          setLoading(false);
        }
      } catch (err) {
        console.error('Error initializing manga reader:', err);
        alert(err instanceof Error ? err.message : 'Failed to initialize manga reader.');
        onBackRef.current();
      }
    };
    
    loadMangaData();
    
    // Refresh token every 4 minutes (240000ms)
    const interval = setInterval(async () => {
      if (isMounted) {
        await fetchMediaToken();
      }
    }, 240000);
    
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [book.id, token, fetchMediaToken]);

  // Get Page URL pointing to streaming media endpoint
  const getPageUrl = useCallback((index: number): string => {
    if (index < 0 || index >= pages.length || !mediaToken) return '';
    return `/api/books/${book.id}/manga/pages/${index}/image?token=${encodeURIComponent(mediaToken)}`;
  }, [book.id, pages.length, mediaToken]);

  // Keep ref for scroll debouncing to avoid API locking on SQLite/NFS
  const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Sync Progress to Backend immediately (used for manual page turns)
  const syncProgress = useCallback((page: number, scrollPos: number = 0) => {
    if (syncTimeoutRef.current) {
      clearTimeout(syncTimeoutRef.current);
    }
    onUpdateProgress(book.id, {
      current_page: page,
      zoom: 1.0,
      view_mode: viewMode,
      scroll_position: scrollPos,
      reading_direction: readingDirection,
    });
  }, [book.id, viewMode, readingDirection, onUpdateProgress]);

  // Debounced Sync Progress for Webtoon scrolling
  const debouncedSyncProgress = useCallback((page: number, scrollPos: number) => {
    pendingProgressRef.current = { page, scroll: scrollPos };
    if (syncTimeoutRef.current) {
      clearTimeout(syncTimeoutRef.current);
    }
    syncTimeoutRef.current = setTimeout(() => {
      pendingProgressRef.current = null;
      onUpdateProgress(book.id, {
        current_page: page,
        zoom: 1.0,
        view_mode: viewMode,
        scroll_position: scrollPos,
        reading_direction: readingDirection,
      });
    }, 1000); // 1-second debounce to protect SQLite database from locking
  }, [book.id, viewMode, readingDirection, onUpdateProgress]);

  // Cleanup timers on unmount + flush any pending progress before page unloads
  const pendingProgressRef = useRef<{ page: number; scroll: number } | null>(null);

  useEffect(() => {
    const handleUnload = () => {
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
      const p = pendingProgressRef.current;
      if (p) {
        const payload = JSON.stringify({
          current_page: p.page, zoom: 1.0, view_mode: viewMode,
          scroll_position: p.scroll, reading_direction: readingDirection,
        });
        navigator.sendBeacon(
          `/api/books/${book.id}/progress`,
          new Blob([payload], { type: 'application/json' })
        );
      }
    };
    window.addEventListener('beforeunload', handleUnload);
    return () => {
      window.removeEventListener('beforeunload', handleUnload);
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
    };
  }, [book.id, viewMode, readingDirection]);

  // Webtoon Scroll handler: calculates active page based on viewport offset
  useEffect(() => {
    const container = containerRef.current;
    if (!container || viewMode !== 'webtoon') return;

    const handleScroll = () => {
      const images = container.querySelectorAll('img');
      let activePage = 1;
      let minDistance = Infinity;

      images.forEach((img, idx) => {
        const rect = img.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        
        // Calculate which page top is closest to the top of scroll container
        const distance = Math.abs(rect.top - containerRect.top);
        if (distance < minDistance) {
          minDistance = distance;
          activePage = idx + 1;
        }
      });

      if (activePage !== currentPage) {
        setCurrentPage(activePage);
        debouncedSyncProgress(activePage, container.scrollTop);
      }
    };

    // Restore scroll position on initial load of Webtoon mode
    if (book.scroll_position && book.scroll_position > 0) {
      container.scrollTop = book.scroll_position;
    }

    container.addEventListener('scroll', handleScroll);
    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [viewMode, currentPage, debouncedSyncProgress, book.scroll_position]);

  // Handle page flips
  const handleNext = useCallback(() => {
    const step = viewMode === 'double-page' ? 2 : 1;
    if (currentPage + step <= pages.length) {
      const nextPage = currentPage + step;
      setCurrentPage(nextPage);
      syncProgress(nextPage);
    }
  }, [currentPage, pages.length, viewMode, syncProgress]);

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
    if (loading || pages.length === 0) return null;

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
          {pages.map((_, index) => {
            const url = getPageUrl(index);
            // Only render loaded or nearby pages to prevent lag (lazy render)
            if (Math.abs(index - (currentPage - 1)) > 8) {
              return <div key={index} style={{ height: '500px', backgroundColor: '#09090c', borderBottom: '1px solid var(--border-glass)' }} />;
            }
            
            return (
              <img 
                key={index} 
                src={url} 
                alt={`Manga Page ${index + 1}`} 
                style={{ width: '100%', height: 'auto', display: 'block', ...filterStyle }}
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
      
      const rightUrl = getPageUrl(rightPageIndex);
      const leftUrl = getPageUrl(leftPageIndex);

      const pageA = rightUrl ? <img src={rightUrl} alt="Page A" style={filterStyle} /> : <div style={{ flex: 1 }} />;
      const pageB = leftUrl && leftPageIndex < pages.length ? <img src={leftUrl} alt="Page B" style={filterStyle} /> : <div style={{ flex: 1 }} />;

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
    const activeUrl = getPageUrl(currentPage - 1);

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
      
      {/* Hidden prefetch elements for next page to make single/double page turns instant */}
      {!loading && viewMode !== 'webtoon' && currentPage < pages.length && (
        <img src={getPageUrl(currentPage)} style={{ display: 'none' }} alt="" />
      )}
      {!loading && viewMode === 'double-page' && currentPage + 1 < pages.length && (
        <img src={getPageUrl(currentPage + 1)} style={{ display: 'none' }} alt="" />
      )}

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
              if (val >= 1 && val <= pages.length) {
                setCurrentPage(val);
                syncProgress(val);
              }
            }}
            style={{ width: '60px', padding: '4px', borderRadius: '4px', border: '1px solid var(--border-glass)', backgroundColor: 'rgba(255,255,255,0.03)', color: '#fff', textAlign: 'center' }}
          />
          <span>of {pages.length}</span>
        </div>
      </div>

      {/* Main Manga Panel */}
      <div 
        ref={containerRef}
        style={{
          flex: 1,
          overflow: 'auto',
          display: viewMode === 'webtoon' ? 'block' : 'flex',
          justifyContent: viewMode === 'webtoon' ? 'flex-start' : 'center',
          alignItems: viewMode === 'webtoon' ? 'stretch' : 'center',
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
              disabled={readingDirection === 'rtl' ? currentPage >= pages.length : currentPage <= 1}
              style={{ color: '#fff', padding: '6px', borderRadius: '50%', backgroundColor: 'rgba(255,255,255,0.03)' }}
              title="Previous Page (Key: Left/Right Arrow)"
            >
              <ChevronLeft size={20} />
            </button>
            <button 
              onClick={readingDirection === 'rtl' ? handlePrev : handleNext}
              disabled={readingDirection === 'rtl' ? currentPage <= 1 : currentPage >= pages.length}
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

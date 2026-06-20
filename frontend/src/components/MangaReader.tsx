import { useState, useEffect, useRef, useCallback } from 'react';
import JSZip from 'jszip';
import { Book } from '../App';
import { Avatar, Badge, Button, IconButton, Select, Tabs, ToggleGroup } from '../ui';
import * as SubframeCore from "@subframe/core";
import {
  FeatherArrowLeft,
  FeatherChevronLeft,
  FeatherChevronRight,
  FeatherLayout,
  FeatherList,
  FeatherMinus,
  FeatherPlus,
  FeatherSettings,
  FeatherSun,
  FeatherEye,
  FeatherUndo,
} from "@subframe/core";

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

interface ThemeStyle {
  bg: string;
  cardBg: string;
  text: string;
  heading: string;
  hr: string;
  sidebarBg: string;
  sidebarText: string;
  border: string;
  activeBg: string;
}

const themeStyles: Record<'light' | 'dark' | 'sepia', ThemeStyle> = {
  light: {
    bg: '#F8F6F1',
    cardBg: '#ffffff',
    text: '#1f2937',
    heading: '#0f172a',
    hr: 'rgba(0,0,0,0.08)',
    sidebarBg: 'rgba(255, 255, 255, 0.9)',
    sidebarText: '#374151',
    border: 'rgba(0,0,0,0.06)',
    activeBg: 'rgba(0, 0, 0, 0.05)',
  },
  dark: {
    bg: '#09090e',
    cardBg: '#12121a',
    text: '#cbd5e1',
    heading: '#f8fafc',
    hr: 'rgba(255,255,255,0.06)',
    sidebarBg: 'rgba(18, 18, 26, 0.95)',
    sidebarText: '#94a3b8',
    border: 'rgba(255,255,255,0.06)',
    activeBg: 'rgba(255, 255, 255, 0.05)',
  },
  sepia: {
    bg: '#F4ECD8',
    cardBg: '#FDF6E3',
    text: '#5C4636',
    heading: '#433422',
    hr: 'rgba(92,70,54,0.12)',
    sidebarBg: 'rgba(244, 236, 216, 0.95)',
    sidebarText: '#5C4636',
    border: 'rgba(92,70,54,0.08)',
    activeBg: 'rgba(92, 70, 54, 0.06)',
  }
};

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
  const [viewMode, setViewMode] = useState<'single-page' | 'double-page' | 'webtoon'>(
    (book.view_mode as any) || 'single-page'
  );
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
              return <div key={index} style={{ height: '500px', backgroundColor: '#09090c' }} />;
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
          <div className="h-10 w-10 animate-spin rounded-full border-3 border-solid border-brand-200 border-t-brand-600" />
        )}
      </div>
    );
  };

  const activeTheme = themeStyles.dark;
  const percentComplete = Math.round(((currentPage) / (pages.length || 1)) * 100);

  return (
    <div 
      className="flex h-full w-full items-start"
      style={{
        backgroundColor: activeTheme.bg,
        backgroundImage: activeTheme.bg === '#09090e'
          ? 'radial-gradient(at 0% 0%, rgba(139, 92, 246, 0.1) 0px, transparent 60%), radial-gradient(at 100% 100%, rgba(6, 182, 212, 0.08) 0px, transparent 60%)'
          : 'none',
        backgroundAttachment: 'fixed',
        color: activeTheme.text,
        transition: 'all 0.3s ease'
      }}
    >
      {/* Hidden prefetch elements for next page to make page turns instant */}
      {!loading && viewMode !== 'webtoon' && currentPage < pages.length && (
        <img src={getPageUrl(currentPage)} style={{ display: 'none' }} alt="" />
      )}
      {!loading && viewMode === 'double-page' && currentPage + 1 < pages.length && (
        <img src={getPageUrl(currentPage + 1)} style={{ display: 'none' }} alt="" />
      )}

      {/* MAIN READING WORKSPACE */}
      <div className="flex grow shrink-0 basis-0 flex-col items-center self-stretch overflow-hidden h-full">
        {/* HEADER BAR */}
        <div
          className="flex w-full items-center gap-3 border-b px-4 py-2.5"
          style={{
            borderColor: activeTheme.border,
            backgroundColor: activeTheme.bg === '#09090e' ? 'rgba(9,9,14,0.85)' : activeTheme.cardBg,
            backdropFilter: 'blur(16px)',
          }}
        >
          <button
            type="button"
            onClick={onBack}
            className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm font-medium transition-all duration-200"
            style={{ color: '#94a3b8', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
          >
            <FeatherArrowLeft className="text-base" />
            <span className="mobile:hidden">Back</span>
          </button>
          <div className="flex h-5 w-px flex-none" style={{ backgroundColor: activeTheme.border }} />
          <div className="flex min-w-0 grow flex-col">
            <span className="line-clamp-1 w-full font-semibold" style={{ color: activeTheme.heading, fontSize: '0.9rem' }}>
              {book.title}
            </span>
            <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>
              Manga · {pages.length} pages
            </span>
          </div>

          <div className="flex items-center gap-1">
            {/* Tuning Settings Dropdown */}
            <SubframeCore.DropdownMenu.Root>
              <SubframeCore.DropdownMenu.Trigger asChild>
                <Button
                  variant="neutral-secondary"
                  icon={<FeatherSettings />}
                >
                  Options
                </Button>
              </SubframeCore.DropdownMenu.Trigger>
              <SubframeCore.DropdownMenu.Portal>
                <SubframeCore.DropdownMenu.Content
                  side="bottom"
                  align="end"
                  sideOffset={6}
                  asChild
                >
                  <div 
                    className="flex w-80 flex-none flex-col items-start gap-4 rounded-xl border border-solid px-4 py-4 shadow-lg"
                    style={{
                      backgroundColor: '#1e293b',
                      borderColor: '#334155',
                      color: '#f8fafc',
                    }}
                  >
                    {/* VIEW MODE */}
                    <div className="flex w-full flex-col items-start gap-1.5">
                      <span className="text-caption-bold font-caption-bold text-subtext-color" style={{ color: '#94a3b8' }}>
                        VIEW MODE
                      </span>
                      <ToggleGroup
                        className="h-auto w-full flex-none"
                        value={viewMode}
                        onValueChange={(value: string) => {
                          if (value) {
                            setViewMode(value as any);
                            syncProgress(currentPage);
                          }
                        }}
                      >
                        <ToggleGroup.Item value="single-page">Single</ToggleGroup.Item>
                        <ToggleGroup.Item value="double-page">Double</ToggleGroup.Item>
                        <ToggleGroup.Item value="webtoon">Webtoon</ToggleGroup.Item>
                      </ToggleGroup>
                    </div>

                    {/* READING DIRECTION */}
                    {viewMode !== 'webtoon' && (
                      <div className="flex w-full flex-col items-start gap-1.5">
                        <span className="text-caption-bold font-caption-bold text-subtext-color" style={{ color: '#94a3b8' }}>
                          READING DIRECTION
                        </span>
                        <ToggleGroup
                          className="h-auto w-full flex-none"
                          value={readingDirection}
                          onValueChange={(value: string) => {
                            if (value) {
                              setReadingDirection(value as any);
                            }
                          }}
                        >
                          <ToggleGroup.Item value="rtl">RTL</ToggleGroup.Item>
                          <ToggleGroup.Item value="ltr">LTR</ToggleGroup.Item>
                        </ToggleGroup>
                      </div>
                    )}

                    <div className="flex h-px w-full flex-none items-start bg-neutral-200" style={{ backgroundColor: '#334155' }} />

                    {/* BRIGHTNESS */}
                    <div className="flex w-full flex-col items-start gap-1.5">
                      <span className="text-caption-bold font-caption-bold text-subtext-color" style={{ color: '#94a3b8' }}>
                        BRIGHTNESS
                      </span>
                      <div className="flex w-full items-center justify-between rounded-md px-2 py-1.5"
                           style={{ backgroundColor: '#0f172a' }}>
                        <IconButton
                          variant="neutral-tertiary"
                          size="small"
                          icon={<FeatherMinus />}
                          onClick={() => setBrightness(b => Math.max(60, b - 5))}
                        />
                        <span className="text-body-bold font-body-bold text-default-font" style={{ color: '#f8fafc' }}>
                          {brightness}%
                        </span>
                        <IconButton
                          variant="neutral-tertiary"
                          size="small"
                          icon={<FeatherPlus />}
                          onClick={() => setBrightness(b => Math.min(140, b + 5))}
                        />
                      </div>
                    </div>

                    {/* CONTRAST */}
                    <div className="flex w-full flex-col items-start gap-1.5">
                      <span className="text-caption-bold font-caption-bold text-subtext-color" style={{ color: '#94a3b8' }}>
                        CONTRAST
                      </span>
                      <div className="flex w-full items-center justify-between rounded-md px-2 py-1.5"
                           style={{ backgroundColor: '#0f172a' }}>
                        <IconButton
                          variant="neutral-tertiary"
                          size="small"
                          icon={<FeatherMinus />}
                          onClick={() => setContrast(c => Math.max(60, c - 5))}
                        />
                        <span className="text-body-bold font-body-bold text-default-font" style={{ color: '#f8fafc' }}>
                          {contrast}%
                        </span>
                        <IconButton
                          variant="neutral-tertiary"
                          size="small"
                          icon={<FeatherPlus />}
                          onClick={() => setContrast(c => Math.min(140, c + 5))}
                        />
                      </div>
                    </div>
                  </div>
                </SubframeCore.DropdownMenu.Content>
              </SubframeCore.DropdownMenu.Portal>
            </SubframeCore.DropdownMenu.Root>
          </div>
        </div>

        {/* READING SURFACE AREA */}
        <div className="flex w-full grow shrink-0 basis-0 flex-col items-center px-6 py-4 overflow-hidden mobile:px-4">
          <div 
            ref={containerRef}
            className="flex w-full grow flex-col items-center justify-center rounded-xl border border-solid shadow-md"
            style={{
              borderColor: activeTheme.border,
              backgroundColor: '#050507',
              width: '100%',
              maxWidth: '96%',
              height: '100%',
              overflow: viewMode === 'webtoon' ? 'auto' : 'hidden',
              display: viewMode === 'webtoon' ? 'block' : 'flex',
              justifyContent: viewMode === 'webtoon' ? 'flex-start' : 'center',
              alignItems: viewMode === 'webtoon' ? 'stretch' : 'center',
              padding: viewMode === 'webtoon' ? '0' : '20px',
              transition: 'all 0.3s ease'
            }}
          >
            {loading ? (
              <div className="flex flex-col items-center gap-4">
                <div
                  className="h-10 w-10 animate-spin rounded-full border-2 border-solid"
                  style={{
                    borderColor: 'rgba(139,92,246,0.2)',
                    borderTopColor: '#8b5cf6',
                  }}
                />
                <p className="text-sm" style={{ color: '#64748b' }}>{loadingText}</p>
              </div>
            ) : (
              renderPagesContent()
            )}
          </div>
        </div>

        {/* BOTTOM NAVIGATION / PROGRESS BAR */}
        {!loading && (
          <div
            className="flex w-full flex-col items-center gap-2 border-t px-6 py-3 mobile:px-4"
            style={{
              borderColor: activeTheme.border,
              backgroundColor: activeTheme.bg === '#09090e' ? 'rgba(9,9,14,0.85)' : activeTheme.cardBg,
              backdropFilter: 'blur(16px)',
            }}
          >
            <div className="flex w-full items-center gap-4 max-w-[680px]">
              <IconButton
                variant="neutral-tertiary"
                icon={<FeatherChevronLeft />}
                disabled={readingDirection === 'rtl' ? currentPage >= pages.length : currentPage <= 1}
                onClick={readingDirection === 'rtl' ? handleNext : handlePrev}
              />
              <div className="flex grow shrink-0 basis-0 flex-col items-center gap-2">
                <div className="flex w-full items-center justify-between">
                  <span className="text-[12px] font-medium" style={{ color: '#64748b' }}>
                    Page {currentPage} of {pages.length}
                  </span>
                  <span className="text-[12px] font-bold" style={{ color: '#a78bfa' }}>
                    {percentComplete}%
                  </span>
                </div>
                <div
                  onClick={(e) => {
                    if (pages.length === 0) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const clickX = e.clientX - rect.left;
                    const percentage = clickX / rect.width;
                    const targetPage = Math.max(1, Math.min(pages.length, Math.round(percentage * pages.length)));
                    setCurrentPage(targetPage);
                    syncProgress(targetPage);
                  }}
                  className="relative flex w-full cursor-pointer items-center py-1"
                >
                  <div
                    className="h-1 w-full overflow-hidden rounded-full"
                    style={{ backgroundColor: 'rgba(255,255,255,0.06)' }}
                  >
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{
                        width: `${percentComplete}%`,
                        background: 'linear-gradient(90deg, #7c3aed, #8b5cf6, #6366f1)',
                      }}
                    />
                  </div>
                  <div
                    className="absolute h-3.5 w-3.5 flex-none rounded-full transition-all duration-300"
                    style={{
                      left: `calc(${percentComplete}% - 7px)`,
                      background: '#8b5cf6',
                      boxShadow: '0 0 8px rgba(139,92,246,0.7), 0 0 0 2px rgba(9,9,14,0.8)',
                    }}
                  />
                </div>
              </div>
              <IconButton
                variant="neutral-tertiary"
                icon={<FeatherChevronRight />}
                disabled={readingDirection === 'rtl' ? currentPage <= 1 : currentPage >= pages.length}
                onClick={readingDirection === 'rtl' ? handlePrev : handleNext}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

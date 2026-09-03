import { useState, useEffect, useRef, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { Book, User } from '../App';
import { Avatar, Badge, Button, IconButton, Tabs, ToggleGroup } from '../ui';
import * as SubframeCore from '@subframe/core';
import {
  FeatherArrowLeft,
  FeatherChevronLeft,
  FeatherChevronRight,
  FeatherLayoutGrid,
  FeatherList,
  FeatherFileText,
  FeatherBookmark,
  FeatherSearch,
  FeatherFile,
  FeatherScrollText,
  FeatherMaximize,
  FeatherMinus,
  FeatherPlus,
  FeatherPanelLeftClose,
  FeatherSun,
  FeatherBookOpen,
  FeatherSettings,
} from '@subframe/core';

interface PDFReaderProps {
  book: Book;
  user: User | null;
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

// ─── Single-page canvas renderer ───────────────────────────────────────────
function PDFPageCanvas({
  pdf,
  pageNumber,
  zoom,
  viewMode,
  isInverted,
  containerWidth,
  containerHeight,
  onVisible,
}: {
  pdf: pdfjsLib.PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  viewMode: string;
  isInverted: boolean;
  containerWidth: number;
  containerHeight: number;
  onVisible: (page: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<any>(null);

  // IntersectionObserver — report page visibility to parent
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) onVisible(pageNumber); },
      { threshold: 0.3 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [pageNumber, onVisible]);

  // Render canvas
  useEffect(() => {
    let cancelled = false;
    const render = async () => {
      if (!canvasRef.current || containerWidth === 0) return;
      try {
        if (renderTaskRef.current) {
          renderTaskRef.current.cancel();
        }
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;

        const unscaled = page.getViewport({ scale: 1.0 });
        let scale = zoom;
        if (viewMode === 'fit-width') {
          scale = (containerWidth / unscaled.width) * zoom;
        } else if (viewMode === 'fit-height') {
          scale = ((containerHeight - 40) / unscaled.height) * zoom;
        }

        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        const ctx = canvas.getContext('2d');
        if (!ctx || cancelled) return;

        const task = page.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;
        await task.promise;
        renderTaskRef.current = null;
      } catch (err: any) {
        if (err?.name === 'RenderingCancelledException') return;
        console.error(`Page ${pageNumber} render error:`, err);
      }
    };
    render();
    return () => { cancelled = true; };
  }, [pdf, pageNumber, zoom, viewMode, containerWidth, containerHeight]);

  return (
    <div
      ref={wrapRef}
      id={`pdf-page-${pageNumber}`}
      style={{ display: 'flex', justifyContent: 'center', marginBottom: '12px' }}
    >
      <canvas
        ref={canvasRef}
        style={{
          boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
          borderRadius: '4px',
          transition: 'filter 0.3s ease',
          filter: isInverted ? 'invert(0.9) hue-rotate(180deg)' : 'none',
          maxWidth: '100%',
        }}
      />
    </div>
  );
}

// ─── Thumbnail placeholder skeleton ─────────────────────────────────────────
function PDFThumbnailPlaceholder() {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 w-full h-full p-2 bg-[#0d0d12] rounded-md animate-pulse">
      <div className="w-10 h-14 bg-neutral-800/80 rounded border border-neutral-700/30 flex flex-col justify-between p-2 shadow-inner">
        <div className="w-full h-1 bg-neutral-700/60 rounded-full" />
        <div className="w-4/5 h-1 bg-neutral-700/60 rounded-full" />
        <div className="w-full h-1 bg-neutral-700/60 rounded-full" />
        <div className="w-2/3 h-1 bg-neutral-700/60 rounded-full" />
      </div>
    </div>
  );
}

// ─── Thumbnail canvas renderer ──────────────────────────────────────────────
function PDFThumbnailCanvas({
  pdf,
  pageNumber,
  isInverted,
}: {
  pdf: pdfjsLib.PDFDocumentProxy;
  pageNumber: number;
  isInverted: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  const renderTaskRef = useRef<any>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setRendered(true);
          observer.disconnect();
        }
      },
      { rootMargin: '100px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!rendered) return;
    let cancelled = false;

    const render = async () => {
      if (!canvasRef.current) return;
      try {
        if (renderTaskRef.current) {
          renderTaskRef.current.cancel();
        }
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;

        const unscaledViewport = page.getViewport({ scale: 1.0 });
        const scale = 150 / unscaledViewport.height;
        const viewport = page.getViewport({ scale });

        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        const ctx = canvas.getContext('2d');
        if (!ctx || cancelled) return;

        const task = page.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;
        await task.promise;
        renderTaskRef.current = null;
      } catch (err: any) {
        if (err?.name === 'RenderingCancelledException') return;
        console.error(`Page ${pageNumber} thumbnail render error:`, err);
      }
    };

    render();
    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
      }
    };
  }, [pdf, pageNumber, rendered]);

  return (
    <div
      ref={containerRef}
      className="flex h-full w-full items-center justify-center p-1"
    >
      {rendered ? (
        <canvas
          ref={canvasRef}
          className="shadow-sm transition-all duration-300 ease-out group-hover/thumb:scale-[1.06] group-hover/thumb:shadow-md"
          style={{
            maxHeight: '100%',
            maxWidth: '100%',
            objectFit: 'contain',
            borderRadius: '2px',
            filter: isInverted ? 'invert(0.9) hue-rotate(180deg)' : 'none',
          }}
        />
      ) : (
        <PDFThumbnailPlaceholder />
      )}
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────
export default function PDFReader({ book, user, token, onBack, onUpdateProgress }: PDFReaderProps) {
  const localKey = `reader_prefs_${book.id}`;
  const savedPrefs = (() => { try { return JSON.parse(localStorage.getItem(localKey) || '{}'); } catch { return {}; } })();

  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(book.current_page || 1);
  const [totalPages, setTotalPages] = useState(book.total_pages || 1);
  const [zoom, setZoom] = useState(book.zoom || 1.0);
  const [viewMode, setViewMode] = useState<string>(book.view_mode || 'fit-width');
  const [isInverted, setIsInverted] = useState<boolean>(savedPrefs.isInverted ?? false);
  const [loading, setLoading] = useState(true);
  const [scrollMode, setScrollMode] = useState<boolean>(savedPrefs.scrollMode ?? false);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  // Sidebar Open & Sidebar tabs states
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<'pages' | 'outline'>('pages');

  // Outline & Bookmarks states
  const [outline, setOutline] = useState<any[]>([]);
  const [bookmarks, setBookmarks] = useState<number[]>(() => {
    try {
      const raw = localStorage.getItem(`pdf_bookmarks_${book.id}`);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  // Search states
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{ page: number; snippet: string }[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // Toggle bookmark on/off
  const toggleBookmark = () => {
    let updated;
    if (bookmarks.includes(currentPage)) {
      updated = bookmarks.filter((b) => b !== currentPage);
    } else {
      updated = [...bookmarks, currentPage].sort((a, b) => a - b);
    }
    setBookmarks(updated);
    localStorage.setItem(`pdf_bookmarks_${book.id}`, JSON.stringify(updated));
  };

  // Search through all pages text content client-side
  const handleSearch = async (query: string) => {
    if (!pdf || !query.trim()) return;
    setSearchLoading(true);
    const results: { page: number; snippet: string }[] = [];
    try {
      const q = query.toLowerCase();
      for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const text = textContent.items.map((item: any) => item.str).join(' ');
        const index = text.toLowerCase().indexOf(q);
        if (index !== -1) {
          const start = Math.max(0, index - 25);
          const end = Math.min(text.length, index + q.length + 25);
          results.push({
            page: pageNum,
            snippet: `...${text.substring(start, end).replace(/\s+/g, ' ').trim()}...`,
          });
        }
        if (results.length >= 15) break; // limit results size
      }
    } catch (err) {
      console.error('PDF Search error:', err);
    }
    setSearchResults(results);
    setSearchLoading(false);
  };

  // Persist ephemeral prefs to localStorage whenever they change
  useEffect(() => {
    const prefs = { isInverted, scrollMode };
    localStorage.setItem(localKey, JSON.stringify(prefs));
  }, [isInverted, scrollMode, localKey]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRenderTaskRef = useRef<any>(null);
  // True while a programmatic scroll is in flight — suppresses IntersectionObserver feedback
  const isProgrammaticScrollRef = useRef(false);

  // Refs for pending progress flush on page unload
  const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingProgressRef = useRef<{
    page: number; zoom: number; mode: string; scroll: number;
  } | null>(null);

  // Debounced Sync Progress to prevent database contention over NFS
  const debouncedSyncProgress = useCallback((page: number, currentZoom: number, currentMode: string, scrollPos: number) => {
    pendingProgressRef.current = { page, zoom: currentZoom, mode: currentMode, scroll: scrollPos };
    if (syncTimeoutRef.current) {
      clearTimeout(syncTimeoutRef.current);
    }
    syncTimeoutRef.current = setTimeout(() => {
      pendingProgressRef.current = null;
      onUpdateProgress(book.id, {
        current_page: page,
        zoom: currentZoom,
        view_mode: currentMode,
        scroll_position: scrollPos,
        reading_direction: 'ltr',
      });
    }, 1000);
  }, [book.id, onUpdateProgress]);

  // Clean up timer on unmount + flush pending progress immediately before page unloads
  useEffect(() => {
    const handleUnload = () => {
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
      const p = pendingProgressRef.current;
      if (p) {
        const payload = JSON.stringify({
          current_page: p.page, zoom: p.zoom, view_mode: p.mode,
          scroll_position: p.scroll, reading_direction: 'ltr',
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
  }, [book.id]);

  // ── Load PDF ──────────────────────────────────────────────────────────────
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);

  useEffect(() => {
    let isMounted = true;
    const load = async () => {
      setLoading(true);
      try {
        const headers: HeadersInit = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res = await fetch(`/api/books/${book.id}/file`, { headers });
        if (!res.ok) throw new Error('Failed to load PDF');
        const buffer = await res.arrayBuffer();
        const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
        if (isMounted) {
          setPdf(doc);
          setTotalPages(doc.numPages);
          setLoading(false);
          try {
            const docOutline = await doc.getOutline();
            setOutline(docOutline || []);
          } catch (e) {
            console.error('Failed to parse outline:', e);
          }
        }
      } catch (err) {
        console.error(err);
        alert('Failed to load PDF file. Please try again.');
        onBackRef.current();
      }
    };
    load();
    return () => { isMounted = false; };
  }, [book.id, token]);

  // ── Measure container for scale calc ─────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      setContainerSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    obs.observe(el);
    setContainerSize({ width: el.clientWidth, height: el.clientHeight });
    return () => obs.disconnect();
  }, [loading]);

  // ── Single-page render (non-scroll mode) ──────────────────────────────────
  const renderPage = useCallback(async () => {
    if (scrollMode || !pdf || !canvasRef.current || !containerRef.current) return;
    try {
      if (activeRenderTaskRef.current) activeRenderTaskRef.current.cancel();
      const page = await pdf.getPage(currentPage);
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const cw = containerRef.current.clientWidth - 40;
      const ch = containerRef.current.clientHeight - 40;
      const unscaled = page.getViewport({ scale: 1.0 });
      let scale = zoom;
      if (viewMode === 'fit-width') {
        const byWidth = cw / unscaled.width;
        const byHeight = ch / unscaled.height;
        scale = Math.min(byWidth, byHeight) * zoom;
      } else if (viewMode === 'fit-height') {
        scale = (ch / unscaled.height) * zoom;
      }

      const viewport = page.getViewport({ scale });
      canvas.width = viewport.width;
      canvas.height = viewport.height;

      const task = page.render({ canvasContext: ctx, viewport });
      activeRenderTaskRef.current = task;
      await task.promise;
      activeRenderTaskRef.current = null;
    } catch (err: any) {
      if (err?.name === 'RenderingCancelledException') return;
      console.error(err);
    }
  }, [pdf, currentPage, zoom, viewMode, scrollMode]);

  useEffect(() => { renderPage(); }, [renderPage]);

  // ── Sync progress (Debounced) ─────────────────────────────────────────────
  useEffect(() => {
    if (!pdf) return;
    debouncedSyncProgress(currentPage, zoom, viewMode, containerRef.current?.scrollTop || 0);
  }, [currentPage, zoom, viewMode, pdf, debouncedSyncProgress]);

  // ── Resize handler ────────────────────────────────────────────────────────
  useEffect(() => {
    window.addEventListener('resize', renderPage);
    return () => window.removeEventListener('resize', renderPage);
  }, [renderPage]);

  // ── Jump to a specific page (scroll mode only, explicit user action) ────────
  const jumpToPage = useCallback((page: number) => {
    const clamped = Math.max(1, Math.min(totalPages, page));
    setCurrentPage(clamped);
    if (scrollMode) {
      isProgrammaticScrollRef.current = true;
      const el = document.getElementById(`pdf-page-${clamped}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setTimeout(() => { isProgrammaticScrollRef.current = false; }, 650);
      } else {
        isProgrammaticScrollRef.current = false;
      }
    }
  }, [scrollMode, totalPages]);

  // IntersectionObserver callback — only updates display counter, never scrolls
  const handleVisiblePage = useCallback((page: number) => {
    if (!isProgrammaticScrollRef.current) {
      setCurrentPage(page);
    }
  }, []);

  // ── Keyboard navigation ───────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        if (scrollMode) jumpToPage(currentPage + 1);
        else setCurrentPage((p) => Math.min(totalPages, p + 1));
      } else if (e.key === 'ArrowLeft') {
        if (scrollMode) jumpToPage(currentPage - 1);
        else setCurrentPage((p) => Math.max(1, p - 1));
      } else if (e.key === ' ') {
        e.preventDefault();
        if (containerRef.current) containerRef.current.scrollTop += 200;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [totalPages, scrollMode, currentPage, jumpToPage]);

  // ── Auto-scroll active thumbnail into view in Pages panel ───────────────────
  useEffect(() => {
    if (sidebarTab !== 'pages' || !isSidebarOpen) return;
    const thumbEl = document.getElementById(`sidebar-thumb-${currentPage}`);
    if (thumbEl) {
      thumbEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [currentPage, sidebarTab, isSidebarOpen]);

  const activeTheme = themeStyles.dark;
  const percentComplete = Math.round(((currentPage) / (totalPages || 1)) * 100);

  return (
    <div
      className="flex h-full w-full items-start"
      style={{
        backgroundColor: activeTheme.bg,
        backgroundImage: 'radial-gradient(ellipse at 0% 0%, rgba(139,92,246,0.12) 0px, transparent 55%), radial-gradient(ellipse at 100% 100%, rgba(6,182,212,0.08) 0px, transparent 55%)',
        backgroundAttachment: 'fixed',
        color: activeTheme.text,
        transition: 'all 0.3s ease',
      }}
    >
      {/* MOBILE DRAWER BACKDROP */}
      {isSidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm hidden mobile:block"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* LEFT SIDEBAR */}
      {isSidebarOpen && (
        <div
          className="flex w-64 flex-none flex-col items-start self-stretch border-r border-solid mobile:fixed mobile:inset-y-0 mobile:left-0 mobile:z-50 mobile:shadow-2xl"
          style={{
            backgroundColor: activeTheme.sidebarBg,
            borderColor: activeTheme.border,
            color: activeTheme.sidebarText,
            zIndex: 50,
          }}
        >
          <div className="flex w-full items-center gap-2 border-b border-solid px-4 py-3" style={{ borderColor: activeTheme.border }}>
            <FeatherBookOpen className="text-heading-3 font-heading-3 text-brand-600 animate-pulse" />
            <span className="grow shrink-0 basis-0 text-heading-3 font-heading-3 text-default-font" style={{ color: activeTheme.heading }}>
              SleekReader
            </span>
            <IconButton
              variant="neutral-tertiary"
              size="small"
              icon={<FeatherPanelLeftClose />}
              onClick={() => setIsSidebarOpen(false)}
            />
          </div>
          <Tabs className="px-2 pt-2">
            <Tabs.Item active={sidebarTab === 'pages'} icon={<FeatherLayoutGrid />} onClick={() => setSidebarTab('pages')}>
              Pages
            </Tabs.Item>
            <Tabs.Item active={sidebarTab === 'outline'} icon={<FeatherList />} onClick={() => setSidebarTab('outline')}>
              Outline
            </Tabs.Item>
          </Tabs>

          {/* PAGES PANEL */}
          {sidebarTab === 'pages' && (
            <div className="w-full grow shrink-0 basis-0 items-start gap-3 px-3 py-3 grid grid-cols-2 content-start overflow-auto">
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((pageNum) => {
                const isActive = pageNum === currentPage;
                return (
                  <div
                    key={pageNum}
                    id={`sidebar-thumb-${pageNum}`}
                    onClick={() => jumpToPage(pageNum)}
                    className="flex flex-col items-center gap-1 self-stretch cursor-pointer group/thumb"
                  >
                    <div
                      className={`flex h-28 w-full flex-none items-center justify-center rounded-md border border-solid transition-all bg-[#050508] relative overflow-hidden ${isActive
                        ? 'border-2 border-purple-500 shadow-md'
                        : 'border-white/10 hover:border-white/30'
                        }`}
                    >
                      {pdf ? (
                        <PDFThumbnailCanvas
                          pdf={pdf}
                          pageNumber={pageNum}
                          isInverted={isInverted}
                        />
                      ) : (
                        <FeatherFileText className={`text-heading-3 font-heading-3 ${isActive ? 'text-purple-400' : 'text-neutral-600'}`} />
                      )}
                      {isActive && (
                        <div className="flex items-start absolute top-1 right-1 z-10">
                          <Badge variant="brand" icon={null}>
                            {pageNum}
                          </Badge>
                        </div>
                      )}
                    </div>
                    <span className={`text-caption ${isActive ? 'font-caption-bold text-purple-400' : 'text-subtext-color'}`}>
                      {pageNum}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* OUTLINE PANEL */}
          {sidebarTab === 'outline' && (
            <div className="flex w-full grow shrink-0 basis-0 flex-col items-start gap-1 px-2 py-3 overflow-auto w-full">
              <span className="text-caption-bold font-caption-bold text-subtext-color px-2 py-1">
                OUTLINE
              </span>
              {outline.length === 0 ? (
                <div className="px-3 py-2 text-caption text-neutral-500 italic">No outline available</div>
              ) : (
                outline.map((item, index) => (
                  <div
                    key={index}
                    onClick={async () => {
                      if (item.dest) {
                        try {
                          const pageIndex = await pdf?.getPageIndex(item.dest);
                          if (pageIndex !== undefined && pageIndex >= 0) {
                            jumpToPage(pageIndex + 1);
                          }
                        } catch (err) {
                          console.error('Failed to resolve outline page:', err);
                        }
                      }
                    }}
                    className="flex w-full items-center gap-3 rounded-md px-3 py-2 cursor-pointer transition-all hover:bg-white/5"
                  >
                    <span className="grow shrink-0 basis-0 text-body text-neutral-300 hover:text-white truncate">
                      {item.title}
                    </span>
                  </div>
                ))
              )}

              <div className="flex h-px w-full bg-white/5 my-2" />

              <span className="text-caption-bold font-caption-bold text-subtext-color px-2 py-1">
                BOOKMARKS
              </span>
              {bookmarks.length === 0 ? (
                <div className="px-3 py-2 text-caption text-neutral-500 italic">No bookmarks saved</div>
              ) : (
                bookmarks.map((pageNum) => (
                  <div
                    key={pageNum}
                    onClick={() => jumpToPage(pageNum)}
                    className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-1 cursor-pointer transition-all hover:bg-white/5"
                  >
                    <span className="text-body text-neutral-300 hover:text-white">
                      Page {pageNum}
                    </span>
                    <IconButton
                      variant="destructive-tertiary"
                      size="small"
                      icon={<FeatherMinus />}
                      onClick={(e) => {
                        e.stopPropagation();
                        const updated = bookmarks.filter((b) => b !== pageNum);
                        setBookmarks(updated);
                        localStorage.setItem(`pdf_bookmarks_${book.id}`, JSON.stringify(updated));
                      }}
                    />
                  </div>
                ))
              )}
            </div>
          )}

          {/* USER AVATAR / PROFILE FOOTER IN SIDEBAR */}
          <div className="flex w-full items-center gap-3 border-t border-solid px-4 py-3" style={{ borderColor: activeTheme.border }}>
            <Avatar size="small" image={user?.picture || undefined}>
              {user?.name ? user.name[0].toUpperCase() : 'R'}
            </Avatar>
            <div className="flex grow shrink-0 basis-0 flex-col items-start min-w-0">
              <span className="text-caption-bold font-caption-bold text-white truncate w-full">
                {user?.name || 'Guest User'}
              </span>
              <span className="text-caption font-caption text-neutral-400 truncate w-full">
                {user?.email || 'Guest session'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* MAIN READING WORKSPACE */}
      <div className="flex grow shrink-0 basis-0 flex-col items-center self-stretch overflow-hidden h-full relative">
        {/* HEADER BAR */}
        <div
          className="flex w-full items-center gap-3 border-b px-4 py-2.5"
          style={{
            borderColor: activeTheme.border,
            backgroundColor: activeTheme.cardBg,
          }}
        >
          {!isSidebarOpen && (
            <IconButton
              variant="neutral-tertiary"
              icon={<FeatherList />}
              onClick={() => setIsSidebarOpen(true)}
            />
          )}
          <IconButton
            variant="neutral-tertiary"
            icon={<FeatherArrowLeft />}
            onClick={onBack}
          />

          <div className="flex h-6 w-px flex-none flex-col items-start bg-neutral-border mobile:hidden" style={{ backgroundColor: activeTheme.border }} />
          <div className="flex min-w-[0px] grow shrink-0 basis-0 flex-col items-start">
            <span className="line-clamp-1 w-full text-body-bold font-body-bold text-default-font" style={{ color: activeTheme.heading }}>
              {book.title}
            </span>
            <span className="line-clamp-1 w-full text-caption font-caption text-subtext-color">
              Page {currentPage} of {totalPages}
            </span>
          </div>

          <div className="flex items-center gap-1">
            {/* Search Dropdown */}
            <SubframeCore.DropdownMenu.Root>
              <SubframeCore.DropdownMenu.Trigger asChild>
                <IconButton
                  variant="neutral-tertiary"
                  icon={<FeatherSearch />}
                />
              </SubframeCore.DropdownMenu.Trigger>
              <SubframeCore.DropdownMenu.Portal>
                <SubframeCore.DropdownMenu.Content
                  side="bottom"
                  align="end"
                  sideOffset={6}
                  asChild
                >
                  <div
                    className="flex w-80 flex-none flex-col items-start gap-3 rounded-xl border border-solid p-4 shadow-lg bg-[#1e293b] border-[#334155] text-[#f8fafc]"
                  >
                    <span className="text-caption-bold font-caption-bold text-neutral-400">
                      SEARCH PDF
                    </span>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        handleSearch(searchQuery);
                      }}
                      className="flex w-full items-center gap-2"
                    >
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search text..."
                        className="grow rounded-md border border-solid px-3 py-1.5 text-body font-body focus:outline-none bg-[#0f172a] border-[#334155] text-white"
                      />
                      <Button type="submit" variant="brand-primary" icon={<FeatherSearch />} className="px-3" />
                    </form>
                    {searchLoading ? (
                      <div className="flex w-full justify-center py-4">
                        <div className="h-6 w-6 animate-spin rounded-full border-2 border-solid border-brand-200 border-t-brand-600" />
                      </div>
                    ) : (
                      <div className="flex w-full flex-col gap-2 max-h-60 overflow-auto w-full">
                        <span className="text-caption font-caption text-subtext-color">
                          {searchResults.length} matches found
                        </span>
                        {searchResults.map((res, i) => (
                          <div
                            key={i}
                            onClick={() => jumpToPage(res.page)}
                            className="flex w-full flex-col items-start gap-1 rounded-md border border-solid p-2 cursor-pointer hover:bg-white/5 transition-all bg-[#0f172a] border-[#334155] w-full"
                          >
                            <span className="text-caption-bold font-caption-bold text-purple-400">
                              Page {res.page}
                            </span>
                            <span className="text-caption font-caption text-default-font italic line-clamp-2 text-neutral-300">
                              {res.snippet}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </SubframeCore.DropdownMenu.Content>
              </SubframeCore.DropdownMenu.Portal>
            </SubframeCore.DropdownMenu.Root>

            <IconButton
              variant="neutral-tertiary"
              icon={<FeatherBookmark />}
              style={bookmarks.includes(currentPage) ? { color: '#a78bfa' } : undefined}
              onClick={toggleBookmark}
            />

            <IconButton
              variant="neutral-tertiary"
              icon={<FeatherSun className={isInverted ? 'text-purple-400' : 'text-neutral-400'} />}
              onClick={() => setIsInverted((inv) => !inv)}
              aria-label="Toggle night mode"
            />

            <div className="flex h-6 w-px flex-none flex-col items-start bg-neutral-border mx-1 max-lg:hidden" style={{ backgroundColor: activeTheme.border }} />

            {/* Scroll Mode Toggle */}
            <ToggleGroup
              className="max-lg:hidden"
              value={scrollMode ? 'scroll' : 'page'}
              onValueChange={(value: string) => {
                if (value) {
                  setScrollMode(value === 'scroll');
                }
              }}
            >
              <ToggleGroup.Item icon={<FeatherFile />} value="page" />
              <ToggleGroup.Item icon={<FeatherScrollText />} value="scroll" />
            </ToggleGroup>

            {/* Fit Mode Toggle */}
            <ToggleGroup
              className="max-lg:hidden"
              value={viewMode}
              onValueChange={(value: string) => {
                if (value) {
                  setViewMode(value);
                }
              }}
            >
              <ToggleGroup.Item value="fit-width">Fit Width</ToggleGroup.Item>
              <ToggleGroup.Item value="fit-height">Fit Height</ToggleGroup.Item>
            </ToggleGroup>

            {/* Zoom Controls */}
            <div className="flex items-center gap-1 rounded-md px-1 py-0.5 max-lg:hidden" style={{ backgroundColor: '#0f172a' }}>
              <IconButton
                variant="neutral-tertiary"
                size="small"
                icon={<FeatherMinus />}
                onClick={() => setZoom((z) => Math.max(0.5, z - 0.15))}
              />
              <span className="w-10 flex-none text-caption-bold font-caption-bold text-default-font text-center" style={{ color: '#f8fafc' }}>
                {Math.round(zoom * 100)}%
              </span>
              <IconButton
                variant="neutral-tertiary"
                size="small"
                icon={<FeatherPlus />}
                onClick={() => setZoom((z) => Math.min(2.0, z + 0.15))}
              />
            </div>

            {/* Mobile Display Settings Menu */}
            <div className="lg:hidden">
              <SubframeCore.DropdownMenu.Root>
                <SubframeCore.DropdownMenu.Trigger asChild>
                  <IconButton
                    variant="neutral-tertiary"
                    icon={<FeatherSettings />}
                    aria-label="Display Settings"
                  />
                </SubframeCore.DropdownMenu.Trigger>
                <SubframeCore.DropdownMenu.Portal>
                  <SubframeCore.DropdownMenu.Content
                    side="bottom"
                    align="end"
                    sideOffset={6}
                    asChild
                  >
                    <div
                      className="flex w-64 flex-none flex-col items-start gap-4 rounded-xl border border-solid p-4 shadow-lg bg-[#1e293b] border-[#334155] text-[#f8fafc] z-50"
                    >
                      <span className="text-caption-bold font-caption-bold text-neutral-400">
                        DISPLAY OPTIONS
                      </span>

                      {/* Scroll Mode */}
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="text-body text-neutral-300">Scroll Mode</span>
                        <ToggleGroup
                          value={scrollMode ? 'scroll' : 'page'}
                          onValueChange={(value: string) => {
                            if (value) setScrollMode(value === 'scroll');
                          }}
                        >
                          <ToggleGroup.Item icon={<FeatherFile />} value="page" />
                          <ToggleGroup.Item icon={<FeatherScrollText />} value="scroll" />
                        </ToggleGroup>
                      </div>

                      {/* Fit Mode */}
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="text-body text-neutral-300">Fit Page</span>
                        <ToggleGroup
                          value={viewMode}
                          onValueChange={(value: string) => {
                            if (value) setViewMode(value);
                          }}
                        >
                          <ToggleGroup.Item value="fit-width">Width</ToggleGroup.Item>
                          <ToggleGroup.Item value="fit-height">Height</ToggleGroup.Item>
                        </ToggleGroup>
                      </div>

                      {/* Zoom Levels */}
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="text-body text-neutral-300">Zoom</span>
                        <div className="flex items-center gap-1 rounded-md px-1 py-0.5 bg-[#0f172a]">
                          <IconButton
                            variant="neutral-tertiary"
                            size="small"
                            icon={<FeatherMinus />}
                            onClick={() => setZoom((z) => Math.max(0.5, z - 0.15))}
                          />
                          <span className="w-10 flex-none text-caption-bold font-caption-bold text-default-font text-center text-white">
                            {Math.round(zoom * 100)}%
                          </span>
                          <IconButton
                            variant="neutral-tertiary"
                            size="small"
                            icon={<FeatherPlus />}
                            onClick={() => setZoom((z) => Math.min(2.0, z + 0.15))}
                          />
                        </div>
                      </div>
                    </div>
                  </SubframeCore.DropdownMenu.Content>
                </SubframeCore.DropdownMenu.Portal>
              </SubframeCore.DropdownMenu.Root>
            </div>

            <IconButton
              variant="neutral-tertiary"
              icon={<FeatherMaximize />}
              onClick={() => {
                if (!document.fullscreenElement) {
                  document.documentElement.requestFullscreen();
                } else {
                  document.exitFullscreen();
                }
              }}
            />
          </div>
        </div>

        {/* READING SURFACE AREA */}
        <div className="flex w-full grow shrink-0 basis-0 flex-col items-center px-0.5 py-0.5 overflow-hidden mobile:px-1">
          <div
            ref={containerRef}
            className="flex w-full grow flex-col items-center justify-center border border-solid shadow-md"
            style={{
              borderColor: activeTheme.border,
              backgroundColor: '#08080aff',
              width: '100%',
              //maxWidth: '96%',
              height: '100%',
              overflow: scrollMode ? 'auto' : 'hidden',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: scrollMode ? 'flex-start' : 'center',
              padding: '20px',
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
                <p className="text-sm" style={{ color: '#64748b' }}>Loading book pages...</p>
              </div>
            ) : scrollMode ? (
              <>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((pageNum) => (
                  <PDFPageCanvas
                    key={pageNum}
                    pdf={pdf!}
                    pageNumber={pageNum}
                    zoom={zoom}
                    viewMode={viewMode}
                    isInverted={isInverted}
                    containerWidth={containerSize.width - 40}
                    containerHeight={containerSize.height}
                    onVisible={handleVisiblePage}
                  />
                ))}
              </>
            ) : (
              <canvas
                ref={canvasRef}
                style={{
                  boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
                  borderRadius: '4px',
                  transition: 'filter 0.3s ease',
                  filter: isInverted ? 'invert(0.9) hue-rotate(180deg)' : 'none',
                  maxWidth: '100%',
                }}
              />
            )}
          </div>
        </div>

        {/* BOTTOM NAVIGATION FLOATING BAR */}
        {!loading && (
          <div className="flex items-center gap-2 rounded-full border border-solid bg-[#12121a]/90 backdrop-blur-md px-3 py-2 shadow-lg absolute bottom-6 left-1/2 -translate-x-1/2 z-10"
            style={{
              borderColor: activeTheme.border,
              color: activeTheme.text,
            }}
          >
            <IconButton
              variant="neutral-tertiary"
              size="small"
              icon={<FeatherChevronLeft />}
              disabled={currentPage <= 1}
              onClick={() => jumpToPage(currentPage - 1)}
            />
            <div className="flex items-center gap-1">
              <div className="flex h-7 w-10 flex-none items-center justify-center rounded-md border border-solid border-neutral-800 bg-[#09090e]">
                <span className="text-caption-bold font-caption-bold text-white">
                  {currentPage}
                </span>
              </div>
              <span className="text-caption font-caption text-neutral-400">
                / {totalPages}
              </span>
            </div>
            <IconButton
              variant="neutral-tertiary"
              size="small"
              icon={<FeatherChevronRight />}
              disabled={currentPage >= totalPages}
              onClick={() => jumpToPage(currentPage + 1)}
            />
            <div className="flex h-6 w-px flex-none flex-col items-start bg-neutral-800 mx-1" />
            <div
              onClick={(e) => {
                if (totalPages === 0) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const clickX = e.clientX - rect.left;
                const percentage = clickX / rect.width;
                const targetPage = Math.max(1, Math.min(totalPages, Math.round(percentage * totalPages)));
                jumpToPage(targetPage);
              }}
              className="flex w-36 flex-none items-center py-1 relative cursor-pointer mobile:w-24"
            >
              <div className="flex h-1 grow shrink-0 basis-0 items-start rounded-full bg-neutral-800">
                <div className="flex items-start self-stretch rounded-full bg-[#8b5cf6]" style={{ width: `${percentComplete}%` }} />
              </div>
              <div
                className="flex h-3 w-3 flex-none items-start rounded-full bg-[#8b5cf6] shadow-md absolute ring-2 ring-brand-600 ring-offset-1"
                style={{
                  left: `calc(${percentComplete}% - 6px)`,
                  ['--tw-ring-offset-color' as any]: '#0f172a',
                }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

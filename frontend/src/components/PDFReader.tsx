import { useState, useEffect, useRef, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
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
} from "@subframe/core";

interface PDFReaderProps {
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

// ─── Main component ─────────────────────────────────────────────────────────
export default function PDFReader({ book, token, onBack, onUpdateProgress }: PDFReaderProps) {
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
    // Always store the latest values so beforeunload can flush them
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
    }, 1000); // 1-second debounce to protect SQLite database from locking over NFS
  }, [book.id, onUpdateProgress]);

  // Clean up timer on unmount + flush pending progress immediately before page unloads
  useEffect(() => {
    const handleUnload = () => {
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
      const p = pendingProgressRef.current;
      if (p) {
        // Use navigator.sendBeacon for a fire-and-forget flush on page close
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
        if (isMounted) { setPdf(doc); setTotalPages(doc.numPages); setLoading(false); }
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

      const cw = containerRef.current.clientWidth  - 40;
      const ch = containerRef.current.clientHeight - 40;
      const unscaled = page.getViewport({ scale: 1.0 });
      let scale = zoom;
      if (viewMode === 'fit-width') {
        // Fit within BOTH width and height so the full page is visible without scrolling
        const byWidth  = cw / unscaled.width;
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
        // Clear the flag after the smooth scroll settles (~600ms)
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

  const activeTheme = themeStyles.dark;
  const percentComplete = Math.round(((currentPage) / (totalPages || 1)) * 100);

  return (
    <div 
      className="flex h-full w-full items-start"
      style={{
        backgroundColor: activeTheme.bg,
        color: activeTheme.text,
        transition: 'all 0.3s ease'
      }}
    >
      {/* MAIN READING WORKSPACE */}
      <div className="flex grow shrink-0 basis-0 flex-col items-center self-stretch overflow-hidden h-full">
        {/* HEADER BAR */}
        <div className="flex w-full items-center gap-3 border-b border-solid bg-neutral-0 px-4 py-2.5"
             style={{
               borderColor: activeTheme.border,
               backgroundColor: activeTheme.cardBg
             }}
        >
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
              PDF Document
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
                    {/* SCROLL MODE */}
                    <div className="flex w-full flex-col items-start gap-1.5">
                      <span className="text-caption-bold font-caption-bold text-subtext-color" style={{ color: '#94a3b8' }}>
                        SCROLL MODE
                      </span>
                      <ToggleGroup
                        className="h-auto w-full flex-none"
                        value={scrollMode ? 'scroll' : 'page'}
                        onValueChange={(value: string) => {
                          if (value) {
                            setScrollMode(value === 'scroll');
                          }
                        }}
                      >
                        <ToggleGroup.Item value="page">Page-by-Page</ToggleGroup.Item>
                        <ToggleGroup.Item value="scroll">Infinite Scroll</ToggleGroup.Item>
                      </ToggleGroup>
                    </div>

                    {/* FIT MODE */}
                    <div className="flex w-full flex-col items-start gap-1.5">
                      <span className="text-caption-bold font-caption-bold text-subtext-color" style={{ color: '#94a3b8' }}>
                        FIT MODE
                      </span>
                      <ToggleGroup
                        className="h-auto w-full flex-none"
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
                    </div>

                    <div className="flex h-px w-full flex-none items-start bg-neutral-200" style={{ backgroundColor: '#334155' }} />

                    {/* ZOOM CONTROL */}
                    <div className="flex w-full flex-col items-start gap-1.5">
                      <span className="text-caption-bold font-caption-bold text-subtext-color" style={{ color: '#94a3b8' }}>
                        ZOOM LEVEL
                      </span>
                      <div className="flex w-full items-center justify-between rounded-md px-2 py-1.5"
                           style={{ backgroundColor: '#0f172a' }}>
                        <IconButton
                          variant="neutral-tertiary"
                          size="small"
                          icon={<FeatherMinus />}
                          onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
                        />
                        <span className="text-body-bold font-body-bold text-default-font" style={{ color: '#f8fafc' }}>
                          {Math.round(zoom * 100)}%
                        </span>
                        <IconButton
                          variant="neutral-tertiary"
                          size="small"
                          icon={<FeatherPlus />}
                          onClick={() => setZoom((z) => Math.min(3.0, z + 0.25))}
                        />
                      </div>
                    </div>

                    {/* NIGHT MODE */}
                    <div className="flex w-full items-center justify-between mt-1">
                      <span className="text-caption-bold font-caption-bold text-subtext-color" style={{ color: '#94a3b8' }}>
                        NIGHT MODE
                      </span>
                      <ToggleGroup
                        className="h-auto w-32 flex-none"
                        value={isInverted ? 'dark' : 'light'}
                        onValueChange={(value: string) => {
                          if (value) {
                            setIsInverted(value === 'dark');
                          }
                        }}
                      >
                        <ToggleGroup.Item value="light">Off</ToggleGroup.Item>
                        <ToggleGroup.Item value="dark">On</ToggleGroup.Item>
                      </ToggleGroup>
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
              backgroundColor: '#050508',
              width: '100%',
              maxWidth: '96%',
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
                <div className="h-10 w-10 animate-spin rounded-full border-3 border-solid border-brand-200 border-t-brand-600" />
                <p className="text-body font-body text-subtext-color">Loading book pages...</p>
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

        {/* BOTTOM NAVIGATION / PROGRESS BAR */}
        {!loading && (
          <div className="flex w-full flex-col items-center gap-2 border-t border-solid bg-neutral-0 px-6 py-3 mobile:px-4"
               style={{
                 borderColor: activeTheme.border,
                 backgroundColor: activeTheme.cardBg
               }}
          >
            <div className="flex w-full items-center gap-4 max-w-[680px]">
              <IconButton
                variant="neutral-tertiary"
                icon={<FeatherChevronLeft />}
                disabled={currentPage <= 1}
                onClick={() => jumpToPage(currentPage - 1)}
              />
              <div className="flex grow shrink-0 basis-0 flex-col items-center gap-2">
                <div className="flex w-full items-center justify-between">
                  <span className="line-clamp-1 text-caption-bold font-caption-bold text-default-font" style={{ color: activeTheme.heading }}>
                    Page {currentPage} of {totalPages} ({percentComplete}%)
                  </span>
                </div>
                <div 
                  onClick={(e) => {
                    if (totalPages === 0) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const clickX = e.clientX - rect.left;
                    const percentage = clickX / rect.width;
                    const targetPage = Math.max(1, Math.min(totalPages, Math.round(percentage * totalPages)));
                    jumpToPage(targetPage);
                  }}
                  className="flex w-full items-center py-1 relative cursor-pointer"
                >
                  <div className="flex h-0.5 grow shrink-0 basis-0 items-start rounded-full bg-neutral-200" style={{ backgroundColor: activeTheme.border }}>
                    <div 
                      className="flex items-start self-stretch rounded-full bg-brand-600" 
                      style={{ width: `${percentComplete}%` }}
                    />
                  </div>
                  <div 
                    className="flex h-3 w-3 flex-none items-start rounded-full bg-brand-600 shadow-md absolute ring-2 ring-brand-600 ring-offset-1"
                    style={{ 
                      left: `calc(${percentComplete}% - 6px)`,
                      ['--tw-ring-offset-color' as any]: activeTheme.cardBg
                    }}
                  />
                </div>
              </div>
              <IconButton
                variant="neutral-tertiary"
                icon={<FeatherChevronRight />}
                disabled={currentPage >= totalPages}
                onClick={() => jumpToPage(currentPage + 1)}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

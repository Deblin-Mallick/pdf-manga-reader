import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import 'pdfjs-dist/web/pdf_viewer.css';
import { pdfScheduler } from '../lib/pdfScheduler';
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

// Hardware texture limit protection (typically 4096px on mobile GPUs)
const MAX_CANVAS_DIMENSION = 4096;

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
  },
};

/**
 * Calculates deterministic layout width and height for a page placeholder
 * using preloaded metadata viewports, guaranteeing 0px CLS.
 */
function computePageLayout(
  pageNum: number,
  dimensionsMap: Map<number, { width: number; height: number }>,
  containerWidth: number,
  containerHeight: number,
  viewMode: string,
  zoom: number
) {
  const base = dimensionsMap.get(pageNum) || dimensionsMap.get(1) || { width: 595, height: 842 };
  let scale = zoom;
  const cw = Math.max(100, containerWidth);
  const ch = Math.max(100, containerHeight);

  if (viewMode === 'fit-width') {
    scale = (cw / base.width) * zoom;
  } else if (viewMode === 'fit-height') {
    scale = ((ch - 40) / base.height) * zoom;
  }

  const width = Math.floor(base.width * scale);
  const height = Math.floor(base.height * scale);
  return { width, height, scale, unscaledWidth: base.width, unscaledHeight: base.height };
}

// ─── Single-page canvas renderer (Scroll Mode) ──────────────────────────────
function PDFPageCanvas({
  pdf,
  pageNumber,
  zoom,
  viewMode,
  isInverted,
  containerWidth,
  containerHeight,
  dimensionsMap,
  onVisible,
  containerEl,
}: {
  pdf: pdfjsLib.PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  viewMode: string;
  isInverted: boolean;
  containerWidth: number;
  containerHeight: number;
  dimensionsMap: Map<number, { width: number; height: number }>;
  onVisible: (page: number) => void;
  containerEl: HTMLDivElement | null;
}) {
  const [isNearViewport, setIsNearViewport] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const activeRenderTaskRef = useRef<any>(null);
  const activeTextTaskRef = useRef<any>(null);

  // Layout calculation: exactly measured from dimensionsMap
  const { width, height } = useMemo(() => {
    return computePageLayout(
      pageNumber,
      dimensionsMap,
      containerWidth,
      containerHeight,
      viewMode,
      zoom
    );
  }, [pageNumber, dimensionsMap, containerWidth, containerHeight, viewMode, zoom]);

  // Spatial root margin IntersectionObserver (derives virtualization directly from geometry)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    // Resolve scroll container safely from containerEl prop or DOM ancestor
    const rootEl = containerEl || el.closest('#pdf-reader-container') || el.parentElement;
    if (!rootEl) return;

    // Spatial observer for viewport virtualization (800px buffer ahead)
    const renderObs = new IntersectionObserver(
      ([entry]) => {
        setIsNearViewport(entry.isIntersecting);
      },
      {
        root: rootEl,
        rootMargin: '800px 0px 800px 0px',
      }
    );
    renderObs.observe(el);

    // Visibility observer for active page indicator
    const visObs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          onVisible(pageNumber);
        }
      },
      {
        root: rootEl,
        threshold: 0.3,
      }
    );
    visObs.observe(el);

    return () => {
      renderObs.disconnect();
      visObs.disconnect();
    };
  }, [pageNumber, containerEl, onVisible]);

  // Canvas render lifecycle & offscreen memory release
  useEffect(() => {
    if (!isNearViewport) {
      // Offscreen teardown: cancel tasks and free GPU memory immediately
      pdfScheduler.cancel(`page-${pageNumber}`);
      if (activeRenderTaskRef.current) {
        activeRenderTaskRef.current.cancel();
        activeRenderTaskRef.current = null;
      }
      if (activeTextTaskRef.current) {
        activeTextTaskRef.current.cancel();
        activeTextTaskRef.current = null;
      }
      if (canvasRef.current) {
        canvasRef.current.width = 0;
        canvasRef.current.height = 0;
      }
      if (textLayerRef.current) {
        textLayerRef.current.replaceChildren();
      }
      return;
    }

    let cancelled = false;

    const cancelRender = pdfScheduler.schedule(
      `page-${pageNumber}`,
      1, // High priority
      async () => {
        if (!canvasRef.current || containerWidth === 0 || cancelled) return;
        try {
          if (activeRenderTaskRef.current) {
            activeRenderTaskRef.current.cancel();
          }
          if (activeTextTaskRef.current) {
            activeTextTaskRef.current.cancel();
            activeTextTaskRef.current = null;
          }

          const page = await pdf.getPage(pageNumber);
          if (cancelled) return;

          const unscaled = page.getViewport({ scale: 1.0 });
          let targetScale = zoom;
          if (viewMode === 'fit-width') {
            targetScale = (containerWidth / unscaled.width) * zoom;
          } else if (viewMode === 'fit-height') {
            targetScale = ((containerHeight - 40) / unscaled.height) * zoom;
          }

          const targetPixelWidth = unscaled.width * targetScale;
          const targetPixelHeight = unscaled.height * targetScale;

          // Safe dimension clamping against GPU texture limit (MAX_CANVAS_DIMENSION = 4096)
          let renderScale = targetScale;
          if (targetPixelWidth > MAX_CANVAS_DIMENSION || targetPixelHeight > MAX_CANVAS_DIMENSION) {
            const clampRatio = Math.min(
              MAX_CANVAS_DIMENSION / targetPixelWidth,
              MAX_CANVAS_DIMENSION / targetPixelHeight
            );
            renderScale = targetScale * clampRatio;
          }

          const viewport = page.getViewport({ scale: renderScale });
          const canvas = canvasRef.current;
          if (!canvas || cancelled) return;

          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = `${Math.floor(targetPixelWidth)}px`;
          canvas.style.height = `${Math.floor(targetPixelHeight)}px`;

          // Disable alpha channel to save compositor memory bandwidth
          const ctx = canvas.getContext('2d', { alpha: false });
          if (!ctx || cancelled) return;

          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          const task = page.render({ canvasContext: ctx, viewport });
          activeRenderTaskRef.current = task;
          await task.promise;
          activeRenderTaskRef.current = null;

          if (cancelled) return;

          // Render text layer cleanly using display viewport for 100% accurate text selection
          if (textLayerRef.current) {
            textLayerRef.current.replaceChildren();
            const textContent = await page.getTextContent();
            if (cancelled || !textLayerRef.current) return;

            const textViewport = page.getViewport({ scale: targetScale });
            textLayerRef.current.style.setProperty('--scale-factor', targetScale.toString());
            const textTask = pdfjsLib.renderTextLayer({
              textContentSource: textContent,
              container: textLayerRef.current,
              viewport: textViewport,
              textDivs: [],
            });
            activeTextTaskRef.current = textTask;
            await textTask.promise;
            activeTextTaskRef.current = null;
          }
        } catch (err: any) {
          if (err?.name !== 'RenderingCancelledException' && !cancelled) {
            console.error(`Page ${pageNumber} render error:`, err);
          }
        }
      },
      () => {
        cancelled = true;
        if (activeRenderTaskRef.current) {
          activeRenderTaskRef.current.cancel();
          activeRenderTaskRef.current = null;
        }
        if (activeTextTaskRef.current) {
          activeTextTaskRef.current.cancel();
          activeTextTaskRef.current = null;
        }
      }
    );

    return () => {
      cancelled = true;
      cancelRender();
      if (activeRenderTaskRef.current) {
        activeRenderTaskRef.current.cancel();
        activeRenderTaskRef.current = null;
      }
      if (activeTextTaskRef.current) {
        activeTextTaskRef.current.cancel();
        activeTextTaskRef.current = null;
      }
      if (canvasRef.current) {
        canvasRef.current.width = 0;
        canvasRef.current.height = 0;
      }
      if (textLayerRef.current) {
        textLayerRef.current.replaceChildren();
      }
    };
  }, [pdf, pageNumber, zoom, viewMode, containerWidth, containerHeight, isNearViewport]);

  return (
    <div
      ref={wrapRef}
      id={`pdf-page-${pageNumber}`}
      style={{
        width: `${width}px`,
        height: `${height}px`,
        minHeight: `${height}px`,
        overflow: 'hidden',
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: '12px',
        backgroundColor: '#12121a',
        borderRadius: '4px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
      }}
    >
      {isNearViewport ? (
        <div style={{ position: 'relative', width: `${width}px`, height: `${height}px` }}>
          <canvas
            ref={canvasRef}
            style={{
              width: `${width}px`,
              height: `${height}px`,
              borderRadius: '4px',
              transition: 'filter 0.3s ease',
              filter: isInverted ? 'invert(0.9) hue-rotate(180deg)' : 'none',
              display: 'block',
            }}
          />
          <div
            ref={textLayerRef}
            className="textLayer"
            style={{
              opacity: 1,
              zIndex: 10,
              mixBlendMode: isInverted ? 'difference' : 'normal',
            }}
          />
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-2 text-neutral-600 select-none">
          <div className="h-6 w-6 animate-pulse rounded bg-neutral-800" />
          <span className="text-xs font-mono">Page {pageNumber}</span>
        </div>
      )}
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

// ─── Thumbnail canvas renderer (Uses Single Shared Observer & Priority Queue) ─────────
function PDFThumbnailCanvas({
  pdf,
  pageNumber,
  isInverted,
  sharedObserver,
  listenersMap,
}: {
  pdf: pdfjsLib.PDFDocumentProxy;
  pageNumber: number;
  isInverted: boolean;
  sharedObserver: IntersectionObserver | null;
  listenersMap: Map<Element, (inView: boolean) => void>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const renderTaskRef = useRef<any>(null);

  // Attach to the single shared IntersectionObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !sharedObserver) return;

    const onIntersection = (visible: boolean) => {
      setInView(visible);
    };

    listenersMap.set(el, onIntersection);
    sharedObserver.observe(el);

    return () => {
      sharedObserver.unobserve(el);
      listenersMap.delete(el);
    };
  }, [sharedObserver, listenersMap]);

  useEffect(() => {
    if (!inView) {
      // Out of view: cancel any running task & release canvas memory
      pdfScheduler.cancel(`thumb-${pageNumber}`);
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
      if (canvasRef.current) {
        canvasRef.current.width = 0;
        canvasRef.current.height = 0;
      }
      return;
    }

    let cancelled = false;

    const cancelRender = pdfScheduler.schedule(
      `thumb-${pageNumber}`,
      0, // Low priority (max 2 concurrent thumbnails)
      async () => {
        if (!canvasRef.current || cancelled) return;
        try {
          const page = await pdf.getPage(pageNumber);
          if (cancelled) return;

          const unscaledViewport = page.getViewport({ scale: 1.0 });
          const targetH = 112; // h-28
          const scale = targetH / unscaledViewport.height;
          const viewport = page.getViewport({ scale });

          const canvas = canvasRef.current;
          if (!canvas || cancelled) return;

          canvas.width = Math.min(MAX_CANVAS_DIMENSION, Math.floor(viewport.width));
          canvas.height = Math.min(MAX_CANVAS_DIMENSION, Math.floor(viewport.height));

          const ctx = canvas.getContext('2d', { alpha: false });
          if (!ctx || cancelled) return;

          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          const task = page.render({ canvasContext: ctx, viewport });
          renderTaskRef.current = task;
          await task.promise;
          renderTaskRef.current = null;
        } catch (err: any) {
          if (err?.name !== 'RenderingCancelledException' && !cancelled) {
            console.error(`Page ${pageNumber} thumbnail render error:`, err);
          }
        }
      },
      () => {
        cancelled = true;
        if (renderTaskRef.current) {
          renderTaskRef.current.cancel();
          renderTaskRef.current = null;
        }
      }
    );

    return () => {
      cancelled = true;
      cancelRender();
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
      if (canvasRef.current) {
        canvasRef.current.width = 0;
        canvasRef.current.height = 0;
      }
    };
  }, [pdf, pageNumber, inView]);

  return (
    <div
      ref={containerRef}
      className="flex h-full w-full items-center justify-center p-1"
    >
      {inView ? (
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

  // Preloaded unscaled page dimensions: pageNumber -> { width, height }
  const pageDimensionsMapRef = useRef<Map<number, { width: number; height: number }>>(new Map());
  const [pageDimensionsMap, setPageDimensionsMap] = useState<Map<number, { width: number; height: number }>>(
    new Map()
  );

  // Sidebar Open & Sidebar tabs states
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<'pages' | 'outline'>('pages');
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  const thumbnailListenersRef = useRef<Map<Element, (inView: boolean) => void>>(new Map());
  const [sharedThumbnailObserver, setSharedThumbnailObserver] = useState<IntersectionObserver | null>(null);

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
  const searchAbortRef = useRef<AbortController | null>(null);
  const pageTextCacheRef = useRef<Map<number, string>>(new Map());

  // Setup single shared observer for sidebar thumbnails
  useEffect(() => {
    if (sidebarTab !== 'pages' || !isSidebarOpen) {
      if (sharedThumbnailObserver) {
        sharedThumbnailObserver.disconnect();
        setSharedThumbnailObserver(null);
      }
      return;
    }
    const el = sidebarScrollRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const listener = thumbnailListenersRef.current.get(entry.target);
          if (listener) {
            listener(entry.isIntersecting);
          }
        }
      },
      {
        root: el,
        rootMargin: '200px 0px',
      }
    );

    setSharedThumbnailObserver(observer);

    return () => {
      observer.disconnect();
      setSharedThumbnailObserver(null);
    };
  }, [sidebarTab, isSidebarOpen]);

  // Clean up all pending tasks in scheduler when unmounting
  useEffect(() => {
    return () => {
      pdfScheduler.clear();
    };
  }, []);

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

  // Search through all pages text content in time-sliced, cancellable chunks
  const handleSearch = async (query: string) => {
    if (!pdf || !query.trim()) return;

    if (searchAbortRef.current) {
      searchAbortRef.current.abort();
    }
    const abortController = new AbortController();
    searchAbortRef.current = abortController;

    setSearchLoading(true);
    setSearchResults([]);
    const results: { page: number; snippet: string }[] = [];

    try {
      const q = query.toLowerCase();
      for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        if (abortController.signal.aborted) return;

        let text = pageTextCacheRef.current.get(pageNum);
        if (text === undefined) {
          const page = await pdf.getPage(pageNum);
          if (abortController.signal.aborted) return;
          const textContent = await page.getTextContent();
          text = textContent.items.map((item: any) => item.str).join(' ');
          pageTextCacheRef.current.set(pageNum, text);
        }

        const index = text.toLowerCase().indexOf(q);
        if (index !== -1) {
          const start = Math.max(0, index - 25);
          const end = Math.min(text.length, index + q.length + 25);
          results.push({
            page: pageNum,
            snippet: `...${text.substring(start, end).replace(/\s+/g, ' ').trim()}...`,
          });
          setSearchResults([...results]);
        }
        if (results.length >= 25) break;

        // Yield every 5 pages to keep UI responsive
        if (pageNum % 5 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    } catch (err) {
      if (!abortController.signal.aborted) {
        console.error('PDF Search error:', err);
      }
    } finally {
      if (!abortController.signal.aborted) {
        setSearchLoading(false);
      }
    }
  };

  // Persist ephemeral prefs to localStorage whenever they change
  useEffect(() => {
    const prefs = { isInverted, scrollMode };
    localStorage.setItem(localKey, JSON.stringify(prefs));
  }, [isInverted, scrollMode, localKey]);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const activeRenderTaskRef = useRef<any>(null);
  const activeTextTaskRef = useRef<any>(null);

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

  // Metadata-first height preloading (guarantees zero CLS across portrait/landscape/slides)
  const loadAllDimensions = useCallback(async (doc: pdfjsLib.PDFDocumentProxy, signal: { cancelled: boolean }) => {
    try {
      // Step 1: Preload Page 1 immediately for instant first paint
      const p1 = await doc.getPage(1);
      if (signal.cancelled) return;
      const vp1 = p1.getViewport({ scale: 1.0 });
      const initialMap = new Map<number, { width: number; height: number }>();
      initialMap.set(1, { width: vp1.width, height: vp1.height });
      pageDimensionsMapRef.current = new Map(initialMap);
      setPageDimensionsMap(new Map(initialMap));

      // Step 2: Background metadata scan for all pages (no bitmap rendering)
      const dims = new Map(initialMap);
      for (let i = 2; i <= doc.numPages; i++) {
        if (signal.cancelled) return;
        try {
          const page = await doc.getPage(i);
          const vp = page.getViewport({ scale: 1.0 });
          dims.set(i, { width: vp.width, height: vp.height });
          pageDimensionsMapRef.current = dims;
        } catch (e) {
          console.warn(`Could not preload page ${i} metadata:`, e);
        }
        // Yield every 25 pages to keep main thread & worker message channel clear
        if (i % 25 === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      if (!signal.cancelled) {
        pageDimensionsMapRef.current = new Map(dims);
        setPageDimensionsMap(new Map(dims));
      }
    } catch (e) {
      console.error('Error in loadAllDimensions:', e);
    }
  }, []);

  // ── Load PDF via Native HTTP Range Request Streaming ──────────────────────
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);

  const loadingTaskRef = useRef<any>(null);
  useEffect(() => {
    let isMounted = true;
    const loadSignal = { cancelled: false };

    const load = async () => {
      setLoading(true);
      try {
        const headers: Record<string, string> = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;

        // Stream directly via HTTP Range requests without buffering entire binary in JS heap
        const loadingTask = pdfjsLib.getDocument({
          url: `/api/books/${book.id}/file`,
          httpHeaders: headers,
          withCredentials: true,
          disableRange: false,
          disableStream: false,
          disableAutoFetch: false,
        });
        loadingTaskRef.current = loadingTask;

        const doc = await loadingTask.promise;
        if (isMounted) {
          setPdf(doc);
          setTotalPages(doc.numPages);
          setLoading(false);

          // Fast metadata-first preload of unscaled viewports
          loadAllDimensions(doc, loadSignal);

          try {
            const docOutline = await doc.getOutline();
            setOutline(docOutline || []);
          } catch (e) {
            console.error('Failed to parse outline:', e);
          }
        }
      } catch (err) {
        if (!isMounted) return;
        console.error(err);
        alert('Failed to load PDF file. Please try again.');
        onBackRef.current();
      }
    };

    load();

    return () => {
      isMounted = false;
      loadSignal.cancelled = true;
      if (loadingTaskRef.current) {
        loadingTaskRef.current.destroy().catch(() => {});
        loadingTaskRef.current = null;
      }
    };
  }, [book.id, token, loadAllDimensions]);

  // ── Restore initial scroll position in scroll mode ────────────────────────
  const hasRestoredInitialScroll = useRef(false);
  useEffect(() => {
    if (!loading && scrollMode && !hasRestoredInitialScroll.current) {
      hasRestoredInitialScroll.current = true;
      const targetPage = book.current_page || 1;
      if (targetPage > 1) {
        requestAnimationFrame(() => {
          const el = document.getElementById(`pdf-page-${targetPage}`);
          if (el && containerRef.current) {
            const containerTop = containerRef.current.getBoundingClientRect().top;
            const targetTop = el.getBoundingClientRect().top;
            containerRef.current.scrollTop += (targetTop - containerTop);
          }
        });
      }
    }
  }, [loading, scrollMode, book.current_page]);

  // ── Throttled Container ResizeObserver (Eliminates Synchronous Cascades) ───
  const resizeTimeoutRef = useRef<number | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const obs = new ResizeObserver(([entry]) => {
      if (resizeTimeoutRef.current) cancelAnimationFrame(resizeTimeoutRef.current);
      resizeTimeoutRef.current = requestAnimationFrame(() => {
        const newW = entry.contentRect.width;
        const newH = entry.contentRect.height;
        setContainerSize((prev) => {
          if (Math.abs(prev.width - newW) > 2 || Math.abs(prev.height - newH) > 2) {
            return { width: newW, height: newH };
          }
          return prev;
        });
      });
    });

    obs.observe(el);
    setContainerSize({ width: el.clientWidth, height: el.clientHeight });

    return () => {
      obs.disconnect();
      if (resizeTimeoutRef.current) cancelAnimationFrame(resizeTimeoutRef.current);
    };
  }, [loading]);

  // ── Single-page render (non-scroll mode) with alpha:false and 4096px clamp ─
  const renderPage = useCallback(async () => {
    if (scrollMode || !pdf || !canvasRef.current || !containerRef.current) return;
    try {
      if (activeRenderTaskRef.current) activeRenderTaskRef.current.cancel();
      if (activeTextTaskRef.current) {
        activeTextTaskRef.current.cancel();
        activeTextTaskRef.current = null;
      }
      const page = await pdf.getPage(currentPage);
      const canvas = canvasRef.current;
      if (!canvas) return;

      const cw = Math.max(100, containerRef.current.clientWidth - 40);
      const ch = Math.max(100, containerRef.current.clientHeight - 40);
      const unscaled = page.getViewport({ scale: 1.0 });

      let targetScale = zoom;
      if (viewMode === 'fit-width') {
        const byWidth = cw / unscaled.width;
        const byHeight = ch / unscaled.height;
        targetScale = Math.min(byWidth, byHeight) * zoom;
      } else if (viewMode === 'fit-height') {
        targetScale = (ch / unscaled.height) * zoom;
      }

      const targetPixelWidth = unscaled.width * targetScale;
      const targetPixelHeight = unscaled.height * targetScale;

      let renderScale = targetScale;
      if (targetPixelWidth > MAX_CANVAS_DIMENSION || targetPixelHeight > MAX_CANVAS_DIMENSION) {
        const clampRatio = Math.min(
          MAX_CANVAS_DIMENSION / targetPixelWidth,
          MAX_CANVAS_DIMENSION / targetPixelHeight
        );
        renderScale = targetScale * clampRatio;
      }

      const viewport = page.getViewport({ scale: renderScale });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(targetPixelWidth)}px`;
      canvas.style.height = `${Math.floor(targetPixelHeight)}px`;

      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const task = page.render({ canvasContext: ctx, viewport });
      activeRenderTaskRef.current = task;
      await task.promise;
      activeRenderTaskRef.current = null;

      if (textLayerRef.current) {
        textLayerRef.current.replaceChildren();
        const textContent = await page.getTextContent();
        if (textLayerRef.current) {
          const textViewport = page.getViewport({ scale: targetScale });
          textLayerRef.current.style.setProperty('--scale-factor', targetScale.toString());
          const textTask = pdfjsLib.renderTextLayer({
            textContentSource: textContent,
            container: textLayerRef.current,
            viewport: textViewport,
            textDivs: [],
          });
          activeTextTaskRef.current = textTask;
          await textTask.promise;
          activeTextTaskRef.current = null;
        }
      }
    } catch (err: any) {
      if (err?.name !== 'RenderingCancelledException') {
        console.error(err);
      }
    }
  }, [pdf, currentPage, zoom, viewMode, scrollMode]);

  useEffect(() => { renderPage(); }, [renderPage]);

  // ── Sync progress (Debounced) ─────────────────────────────────────────────
  useEffect(() => {
    if (!pdf) return;
    debouncedSyncProgress(currentPage, zoom, viewMode, containerRef.current?.scrollTop || 0);
  }, [currentPage, zoom, viewMode, pdf, debouncedSyncProgress]);

  // ── Jump to a specific page (direct coordinate scroll for large jumps) ────
  const jumpToPage = useCallback((page: number) => {
    const clamped = Math.max(1, Math.min(totalPages, page));
    setCurrentPage(clamped);
    if (scrollMode && containerRef.current) {
      isProgrammaticScrollRef.current = true;
      const el = document.getElementById(`pdf-page-${clamped}`);
      if (el) {
        const isFarJump = Math.abs(clamped - currentPage) > 2;
        const containerTop = containerRef.current.getBoundingClientRect().top;
        const targetTop = el.getBoundingClientRect().top;
        const scrollDelta = targetTop - containerTop;
        containerRef.current.scrollTo({
          top: containerRef.current.scrollTop + scrollDelta,
          behavior: isFarJump ? 'auto' : 'smooth',
        });
        setTimeout(() => {
          isProgrammaticScrollRef.current = false;
        }, isFarJump ? 50 : 500);
      } else {
        isProgrammaticScrollRef.current = false;
      }
    }
  }, [scrollMode, totalPages, currentPage]);

  // IntersectionObserver callback — updates display counter without forced scroll
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

          {/* PAGES PANEL — Single Shared IntersectionObserver */}
          {sidebarTab === 'pages' && (
            <div
              ref={sidebarScrollRef}
              className="w-full grow shrink-0 basis-0 items-start gap-3 px-3 py-3 grid grid-cols-2 content-start overflow-auto"
            >
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
                          sharedObserver={sharedThumbnailObserver}
                          listenersMap={thumbnailListenersRef.current}
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
                      if (item.dest && pdf) {
                        try {
                          let explicitDest = item.dest;
                          if (typeof explicitDest === 'string') {
                            explicitDest = await pdf.getDestination(explicitDest);
                          }
                          const ref = Array.isArray(explicitDest) ? explicitDest[0] : explicitDest;
                          const pageIndex = await pdf.getPageIndex(ref);
                          if (typeof pageIndex === 'number' && pageIndex >= 0) {
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
                onClick={() => setZoom((z) => Math.max(0.5, z - 0.05))}
              />
              <span className="w-10 flex-none text-caption-bold font-caption-bold text-default-font text-center" style={{ color: '#f8fafc' }}>
                {Math.round(zoom * 100)}%
              </span>
              <IconButton
                variant="neutral-tertiary"
                size="small"
                icon={<FeatherPlus />}
                onClick={() => setZoom((z) => Math.min(3.0, z + 0.05))}
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
                            onClick={() => setZoom((z) => Math.max(0.5, z - 0.05))}
                          />
                          <span className="w-10 flex-none text-caption-bold font-caption-bold text-default-font text-center text-white">
                            {Math.round(zoom * 100)}%
                          </span>
                          <IconButton
                            variant="neutral-tertiary"
                            size="small"
                            icon={<FeatherPlus />}
                            onClick={() => setZoom((z) => Math.min(3.0, z + 0.05))}
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
            id="pdf-reader-container"
            ref={containerRef}
            className="flex w-full grow flex-col items-center justify-center border border-solid shadow-md"
            style={{
              borderColor: activeTheme.border,
              backgroundColor: '#08080aff',
              width: '100%',
              height: '100%',
              overflow: scrollMode ? 'auto' : 'hidden',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: scrollMode ? 'flex-start' : 'center',
              padding: '20px',
              transition: 'all 0.3s ease',
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
                    dimensionsMap={pageDimensionsMap}
                    onVisible={handleVisiblePage}
                    containerEl={containerRef.current}
                  />
                ))}
              </>
            ) : (
              <div style={{ position: 'relative', display: 'inline-block' }}>
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
                <div
                  ref={textLayerRef}
                  className="textLayer"
                  style={{ opacity: 1, zIndex: 10, mixBlendMode: isInverted ? 'difference' : 'normal' }}
                />
              </div>
            )}
          </div>
        </div>

        {/* BOTTOM NAVIGATION FLOATING BAR */}
        {!loading && (
          <div
            className="flex items-center gap-2 rounded-full border border-solid bg-[#12121a]/90 backdrop-blur-md px-3 py-2 shadow-lg absolute bottom-6 left-1/2 -translate-x-1/2 z-10"
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

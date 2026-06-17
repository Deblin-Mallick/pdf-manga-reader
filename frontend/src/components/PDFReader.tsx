import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, ZoomIn, ZoomOut, Maximize2, Minimize2, Eye, Sun, ChevronLeft, ChevronRight, List } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import { Book } from '../App';

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
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(book.current_page || 1);
  const [totalPages, setTotalPages] = useState(book.total_pages || 1);
  const [zoom, setZoom] = useState(book.zoom || 1.0);
  const [viewMode, setViewMode] = useState<string>(book.view_mode || 'fit-width');
  const [isInverted, setIsInverted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [scrollMode, setScrollMode] = useState(false);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRenderTaskRef = useRef<any>(null);
  // True while a programmatic scroll is in flight — suppresses IntersectionObserver feedback
  const isProgrammaticScrollRef = useRef(false);

  // ── Load PDF ──────────────────────────────────────────────────────────────
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
        onBack();
      }
    };
    load();
    return () => { isMounted = false; };
  }, [book.id, token, onBack]);

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

  // ── Sync progress ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!pdf) return;
    onUpdateProgress(book.id, {
      current_page: currentPage,
      zoom,
      view_mode: viewMode,
      scroll_position: containerRef.current?.scrollTop || 0,
      reading_direction: 'ltr',
    });
  }, [currentPage, zoom, viewMode]);

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

  const Divider = () => (
    <div style={{ width: '1px', height: '20px', backgroundColor: 'rgba(255,255,255,0.12)', flexShrink: 0 }} />
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: 'calc(100vh - 120px)', position: 'relative' }}>

      {/* ── Top Toolbar ───────────────────────────────────────────────────── */}
      <div
        className="glass-panel"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '10px 20px',
          marginBottom: '12px',
          borderRadius: '14px',
          gap: '8px',
          flexWrap: 'wrap',
          zIndex: 5,
        }}
      >
        {/* Back + Title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
          <button
            onClick={onBack}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-secondary)', flexShrink: 0 }}
            className="hover-white"
          >
            <ArrowLeft size={17} /> Back
          </button>
          <span
            style={{
              fontSize: '0.9rem',
              fontWeight: 500,
              color: '#fff',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: '240px',
            }}
          >
            {book.title}
          </span>
        </div>

        {/* Centre controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>

          {/* Prev / Page input / Next */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <button
              onClick={() => jumpToPage(currentPage - 1)}
              disabled={currentPage <= 1}
              style={{ color: currentPage <= 1 ? 'var(--text-muted)' : '#fff', padding: '5px', borderRadius: '50%', backgroundColor: 'rgba(255,255,255,0.04)' }}
              title="Previous page"
            >
              <ChevronLeft size={18} />
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
              <input
                type="number"
                value={currentPage}
                min={1}
                max={totalPages}
                onChange={(e) => {
                  const v = parseInt(e.target.value);
                  if (v >= 1 && v <= totalPages) jumpToPage(v);
                }}
                style={{
                  width: '46px',
                  padding: '4px 6px',
                  borderRadius: '6px',
                  border: '1px solid var(--border-glass)',
                  backgroundColor: 'rgba(255,255,255,0.05)',
                  color: '#fff',
                  textAlign: 'center',
                  fontSize: '0.82rem',
                }}
              />
              <span>/ {totalPages}</span>
            </div>
            <button
              onClick={() => jumpToPage(currentPage + 1)}
              disabled={currentPage >= totalPages}
              style={{ color: currentPage >= totalPages ? 'var(--text-muted)' : '#fff', padding: '5px', borderRadius: '50%', backgroundColor: 'rgba(255,255,255,0.04)' }}
              title="Next page"
            >
              <ChevronRight size={18} />
            </button>
          </div>

          <Divider />

          {/* Fit Width / Fit Height */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <button
              onClick={() => setViewMode(viewMode === 'fit-width' ? 'custom' : 'fit-width')}
              title="Fit Width"
              style={{
                display: 'flex', alignItems: 'center', gap: '5px',
                fontSize: '0.78rem', fontWeight: 500, padding: '5px 10px', borderRadius: '8px',
                color: viewMode === 'fit-width' ? 'var(--accent-secondary)' : 'var(--text-secondary)',
                backgroundColor: viewMode === 'fit-width' ? 'rgba(6,182,212,0.1)' : 'transparent',
                border: `1px solid ${viewMode === 'fit-width' ? 'var(--accent-secondary)' : 'transparent'}`,
                transition: 'all 0.2s',
              }}
            >
              <Maximize2 size={15} /> <span className="desktop-only">Fit Width</span>
            </button>
            <button
              onClick={() => setViewMode(viewMode === 'fit-height' ? 'custom' : 'fit-height')}
              title="Fit Height"
              style={{
                display: 'flex', alignItems: 'center', gap: '5px',
                fontSize: '0.78rem', fontWeight: 500, padding: '5px 10px', borderRadius: '8px',
                color: viewMode === 'fit-height' ? 'var(--accent-secondary)' : 'var(--text-secondary)',
                backgroundColor: viewMode === 'fit-height' ? 'rgba(6,182,212,0.1)' : 'transparent',
                border: `1px solid ${viewMode === 'fit-height' ? 'var(--accent-secondary)' : 'transparent'}`,
                transition: 'all 0.2s',
              }}
            >
              <Minimize2 size={15} /> <span className="desktop-only">Fit Height</span>
            </button>
          </div>

          <Divider />

          {/* Zoom */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <button onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} style={{ color: 'var(--text-secondary)', padding: '4px' }} title="Zoom Out">
              <ZoomOut size={16} />
            </button>
            <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#fff', width: '38px', textAlign: 'center' }}>
              {Math.round(zoom * 100)}%
            </span>
            <button onClick={() => setZoom((z) => Math.min(3.0, z + 0.25))} style={{ color: 'var(--text-secondary)', padding: '4px' }} title="Zoom In">
              <ZoomIn size={16} />
            </button>
          </div>

          <Divider />

          {/* Infinite Scroll toggle */}
          <button
            onClick={() => setScrollMode((s) => !s)}
            title={scrollMode ? 'Switch to page-by-page mode' : 'Switch to infinite scroll mode'}
            style={{
              display: 'flex', alignItems: 'center', gap: '5px',
              fontSize: '0.78rem', fontWeight: 500, padding: '5px 10px', borderRadius: '8px',
              color: scrollMode ? 'var(--accent-primary)' : 'var(--text-secondary)',
              backgroundColor: scrollMode ? 'rgba(139,92,246,0.12)' : 'transparent',
              border: `1px solid ${scrollMode ? 'var(--accent-primary)' : 'transparent'}`,
              transition: 'all 0.2s',
            }}
          >
            <List size={15} /> <span className="desktop-only">Scroll</span>
          </button>

          <Divider />

          {/* Night Mode */}
          <button
            onClick={() => setIsInverted((v) => !v)}
            title="Toggle Night Mode"
            style={{
              display: 'flex', alignItems: 'center', gap: '5px',
              fontSize: '0.78rem', fontWeight: 500, padding: '5px 10px', borderRadius: '8px',
              color: isInverted ? 'var(--accent-primary)' : 'var(--text-secondary)',
              backgroundColor: isInverted ? 'rgba(139,92,246,0.12)' : 'transparent',
              border: `1px solid ${isInverted ? 'var(--accent-primary)' : 'transparent'}`,
              transition: 'all 0.2s',
            }}
          >
            {isInverted ? <Sun size={15} /> : <Eye size={15} />}
            <span className="desktop-only">Night Mode</span>
          </button>
        </div>

        {/* Right spacer */}
        <div style={{ minWidth: '60px' }} />
      </div>

      {/* ── Canvas area wrapper ── shares position context between scrollable content and overlay */}
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>

        {/* Scrollable / hidden canvas container */}
        <div
          ref={containerRef}
          style={{
            position: 'absolute',
            inset: 0,
            overflow: scrollMode ? 'auto' : 'hidden',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: scrollMode ? 'flex-start' : 'center',
            padding: '20px',
            backgroundColor: '#050508',
            borderRadius: '16px',
            border: '1px solid var(--border-glass)',
          }}
        >
          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', margin: 'auto' }}>
              <div style={{ width: '40px', height: '40px', borderRadius: '50%', border: '3px solid var(--border-glass)', borderTopColor: 'var(--accent-secondary)', animation: 'spin 1s linear infinite' }} />
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Loading book pages...</p>
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

        {/* Overlay: always covers exactly the canvas area, works at any resolution */}
        {!loading && (
          <div style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            zIndex: 30,
            borderRadius: '16px',
            overflow: 'hidden',
          }}>
            {/* Green circle home button — top-left */}
            <button
              onClick={onBack}
              title="Back to Library"
              className="pdf-home-btn"
              style={{
                position: 'absolute',
                top: '16px',
                left: '16px',
                pointerEvents: 'auto',
                width: '40px',
                height: '40px',
                borderRadius: '50%',
                background: 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
                boxShadow: '0 4px 16px rgba(34,197,94,0.45)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '2px solid rgba(255,255,255,0.18)',
                cursor: 'pointer',
                transition: 'transform 0.2s ease, box-shadow 0.2s ease',
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
              </svg>
            </button>

            {/* Hover-triggered zoom widget — bottom-left */}
            <div className="pdf-zoom-anchor" style={{ position: 'absolute', bottom: '16px', left: '16px', pointerEvents: 'auto' }}>
              <div className="pdf-zoom-pill">
                <button onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} className="pdf-zoom-btn" title="Zoom out">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
                </button>
                <span className="pdf-zoom-pct">{Math.round(zoom * 100)}%</span>
                <button onClick={() => setZoom((z) => Math.min(3.0, z + 0.25))} className="pdf-zoom-btn" title="Zoom in">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                </button>
              </div>
            </div>
          </div>
        )}

      </div>

      <style>{`
        .hover-white:hover { color: #fff !important; }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }

        /* ── Hide overlay controls on touch screens (Android / iOS) ── */
        /* pointer:coarse = touch input; hover:none = no mouse hover capability */
        @media (hover: none) and (pointer: coarse) {
          .pdf-home-btn,
          .pdf-zoom-anchor {
            display: none !important;
          }
        }

        /* ── Green home button ── */
        .pdf-home-btn:hover {
          transform: scale(1.12);
          box-shadow: 0 6px 24px rgba(34,197,94,0.65) !important;
        }
        .pdf-home-btn:active {
          transform: scale(0.95);
        }

        /* ── Zoom anchor (hitbox) ── */
        .pdf-zoom-anchor {
          width: fit-content;
          padding: 20px 20px 4px 4px;
        }
        .pdf-zoom-pill {
          display: flex;
          align-items: center;
          gap: 2px;
          background: rgba(15,15,25,0.88);
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          border: 1px solid rgba(255,255,255,0.13);
          border-radius: 50px;
          padding: 6px 10px;
          box-shadow: 0 8px 28px rgba(0,0,0,0.55);
          opacity: 0;
          transform: translateY(8px);
          transition: opacity 0.28s ease, transform 0.28s ease;
          pointer-events: none;
        }
        .pdf-zoom-anchor:hover .pdf-zoom-pill {
          opacity: 1;
          transform: translateY(0);
          pointer-events: auto;
        }
        .pdf-zoom-btn {
          color: rgba(255,255,255,0.75);
          padding: 5px 9px;
          border-radius: 50px;
          transition: color 0.15s, background 0.15s;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .pdf-zoom-btn:hover {
          color: #fff;
          background: rgba(255,255,255,0.08);
        }
        .pdf-zoom-pct {
          font-size: 0.82rem;
          font-weight: 700;
          color: #fff;
          min-width: 40px;
          text-align: center;
          letter-spacing: 0.02em;
        }
      `}</style>
    </div>
  );
}


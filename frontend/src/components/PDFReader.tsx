import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, ZoomIn, ZoomOut, Maximize2, Minimize2, Eye, Sun, ChevronLeft, ChevronRight } from 'lucide-react';
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

export default function PDFReader({
  book,
  token,
  onBack,
  onUpdateProgress,
}: PDFReaderProps) {
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(book.current_page || 1);
  const [totalPages, setTotalPages] = useState(book.total_pages || 1);
  const [zoom, setZoom] = useState(book.zoom || 1.0);
  const [viewMode, setViewMode] = useState<string>(book.view_mode || 'fit-width');
  const [isInverted, setIsInverted] = useState(false); // Night mode color filter
  const [loading, setLoading] = useState(true);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRenderTaskRef = useRef<any>(null);

  // Load PDF from server
  useEffect(() => {
    let isMounted = true;
    const loadPdfDoc = async () => {
      setLoading(true);
      try {
        const headers: HeadersInit = {};
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        
        const response = await fetch(`/api/books/${book.id}/file`, { headers });
        if (!response.ok) {
          throw new Error('Failed to load PDF file');
        }
        
        const buffer = await response.arrayBuffer();
        
        // Load the document using PDFJS
        const loadingTask = pdfjsLib.getDocument({ data: buffer });
        const pdfDoc = await loadingTask.promise;
        
        if (isMounted) {
          setPdf(pdfDoc);
          setTotalPages(pdfDoc.numPages);
          setLoading(false);
        }
      } catch (err) {
        console.error('Error loading PDF:', err);
        alert('Failed to load PDF file. Please try again.');
        onBack();
      }
    };

    loadPdfDoc();

    return () => {
      isMounted = false;
    };
  }, [book.id, token, onBack]);

  // Render active page
  const renderPage = useCallback(async () => {
    if (!pdf || !canvasRef.current || !containerRef.current) return;

    try {
      // Cancel any running render task first
      if (activeRenderTaskRef.current) {
        activeRenderTaskRef.current.cancel();
      }

      const page = await pdf.getPage(currentPage);
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const containerWidth = containerRef.current.clientWidth;
      const containerHeight = containerRef.current.clientHeight;

      // Get page dimensions at scale = 1.0
      const unscaledViewport = page.getViewport({ scale: 1.0 });
      let calculatedScale = zoom;

      if (viewMode === 'fit-width') {
        calculatedScale = (containerWidth / unscaledViewport.width) * zoom;
      } else if (viewMode === 'fit-height') {
        calculatedScale = ((containerHeight - 40) / unscaledViewport.height) * zoom;
      }

      const viewport = page.getViewport({ scale: calculatedScale });
      canvas.width = viewport.width;
      canvas.height = viewport.height;

      const renderContext = {
        canvasContext: ctx,
        viewport: viewport,
      };

      const renderTask = page.render(renderContext);
      activeRenderTaskRef.current = renderTask;

      await renderTask.promise;
      activeRenderTaskRef.current = null;

      // Save progress to backend
      onUpdateProgress(book.id, {
        current_page: currentPage,
        zoom: zoom,
        view_mode: viewMode,
        scroll_position: containerRef.current.scrollTop || 0,
        reading_direction: 'ltr',
      });
    } catch (err: any) {
      if (err.name === 'RenderingCancelledException' || err.message === 'Rendering cancelled, page-switch') {
        // Safe to ignore since we canceled it purposefully
        return;
      }
      console.error('Error rendering page:', err);
    }
  }, [pdf, currentPage, zoom, viewMode, book.id, onUpdateProgress]);

  // Trigger page render when page, zoom, viewMode, or pdf changes
  useEffect(() => {
    renderPage();
  }, [renderPage]);

  // Resize handler
  useEffect(() => {
    const handleResize = () => {
      renderPage();
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [renderPage]);

  const handleNextPage = () => {
    if (currentPage < totalPages) {
      setCurrentPage((prev) => prev + 1);
    }
  };

  const handlePrevPage = () => {
    if (currentPage > 1) {
      setCurrentPage((prev) => prev - 1);
    }
  };

  // Keyboard Navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        handleNextPage();
      } else if (e.key === 'ArrowLeft') {
        handlePrevPage();
      } else if (e.key === 'Space') {
        e.preventDefault();
        if (containerRef.current) {
          containerRef.current.scrollTop += 200;
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentPage, totalPages]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: 'calc(100vh - 120px)', position: 'relative' }}>
      
      {/* Top controls */}
      <div className="glass-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 24px', marginBottom: '16px', borderRadius: '12px', zIndex: 5 }}>
        <button onClick={onBack} style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)' }} className="hover-white">
          <ArrowLeft size={18} /> Back
        </button>
        <span style={{ fontSize: '0.95rem', fontWeight: 500, color: '#fff', maxWidth: '300px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {book.title}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          <span>Page</span>
          <input 
            type="number" 
            value={currentPage}
            onChange={(e) => {
              const val = parseInt(e.target.value);
              if (val >= 1 && val <= totalPages) setCurrentPage(val);
            }}
            style={{ width: '50px', padding: '4px', borderRadius: '4px', border: '1px solid var(--border-glass)', backgroundColor: 'rgba(255,255,255,0.03)', color: '#fff', textAlign: 'center' }}
          />
          <span>of {totalPages}</span>
        </div>
      </div>

      {/* Main Canvas Container */}
      <div 
        ref={containerRef}
        style={{
          flex: 1,
          overflow: 'auto',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'flex-start',
          padding: '20px',
          backgroundColor: '#050508',
          borderRadius: '16px',
          border: '1px solid var(--border-glass)',
          position: 'relative',
        }}
      >
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', margin: 'auto' }}>
            <div style={{ width: '40px', height: '40px', borderRadius: '50%', border: '3px solid var(--border-glass)', borderTopColor: 'var(--accent-secondary)', animation: 'spin 1s linear infinite' }} />
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Loading book pages...</p>
          </div>
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

      {/* Floating Bottom Toolbar */}
      <div 
        className="glass-panel" 
        style={{ 
          position: 'absolute', 
          bottom: '24px', 
          left: '50%', 
          transform: 'translateX(-50%)', 
          display: 'flex', 
          alignItems: 'center', 
          gap: '24px', 
          padding: '12px 24px', 
          borderRadius: '50px',
          boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
          border: '1px solid rgba(255, 255, 255, 0.12)',
        }}
      >
        {/* Navigation */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button 
            onClick={handlePrevPage} 
            disabled={currentPage <= 1}
            style={{ color: currentPage <= 1 ? 'var(--text-muted)' : '#fff', padding: '6px', borderRadius: '50%', backgroundColor: 'rgba(255,255,255,0.03)' }}
          >
            <ChevronLeft size={20} />
          </button>
          <button 
            onClick={handleNextPage} 
            disabled={currentPage >= totalPages}
            style={{ color: currentPage >= totalPages ? 'var(--text-muted)' : '#fff', padding: '6px', borderRadius: '50%', backgroundColor: 'rgba(255,255,255,0.03)' }}
          >
            <ChevronRight size={20} />
          </button>
        </div>

        <div style={{ width: '1px', height: '20px', backgroundColor: 'var(--border-glass)' }} />

        {/* View Fitting */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button 
            onClick={() => setViewMode(viewMode === 'fit-width' ? 'custom' : 'fit-width')}
            style={{ 
              color: viewMode === 'fit-width' ? 'var(--accent-secondary)' : 'var(--text-secondary)',
              display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', fontWeight: 500
            }}
          >
            <Maximize2 size={16} /> <span className="desktop-only">Fit Width</span>
          </button>
          <button 
            onClick={() => setViewMode(viewMode === 'fit-height' ? 'custom' : 'fit-height')}
            style={{ 
              color: viewMode === 'fit-height' ? 'var(--accent-secondary)' : 'var(--text-secondary)',
              display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', fontWeight: 500
            }}
          >
            <Minimize2 size={16} /> <span className="desktop-only">Fit Height</span>
          </button>
        </div>

        <div style={{ width: '1px', height: '20px', backgroundColor: 'var(--border-glass)' }} />

        {/* Zoom */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button 
            onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
            style={{ color: 'var(--text-secondary)', padding: '4px' }}
          >
            <ZoomOut size={16} />
          </button>
          <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#fff', width: '40px', textAlign: 'center' }}>
            {Math.round(zoom * 100)}%
          </span>
          <button 
            onClick={() => setZoom((z) => Math.min(3.0, z + 0.25))}
            style={{ color: 'var(--text-secondary)', padding: '4px' }}
          >
            <ZoomIn size={16} />
          </button>
        </div>

        <div style={{ width: '1px', height: '20px', backgroundColor: 'var(--border-glass)' }} />

        {/* Canvas Inversion (Night reading mode) */}
        <button 
          onClick={() => setIsInverted(!isInverted)}
          style={{ 
            color: isInverted ? 'var(--accent-primary)' : 'var(--text-secondary)',
            display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', fontWeight: 500
          }}
          title="Toggle Night Mode Canvas"
        >
          {isInverted ? <Sun size={16} /> : <Eye size={16} />}
          <span className="desktop-only">Night Mode</span>
        </button>
      </div>

      <style>{`
        .hover-white:hover { color: #fff !important; }
      `}</style>
    </div>
  );
}

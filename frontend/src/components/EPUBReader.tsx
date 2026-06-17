import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Sun, Eye, ZoomIn, ZoomOut } from 'lucide-react';
import JSZip from 'jszip';
import { Book } from '../App';

interface EPUBReaderProps {
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

export default function EPUBReader({
  book,
  token,
  onBack,
  onUpdateProgress,
}: EPUBReaderProps) {
  const [zip, setZip] = useState<JSZip | null>(null);
  const [spineHrefs, setSpineHrefs] = useState<string[]>([]);
  const [currentPage, setCurrentPage] = useState(book.current_page || 1);
  const [pageHtml, setPageHtml] = useState<string>('');
  
  const [fontSize, setFontSize] = useState<number>(100); // Font size scaling percentage
  const [isNightMode, setIsNightMode] = useState<boolean>(true); // Night reading mode
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingText, setLoadingText] = useState<string>('Downloading EPUB...');

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load EPUB file and parse manifest/spine
  useEffect(() => {
    let isMounted = true;
    const loadEpub = async () => {
      try {
        const headers: HeadersInit = {};
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }

        const response = await fetch(`/api/books/${book.id}/file`, { headers });
        if (!response.ok) {
          throw new Error('Failed to load EPUB file');
        }

        setLoadingText('Parsing EPUB archive...');
        const buffer = await response.arrayBuffer();
        const loadedZip = await JSZip.loadAsync(buffer);

        // Find OPF file path in the container
        let opfKey = '';
        const containerFile = loadedZip.files['META-INF/container.xml'];
        
        if (containerFile) {
          const containerXml = await containerFile.async('text');
          const parser = new DOMParser();
          const doc = parser.parseFromString(containerXml, 'text/xml');
          const rootfile = doc.getElementsByTagName('rootfile')[0];
          if (rootfile) {
            opfKey = rootfile.getAttribute('full-path') || '';
          }
        }

        // Fallback: search for OPF in directory if container parsing fails
        if (!opfKey) {
          opfKey = Object.keys(loadedZip.files).find((key) => key.endsWith('.opf')) || '';
        }

        if (!opfKey) {
          throw new Error('Invalid EPUB archive: OPF file not found.');
        }

        // Parse OPF to getspine (manifest maps id -> href)
        const opfText = await loadedZip.files[opfKey].async('text');
        const parser = new DOMParser();
        const opfDoc = parser.parseFromString(opfText, 'text/xml');

        const manifestMap: { [id: string]: string } = {};
        const items = opfDoc.getElementsByTagName('item');
        for (let i = 0; i < items.length; i++) {
          const id = items[i].getAttribute('id');
          const href = items[i].getAttribute('href');
          if (id && href) {
            manifestMap[id] = href;
          }
        }

        const itemRefs = opfDoc.getElementsByTagName('itemref');
        const resolvedSpine: string[] = [];
        const opfDir = opfKey.substring(0, opfKey.lastIndexOf('/')) || '';

        for (let i = 0; i < itemRefs.length; i++) {
          const idref = itemRefs[i].getAttribute('idref');
          if (idref && manifestMap[idref]) {
            const href = manifestMap[idref];
            // Resolve relative path based on OPF location
            const fullPath = opfDir ? `${opfDir}/${href}` : href;
            resolvedSpine.push(fullPath);
          }
        }

        if (resolvedSpine.length === 0) {
          throw new Error('Invalid EPUB archive: Spine is empty.');
        }

        if (isMounted) {
          setZip(loadedZip);
          setSpineHrefs(resolvedSpine);
          setLoading(false);
        }
      } catch (err) {
        console.error('Error reading EPUB:', err);
        alert(err instanceof Error ? err.message : 'Failed to load EPUB archive.');
        onBack();
      }
    };

    loadEpub();

    return () => {
      isMounted = false;
    };
  }, [book.id, token, onBack]);

  // Load and style active chapter/page
  const loadPageContent = useCallback(async () => {
    if (!zip || spineHrefs.length === 0) return;

    try {
      const pagePath = spineHrefs[currentPage - 1];
      const pageFile = zip.files[pagePath];

      if (!pageFile) {
        throw new Error(`Page file missing in archive: ${pagePath}`);
      }

      let htmlContent = await pageFile.async('text');

      // Inject custom styling to match our premium UI
      const bg = isNightMode ? '#0c0c12' : '#ffffff';
      const fg = isNightMode ? '#e2e8f0' : '#1e293b';
      const headingColor = isNightMode ? '#ffffff' : '#0f172a';
      const hrColor = isNightMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';

      const styleInjection = `
        <style>
          body {
            background-color: ${bg} !important;
            color: ${fg} !important;
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            line-height: 1.65 !important;
            font-size: ${fontSize}% !important;
            padding: 24px 32px !important;
            margin: 0 auto !important;
            max-width: 800px !important;
            transition: background-color 0.25s ease, color 0.25s ease !important;
          }
          p {
            margin-bottom: 1.25em !important;
            text-align: justify !important;
          }
          h1, h2, h3, h4, h5, h6 {
            color: ${headingColor} !important;
            margin-top: 1.6em !important;
            margin-bottom: 0.8em !important;
            font-weight: 600 !important;
            line-height: 1.3 !important;
          }
          hr {
            border: 0 !important;
            border-top: 1px solid ${hrColor} !important;
            margin: 2em 0 !important;
          }
        </style>
      `;

      // Insert style tag before closing head tag
      if (htmlContent.includes('</head>')) {
        htmlContent = htmlContent.replace('</head>', `${styleInjection}</head>`);
      } else {
        htmlContent = `<head>${styleInjection}</head>${htmlContent}`;
      }

      setPageHtml(htmlContent);

      // Save progress to database
      onUpdateProgress(book.id, {
        current_page: currentPage,
        zoom: fontSize / 100.0,
        view_mode: isNightMode ? 'dark' : 'light',
        scroll_position: 0,
        reading_direction: 'ltr',
      });
    } catch (err) {
      console.error('Error loading EPUB page content:', err);
    }
  }, [zip, spineHrefs, currentPage, fontSize, isNightMode, book.id, onUpdateProgress]);

  // Load content when dependencies change
  useEffect(() => {
    loadPageContent();
  }, [loadPageContent]);

  // Navigation handlers
  const handleNextPage = useCallback(() => {
    if (currentPage < spineHrefs.length) {
      setCurrentPage((prev) => prev + 1);
    }
  }, [currentPage, spineHrefs.length]);

  const handlePrevPage = useCallback(() => {
    if (currentPage > 1) {
      setCurrentPage((prev) => prev - 1);
    }
  }, [currentPage]);

  // Keyboard Navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        handleNextPage();
      } else if (e.key === 'ArrowLeft') {
        handlePrevPage();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleNextPage, handlePrevPage]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: 'calc(100vh - 120px)', position: 'relative' }}>
      
      {/* Top Header Control Panel */}
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
              if (val >= 1 && val <= spineHrefs.length) setCurrentPage(val);
            }}
            style={{ width: '50px', padding: '4px', borderRadius: '4px', border: '1px solid var(--border-glass)', backgroundColor: 'rgba(255,255,255,0.03)', color: '#fff', textAlign: 'center' }}
          />
          <span>of {spineHrefs.length}</span>
        </div>
      </div>

      {/* Main EPUB Reader Container */}
      <div 
        ref={containerRef}
        style={{
          flex: 1,
          overflow: 'hidden',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          backgroundColor: isNightMode ? '#050508' : '#e5e7eb',
          borderRadius: '16px',
          border: '1px solid var(--border-glass)',
          position: 'relative',
          padding: '12px'
        }}
      >
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', margin: 'auto' }}>
            <div style={{ width: '40px', height: '40px', borderRadius: '50%', border: '3px solid var(--border-glass)', borderTopColor: 'var(--accent-primary)', animation: 'spin 1s linear infinite' }} />
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{loadingText}</p>
          </div>
        ) : (
          <iframe 
            ref={iframeRef} 
            srcDoc={pageHtml}
            style={{ 
              width: '100%',
              height: '100%',
              border: 'none',
              borderRadius: '8px',
              backgroundColor: isNightMode ? '#0c0c12' : '#ffffff',
              boxShadow: '0 8px 30px rgba(0,0,0,0.3)'
            }}
            title="EPUB Page Content"
          />
        )}
      </div>

      {/* Floating Bottom Toolbar */}
      {!loading && (
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
          {/* Navigation Controls */}
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
              disabled={currentPage >= spineHrefs.length}
              style={{ color: currentPage >= spineHrefs.length ? 'var(--text-muted)' : '#fff', padding: '6px', borderRadius: '50%', backgroundColor: 'rgba(255,255,255,0.03)' }}
            >
              <ChevronRight size={20} />
            </button>
          </div>

          <div style={{ width: '1px', height: '20px', backgroundColor: 'var(--border-glass)' }} />

          {/* Font Size Scaling */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button 
              onClick={() => setFontSize((s) => Math.max(70, s - 10))}
              style={{ color: 'var(--text-secondary)', padding: '4px' }}
              title="Decrease Font Size"
            >
              <ZoomOut size={16} />
            </button>
            <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#fff', width: '40px', textAlign: 'center' }}>
              {fontSize}%
            </span>
            <button 
              onClick={() => setFontSize((s) => Math.min(200, s + 10))}
              style={{ color: 'var(--text-secondary)', padding: '4px' }}
              title="Increase Font Size"
            >
              <ZoomIn size={16} />
            </button>
          </div>

          <div style={{ width: '1px', height: '20px', backgroundColor: 'var(--border-glass)' }} />

          {/* Dark / Light Toggle */}
          <button 
            onClick={() => setIsNightMode(!isNightMode)}
            style={{ 
              color: isNightMode ? 'var(--accent-secondary)' : 'var(--text-secondary)',
              display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', fontWeight: 500
            }}
            title="Toggle Night Mode"
          >
            {isNightMode ? <Sun size={16} /> : <Eye size={16} />}
            <span className="desktop-only">{isNightMode ? 'Light Mode' : 'Night Mode'}</span>
          </button>
        </div>
      )}

      <style>{`
        .hover-white:hover { color: #fff !important; }
      `}</style>
    </div>
  );
}

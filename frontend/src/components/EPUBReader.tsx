import { useState, useEffect, useRef, useCallback } from 'react';
import { 
  ArrowLeft, ChevronLeft, ChevronRight, Sun, Moon, Eye, 
  ZoomIn, ZoomOut, Settings, Menu, X, BookOpen, Search, Bookmark, Edit, Trash2, Sliders
} from 'lucide-react';
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

interface TOCItem {
  title: string;
  href: string;
}

interface ReaderSettings {
  fontSize: number;       // font size in px
  lineHeight: number;     // e.g. 1.6
  theme: 'light' | 'dark' | 'sepia';
  fontFamily: 'literata' | 'georgia' | 'inter';
}

interface BookmarkItem {
  id: string;
  chapterIndex: number;
  chapterTitle: string;
  addedAt: string;
}

interface NoteItem {
  id: string;
  chapterIndex: number;
  chapterTitle: string;
  noteText: string;
  addedAt: string;
}

interface SearchResult {
  chapterIndex: number;
  chapterTitle: string;
  snippet: string;
}

const themeStyles = {
  light: {
    bg: '#F8F6F1',       // Paper-like background
    cardBg: '#ffffff',   // White card reading surface
    text: '#1f2937',     // Dark gray text
    heading: '#0f172a',  // Black headings
    hr: 'rgba(0,0,0,0.08)',
    sidebarBg: 'rgba(255, 255, 255, 0.9)',
    sidebarText: '#374151',
    border: 'rgba(0,0,0,0.06)',
    activeBg: 'rgba(0, 0, 0, 0.05)',
  },
  dark: {
    bg: '#111827',       // Dark blue-gray background
    cardBg: '#1f2937',   // Dark gray reading surface
    text: '#e5e7eb',     // Light gray text
    heading: '#ffffff',  // White headings
    hr: 'rgba(255,255,255,0.08)',
    sidebarBg: 'rgba(31, 41, 55, 0.95)',
    sidebarText: '#d1d5db',
    border: 'rgba(255,255,255,0.06)',
    activeBg: 'rgba(255, 255, 255, 0.05)',
  },
  sepia: {
    bg: '#F4ECD8',       // Sepia background
    cardBg: '#FDF6E3',   // Warm cream reading surface
    text: '#5C4636',     // Brown text
    heading: '#433422',  // Dark brown headings
    hr: 'rgba(92,70,54,0.12)',
    sidebarBg: 'rgba(244, 236, 216, 0.95)',
    sidebarText: '#5C4636',
    border: 'rgba(92,70,54,0.08)',
    activeBg: 'rgba(92, 70, 54, 0.06)',
  }
};

function resolveRelativePath(basePath: string, relativePath: string): string {
  if (relativePath.startsWith('http://') || relativePath.startsWith('https://') || relativePath.startsWith('data:')) {
    return relativePath;
  }
  
  const baseParts = basePath.split('/');
  baseParts.pop(); // Remove file name
  
  const relParts = relativePath.split('/');
  for (const part of relParts) {
    if (part === '.' || part === '') {
      continue;
    } else if (part === '..') {
      baseParts.pop();
    } else {
      baseParts.push(part);
    }
  }
  
  return baseParts.join('/');
}

export default function EPUBReader({
  book,
  token,
  onBack,
  onUpdateProgress,
}: EPUBReaderProps) {
  const [zip, setZip] = useState<JSZip | null>(null);
  const [spineHrefs, setSpineHrefs] = useState<string[]>([]);
  const [toc, setToc] = useState<TOCItem[]>([]);
  const [currentPage, setCurrentPage] = useState(book.current_page || 1);
  const [pageHtml, setPageHtml] = useState<string>('');
  
  const [settings, setSettings] = useState<ReaderSettings>({
    fontSize: book.zoom ? Math.round(book.zoom * 18) : 18,
    lineHeight: 1.6,
    theme: book.view_mode === 'dark' || book.view_mode === 'sepia' || book.view_mode === 'light' 
      ? book.view_mode 
      : 'dark',
    fontFamily: 'literata',
  });

  const [loading, setLoading] = useState<boolean>(true);
  const [loadingText, setLoadingText] = useState<string>('Downloading EPUB...');
  
  // Collapsible Sidebar & Tabs
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);
  const [sidebarTab, setSidebarTab] = useState<'toc' | 'search' | 'bookmarks' | 'notes'>('toc');
  
  // Settings cog open state
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  
  // Bookmarks, Notes, Search states
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>([]);
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [newNote, setNewNote] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState<boolean>(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const blobUrlsRef = useRef<string[]>([]);

  // Load Bookmarks & Notes from localStorage
  useEffect(() => {
    const savedBookmarks = localStorage.getItem(`reader_bookmarks_${book.id}`);
    if (savedBookmarks) {
      setBookmarks(JSON.parse(savedBookmarks));
    }
    
    const savedNotes = localStorage.getItem(`reader_notes_${book.id}`);
    if (savedNotes) {
      setNotes(JSON.parse(savedNotes));
    }
  }, [book.id]);

  // Load EPUB file and parse manifest/spine/TOC
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

        if (!opfKey) {
          opfKey = Object.keys(loadedZip.files).find((key) => key.endsWith('.opf')) || '';
        }

        if (!opfKey) {
          throw new Error('Invalid EPUB archive: OPF file not found.');
        }

        // Parse OPF
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
            const fullPath = opfDir ? `${opfDir}/${href}` : href;
            resolvedSpine.push(fullPath);
          }
        }

        if (resolvedSpine.length === 0) {
          throw new Error('Invalid EPUB archive: Spine is empty.');
        }

        // Parse Table of Contents (TOC)
        let resolvedTOC: TOCItem[] = [];

        // Method 1: EPUB 3 Navigation document
        const navItem = Array.from(opfDoc.getElementsByTagName('item')).find(
          item => item.getAttribute('properties')?.includes('nav')
        );

        if (navItem) {
          const navHref = navItem.getAttribute('href') || '';
          const navPath = opfDir ? `${opfDir}/${navHref}` : navHref;
          const navFile = loadedZip.files[navPath];
          if (navFile) {
            const navText = await navFile.async('text');
            const navDoc = parser.parseFromString(navText, 'text/html');
            const navElements = navDoc.querySelectorAll('nav a');
            navElements.forEach((el: any) => {
              const href = el.getAttribute('href') || '';
              const fullHref = resolveRelativePath(navPath, href);
              resolvedTOC.push({
                title: el.textContent?.trim() || 'Untitled',
                href: fullHref.split('#')[0]
              });
            });
          }
        }

        // Method 2: EPUB 2 NCX file
        if (resolvedTOC.length === 0) {
          const spine = opfDoc.getElementsByTagName('spine')[0];
          const tocId = spine?.getAttribute('toc') || 'ncx';
          const ncxItem = Array.from(opfDoc.getElementsByTagName('item')).find(
            item => item.getAttribute('id') === tocId
          );
          
          if (ncxItem) {
            const ncxHref = ncxItem.getAttribute('href') || '';
            const ncxPath = opfDir ? `${opfDir}/${ncxHref}` : ncxHref;
            const ncxFile = loadedZip.files[ncxPath];
            if (ncxFile) {
              const ncxText = await ncxFile.async('text');
              const ncxDoc = parser.parseFromString(ncxText, 'text/xml');
              const navPoints = ncxDoc.getElementsByTagName('navPoint');
              const tocTemp: TOCItem[] = [];
              for (let i = 0; i < navPoints.length; i++) {
                const np = navPoints[i];
                const label = np.getElementsByTagName('navLabel')[0]?.getElementsByTagName('text')[0]?.textContent || '';
                const content = np.getElementsByTagName('content')[0]?.getAttribute('src') || '';
                const fullHref = resolveRelativePath(ncxPath, content);
                tocTemp.push({
                  title: label.trim() || `Chapter ${i + 1}`,
                  href: fullHref.split('#')[0]
                });
              }
              resolvedTOC = tocTemp;
            }
          }
        }

        // Fallback: Use base filenames if TOC is missing
        if (resolvedTOC.length === 0) {
          resolvedTOC = resolvedSpine.map((href, index) => {
            const filename = href.substring(href.lastIndexOf('/') + 1);
            const title = filename
              .replace('.xhtml', '')
              .replace('.html', '')
              .replace(/[-_]/g, ' ')
              .replace(/\b\w/g, c => c.toUpperCase());
            return {
              title: title || `Chapter ${index + 1}`,
              href: href
            };
          });
        }

        if (isMounted) {
          setZip(loadedZip);
          setSpineHrefs(resolvedSpine);
          setToc(resolvedTOC);
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

      // Clean up previous blob URLs
      blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      blobUrlsRef.current = [];

      // Parse HTML to resolve images
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlContent, 'text/html');

      // Resolve <img> tags
      const images = doc.querySelectorAll('img');
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const src = img.getAttribute('src');
        if (src) {
          const resolvedPath = resolveRelativePath(pagePath, src);
          const imgFile = zip.files[resolvedPath];
          if (imgFile) {
            const blob = await imgFile.async('blob');
            const blobUrl = URL.createObjectURL(blob);
            blobUrlsRef.current.push(blobUrl);
            img.setAttribute('src', blobUrl);
          }
        }
      }

      // Resolve SVG <image> tags
      const svgImages = doc.querySelectorAll('image');
      for (let i = 0; i < svgImages.length; i++) {
        const img = svgImages[i];
        const href = img.getAttribute('href') || img.getAttribute('xlink:href');
        if (href) {
          const resolvedPath = resolveRelativePath(pagePath, href);
          const imgFile = zip.files[resolvedPath];
          if (imgFile) {
            const blob = await imgFile.async('blob');
            const blobUrl = URL.createObjectURL(blob);
            blobUrlsRef.current.push(blobUrl);
            img.setAttribute('href', blobUrl);
            img.setAttribute('xlink:href', blobUrl);
          }
        }
      }

      // Apply Google fonts + styles
      const activeTheme = themeStyles[settings.theme];
      const fontStack = settings.fontFamily === 'literata' 
        ? "'Literata', Georgia, serif" 
        : settings.fontFamily === 'georgia' 
          ? "Georgia, serif" 
          : "'Inter', sans-serif";

      const googleFonts = `<link href="https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,200..900;1,7..72,200..900&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">`;

      const styleInjection = `
        ${googleFonts}
        <style>
          body {
            background-color: ${activeTheme.cardBg} !important;
            color: ${activeTheme.text} !important;
            font-family: ${fontStack} !important;
            font-size: ${settings.fontSize}px !important;
            line-height: ${settings.lineHeight} !important;
            padding: 40px 60px !important;
            margin: 0 auto !important;
            max-width: 700px !important;
            transition: background-color 0.25s ease, color 0.25s ease !important;
          }
          p {
            margin-bottom: 1.25em !important;
            text-align: justify !important;
          }
          h1, h2, h3, h4, h5, h6 {
            color: ${activeTheme.heading} !important;
            margin-top: 1.6em !important;
            margin-bottom: 0.8em !important;
            font-weight: 600 !important;
            line-height: 1.3 !important;
          }
          hr {
            border: 0 !important;
            border-top: 1px solid ${activeTheme.hr} !important;
            margin: 2em 0 !important;
          }
          img, svg {
            max-width: 100% !important;
            height: auto !important;
            display: block !important;
            margin: 1.5em auto !important;
            border-radius: 8px !important;
            box-shadow: 0 4px 20px rgba(0,0,0,0.15) !important;
          }
        </style>
      `;

      // Extract new styled page content
      let updatedHtml = doc.documentElement.outerHTML;
      if (updatedHtml.includes('</head>')) {
        updatedHtml = updatedHtml.replace('</head>', `${styleInjection}</head>`);
      } else {
        updatedHtml = `<head>${styleInjection}</head>${updatedHtml}`;
      }

      setPageHtml(updatedHtml);
    } catch (err) {
      console.error('Error loading EPUB page content:', err);
    }
  }, [zip, spineHrefs, currentPage, settings.fontSize, settings.lineHeight, settings.theme, settings.fontFamily]);

  // Load content when dependencies change
  useEffect(() => {
    loadPageContent();
  }, [loadPageContent]);

  // Clean up Object URLs on unmount
  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  // Sync progress to backend
  useEffect(() => {
    if (spineHrefs.length === 0) return;
    const progressZoom = settings.fontSize / 18.0;
    const progressMode = settings.theme;
    
    if (
      currentPage !== book.current_page ||
      Math.abs(progressZoom - book.zoom) > 0.05 ||
      progressMode !== book.view_mode
    ) {
      onUpdateProgress(book.id, {
        current_page: currentPage,
        zoom: progressZoom,
        view_mode: progressMode,
        scroll_position: 0,
        reading_direction: 'ltr',
      });
    }
  }, [currentPage, settings.fontSize, settings.theme, book.id, spineHrefs, onUpdateProgress]);

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

  // Find active chapter title based on current page
  const currentChapterTitle = () => {
    if (spineHrefs.length === 0 || toc.length === 0) return 'Reading';
    const currentPath = spineHrefs[currentPage - 1];
    const matchingTOC = toc.find(item => item.href === currentPath);
    return matchingTOC ? matchingTOC.title : toc[0]?.title || 'Chapter';
  };

  // Add / Remove bookmark for current chapter
  const toggleBookmark = () => {
    const chapterTitle = currentChapterTitle();
    const hasBookmark = bookmarks.some(b => b.chapterIndex === currentPage);
    let updated: BookmarkItem[];

    if (hasBookmark) {
      updated = bookmarks.filter(b => b.chapterIndex !== currentPage);
    } else {
      const newB: BookmarkItem = {
        id: Math.random().toString(),
        chapterIndex: currentPage,
        chapterTitle,
        addedAt: new Date().toLocaleDateString(),
      };
      updated = [...bookmarks, newB];
    }

    setBookmarks(updated);
    localStorage.setItem(`reader_bookmarks_${book.id}`, JSON.stringify(updated));
  };

  // Add new note
  const handleAddNote = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newNote.trim()) return;

    const chapterTitle = currentChapterTitle();
    const nNote: NoteItem = {
      id: Math.random().toString(),
      chapterIndex: currentPage,
      chapterTitle,
      noteText: newNote.trim(),
      addedAt: new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    const updated = [nNote, ...notes];
    setNotes(updated);
    localStorage.setItem(`reader_notes_${book.id}`, JSON.stringify(updated));
    setNewNote('');
  };

  // Delete note
  const handleDeleteNote = (id: string) => {
    const updated = notes.filter(n => n.id !== id);
    setNotes(updated);
    localStorage.setItem(`reader_notes_${book.id}`, JSON.stringify(updated));
  };

  // Search through all book chapters
  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim() || !zip) return;

    setSearchLoading(true);
    const results: SearchResult[] = [];

    try {
      for (let i = 0; i < spineHrefs.length; i++) {
        const path = spineHrefs[i];
        const file = zip.files[path];
        if (file) {
          const text = await file.async('text');
          
          // Simple DOM parser inside search loop to extract text
          const tempDoc = new DOMParser().parseFromString(text, 'text/html');
          const cleanText = tempDoc.body.textContent || tempDoc.body.innerText || '';

          const index = cleanText.toLowerCase().indexOf(searchQuery.toLowerCase());
          if (index !== -1) {
            const start = Math.max(0, index - 30);
            const end = Math.min(cleanText.length, index + searchQuery.length + 30);
            const snippet = cleanText.substring(start, end).replace(/\s+/g, ' ').trim();
            
            // Find title of chapter
            const chTitle = toc.find(item => item.href === path)?.title || `Chapter ${i + 1}`;

            results.push({
              chapterIndex: i + 1,
              chapterTitle: chTitle,
              snippet: `...${snippet}...`
            });
          }
        }
      }
    } catch (err) {
      console.error('Search failed:', err);
    }

    setSearchResults(results);
    setSearchLoading(false);
  };

  const activeTheme = themeStyles[settings.theme];
  const percentComplete = Math.round(((currentPage) / (spineHrefs.length || 1)) * 100);

  return (
    <div 
      style={{ 
        display: 'flex', 
        flex: 1, 
        height: 'calc(100vh - 120px)', 
        position: 'relative', 
        backgroundColor: activeTheme.bg,
        color: activeTheme.text,
        transition: 'all 0.3s ease',
        borderRadius: '16px',
        overflow: 'hidden',
        border: `1px solid ${activeTheme.border}`
      }}
    >
      {/* 1. COLLAPSIBLE SIDEBAR */}
      {isSidebarOpen && (
        <div 
          className="glass-panel"
          style={{ 
            width: '300px', 
            height: '100%', 
            borderRight: `1px solid ${activeTheme.border}`,
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: activeTheme.sidebarBg,
            color: activeTheme.sidebarText,
            zIndex: 10,
            transition: 'all 0.3s ease'
          }}
        >
          {/* Sidebar Tabs */}
          <div style={{ display: 'flex', borderBottom: `1px solid ${activeTheme.border}` }}>
            <button 
              onClick={() => setSidebarTab('toc')} 
              style={{ flex: 1, padding: '12px 6px', fontSize: '0.8rem', fontWeight: 600, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', color: sidebarTab === 'toc' ? 'var(--accent-primary)' : 'inherit' }}
            >
              <BookOpen size={16} /> TOC
            </button>
            <button 
              onClick={() => setSidebarTab('search')} 
              style={{ flex: 1, padding: '12px 6px', fontSize: '0.8rem', fontWeight: 600, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', color: sidebarTab === 'search' ? 'var(--accent-primary)' : 'inherit' }}
            >
              <Search size={16} /> Search
            </button>
            <button 
              onClick={() => setSidebarTab('bookmarks')} 
              style={{ flex: 1, padding: '12px 6px', fontSize: '0.8rem', fontWeight: 600, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', color: sidebarTab === 'bookmarks' ? 'var(--accent-primary)' : 'inherit' }}
            >
              <Bookmark size={16} /> Marks
            </button>
            <button 
              onClick={() => setSidebarTab('notes')} 
              style={{ flex: 1, padding: '12px 6px', fontSize: '0.8rem', fontWeight: 600, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', color: sidebarTab === 'notes' ? 'var(--accent-primary)' : 'inherit' }}
            >
              <Edit size={16} /> Notes
            </button>
          </div>

          {/* Sidebar Content Area */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
            
            {/* TOC PANEL */}
            {sidebarTab === 'toc' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <h3 style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Chapters</h3>
                {toc.map((item, index) => {
                  const spineIndex = spineHrefs.indexOf(item.href) + 1;
                  const isActive = spineIndex === currentPage;
                  return (
                    <button
                      key={index}
                      onClick={() => {
                        if (spineIndex > 0) setCurrentPage(spineIndex);
                      }}
                      style={{
                        textAlign: 'left',
                        padding: '10px 12px',
                        borderRadius: '8px',
                        fontSize: '0.85rem',
                        fontWeight: isActive ? 600 : 400,
                        backgroundColor: isActive ? activeTheme.activeBg : 'transparent',
                        color: isActive ? 'var(--accent-secondary)' : 'inherit',
                        transition: 'background 0.2s',
                        lineHeight: 1.3
                      }}
                      className="hover-highlight"
                    >
                      {item.title}
                    </button>
                  );
                })}
              </div>
            )}

            {/* SEARCH PANEL */}
            {sidebarTab === 'search' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <form onSubmit={handleSearch} style={{ display: 'flex', gap: '6px' }}>
                  <input 
                    type="text" 
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search inside book..." 
                    style={{ flex: 1, padding: '8px 12px', borderRadius: '6px', border: `1px solid ${activeTheme.border}`, backgroundColor: 'rgba(0,0,0,0.05)', color: 'inherit', fontSize: '0.85rem', outline: 'none' }}
                  />
                  <button type="submit" style={{ padding: '8px', backgroundColor: 'var(--accent-primary)', color: '#fff', borderRadius: '6px' }}>
                    <Search size={16} />
                  </button>
                </form>

                {searchLoading ? (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: '20px' }}>
                    <div style={{ width: '24px', height: '24px', borderRadius: '50%', border: '2.5px solid var(--border-glass)', borderTopColor: 'var(--accent-primary)', animation: 'spin 1s linear infinite' }} />
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '8px' }}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{searchResults.length} matches found</span>
                    {searchResults.map((res, i) => (
                      <div 
                        key={i} 
                        onClick={() => setCurrentPage(res.chapterIndex)}
                        style={{ padding: '8px 10px', borderRadius: '6px', backgroundColor: 'rgba(0,0,0,0.02)', border: `1px solid ${activeTheme.border}`, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '4px' }}
                        className="hover-highlight"
                      >
                        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--accent-secondary)' }}>{res.chapterTitle}</span>
                        <p style={{ fontSize: '0.8rem', fontStyle: 'italic', margin: 0, lineHeight: 1.3 }}>{res.snippet}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* BOOKMARKS PANEL */}
            {sidebarTab === 'bookmarks' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <button 
                  onClick={toggleBookmark}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', width: '100%', padding: '10px', borderRadius: '8px', backgroundColor: 'var(--accent-primary)', color: '#fff', fontSize: '0.85rem', fontWeight: 600 }}
                >
                  <Bookmark size={16} fill={bookmarks.some(b => b.chapterIndex === currentPage) ? '#fff' : 'none'} />
                  {bookmarks.some(b => b.chapterIndex === currentPage) ? 'Bookmarked' : 'Add Bookmark'}
                </button>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
                  <h4 style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Saved Bookmarks</h4>
                  {bookmarks.length === 0 ? (
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>No bookmarks added yet.</span>
                  ) : (
                    bookmarks.map((b) => (
                      <div 
                        key={b.id} 
                        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', borderRadius: '6px', backgroundColor: 'rgba(0,0,0,0.02)', border: `1px solid ${activeTheme.border}` }}
                      >
                        <button 
                          onClick={() => setCurrentPage(b.chapterIndex)}
                          style={{ flex: 1, textAlign: 'left', display: 'flex', flexDirection: 'column', gap: '2px' }}
                        >
                          <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>{b.chapterTitle}</span>
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Page {b.chapterIndex} • {b.addedAt}</span>
                        </button>
                        <button 
                          onClick={() => {
                            const updated = bookmarks.filter(bm => bm.id !== b.id);
                            setBookmarks(updated);
                            localStorage.setItem(`reader_bookmarks_${book.id}`, JSON.stringify(updated));
                          }}
                          style={{ color: '#ef4444', padding: '4px' }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* NOTES PANEL */}
            {sidebarTab === 'notes' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <form onSubmit={handleAddNote} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>Chapter Note ({currentChapterTitle()})</span>
                  <textarea 
                    value={newNote}
                    onChange={(e) => setNewNote(e.target.value)}
                    placeholder="Write your note here..." 
                    rows={4}
                    style={{ padding: '8px 12px', borderRadius: '6px', border: `1px solid ${activeTheme.border}`, backgroundColor: 'rgba(0,0,0,0.05)', color: 'inherit', fontSize: '0.85rem', outline: 'none', resize: 'vertical' }}
                  />
                  <button type="submit" style={{ padding: '8px 12px', backgroundColor: 'var(--accent-secondary)', color: '#fff', borderRadius: '6px', fontSize: '0.8rem', fontWeight: 600 }}>
                    Save Note
                  </button>
                </form>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <h4 style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Saved Notes</h4>
                  {notes.length === 0 ? (
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>No notes written yet.</span>
                  ) : (
                    notes.map((n) => (
                      <div 
                        key={n.id} 
                        style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px', borderRadius: '6px', backgroundColor: 'rgba(0,0,0,0.02)', border: `1px solid ${activeTheme.border}` }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <button 
                            onClick={() => setCurrentPage(n.chapterIndex)}
                            style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--accent-primary)', textAlign: 'left' }}
                          >
                            {n.chapterTitle}
                          </button>
                          <button 
                            onClick={() => handleDeleteNote(n.id)}
                            style={{ color: '#ef4444', padding: '2px' }}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                        <p style={{ fontSize: '0.8rem', margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.3 }}>{n.noteText}</p>
                        <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{n.addedAt}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

          </div>
        </div>
      )}

      {/* 2. MAIN READING WORKSPACE */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative', height: '100%' }}>
        
        {/* HEADER BAR */}
        <div 
          className="glass-panel" 
          style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            alignItems: 'center', 
            padding: '12px 24px', 
            borderBottom: `1px solid ${activeTheme.border}`,
            zIndex: 5,
            backgroundColor: activeTheme.cardBg
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <button 
              onClick={() => setIsSidebarOpen(!isSidebarOpen)} 
              style={{ color: 'inherit', padding: '6px', borderRadius: '6px', backgroundColor: 'rgba(255,255,255,0.02)' }}
              title="Toggle Sidebar (☰)"
            >
              {isSidebarOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
            <button onClick={onBack} style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-secondary)', fontSize: '0.85rem' }} className="hover-white">
              <ArrowLeft size={16} /> Back
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, minWidth: 0, maxWidth: '40%', margin: '0 12px' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {book.title}
            </span>
            <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)', maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {currentChapterTitle()}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {/* Search sidebar focus */}
            <button 
              onClick={() => { setIsSidebarOpen(true); setSidebarTab('search'); }}
              style={{ color: 'inherit', padding: '6px' }}
              title="Search Book"
            >
              <Search size={18} />
            </button>

            {/* Quick Cycle Theme */}
            <button 
              onClick={() => {
                const nextTheme = settings.theme === 'light' ? 'sepia' : settings.theme === 'sepia' ? 'dark' : 'light';
                setSettings(prev => ({ ...prev, theme: nextTheme }));
              }}
              style={{ color: 'inherit', padding: '6px' }}
              title="Cycle Theme"
            >
              {settings.theme === 'light' ? <Sun size={18} /> : settings.theme === 'sepia' ? <Eye size={18} /> : <Moon size={18} />}
            </button>

            {/* Bookmark current status */}
            <button 
              onClick={toggleBookmark}
              style={{ color: bookmarks.some(b => b.chapterIndex === currentPage) ? 'var(--accent-primary)' : 'inherit', padding: '6px' }}
              title="Bookmark Chapter"
            >
              <Bookmark size={18} fill={bookmarks.some(b => b.chapterIndex === currentPage) ? 'currentColor' : 'none'} />
            </button>

            {/* Settings toggler */}
            <button 
              onClick={() => setIsSettingsOpen(!isSettingsOpen)}
              style={{ color: isSettingsOpen ? 'var(--accent-secondary)' : 'inherit', padding: '6px' }}
              title="Reader Options (⚙️)"
            >
              <Settings size={18} />
            </button>
          </div>
        </div>

        {/* SETTINGS POP-OVER PANEL */}
        {isSettingsOpen && (
          <div 
            className="glass-panel"
            style={{ 
              position: 'absolute', 
              top: '64px', 
              right: '24px', 
              width: '280px',
              padding: '20px', 
              borderRadius: '12px',
              boxShadow: '0 10px 30px rgba(0,0,0,0.3)',
              backgroundColor: activeTheme.sidebarBg,
              color: activeTheme.sidebarText,
              border: `1px solid ${activeTheme.border}`,
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
              zIndex: 100
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifySelf: 'flex-start', gap: '8px', borderBottom: `1px solid ${activeTheme.border}`, paddingBottom: '8px' }}>
              <Sliders size={16} style={{ color: 'var(--accent-primary)' }} />
              <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Reader Options</span>
            </div>

            {/* Font family */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Font Family</label>
              <div style={{ display: 'flex', gap: '6px' }}>
                {(['literata', 'georgia', 'inter'] as const).map((font) => (
                  <button
                    key={font}
                    onClick={() => setSettings(prev => ({ ...prev, fontFamily: font }))}
                    style={{
                      flex: 1,
                      padding: '6px',
                      borderRadius: '4px',
                      fontSize: '0.75rem',
                      textTransform: 'capitalize',
                      border: `1px solid ${settings.fontFamily === font ? 'var(--accent-primary)' : activeTheme.border}`,
                      backgroundColor: settings.fontFamily === font ? activeTheme.activeBg : 'transparent',
                      color: 'inherit',
                      fontWeight: settings.fontFamily === font ? 600 : 400
                    }}
                  >
                    {font}
                  </button>
                ))}
              </div>
            </div>

            {/* Font size */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Font Size</label>
                <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>{settings.fontSize}px</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button 
                  onClick={() => setSettings(prev => ({ ...prev, fontSize: Math.max(12, prev.fontSize - 1) }))}
                  style={{ color: 'inherit', padding: '4px' }}
                >
                  <ZoomOut size={14} />
                </button>
                <input 
                  type="range" 
                  min="12" 
                  max="36" 
                  value={settings.fontSize}
                  onChange={(e) => setSettings(prev => ({ ...prev, fontSize: parseInt(e.target.value) }))}
                  style={{ flex: 1, accentColor: 'var(--accent-primary)' }}
                />
                <button 
                  onClick={() => setSettings(prev => ({ ...prev, fontSize: Math.min(36, prev.fontSize + 1) }))}
                  style={{ color: 'inherit', padding: '4px' }}
                >
                  <ZoomIn size={14} />
                </button>
              </div>
            </div>

            {/* Line height */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Line Height</label>
                <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>{settings.lineHeight}</span>
              </div>
              <input 
                type="range" 
                min="1.2" 
                max="2.2" 
                step="0.1"
                value={settings.lineHeight}
                onChange={(e) => setSettings(prev => ({ ...prev, lineHeight: parseFloat(e.target.value) }))}
                style={{ width: '100%', accentColor: 'var(--accent-secondary)' }}
              />
            </div>

            {/* Themes */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Reading Theme</label>
              <div style={{ display: 'flex', gap: '6px' }}>
                {(['light', 'sepia', 'dark'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setSettings(prev => ({ ...prev, theme: t }))}
                    style={{
                      flex: 1,
                      padding: '8px',
                      borderRadius: '6px',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      textTransform: 'capitalize',
                      border: `1px solid ${settings.theme === t ? 'var(--accent-secondary)' : activeTheme.border}`,
                      backgroundColor: t === 'light' ? '#ffffff' : t === 'sepia' ? '#FDF6E3' : '#1f2937',
                      color: t === 'light' ? '#1f2937' : t === 'sepia' ? '#5c4636' : '#e5e7eb',
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* READING SURFACE AREA */}
        <div 
          style={{
            flex: 1,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            padding: '24px',
            transition: 'background 0.3s'
          }}
        >
          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', margin: 'auto' }}>
              <div style={{ width: '40px', height: '40px', borderRadius: '50%', border: '3px solid var(--border-glass)', borderTopColor: 'var(--accent-primary)', animation: 'spin 1s linear infinite' }} />
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{loadingText}</p>
            </div>
          ) : (
            <div 
              style={{
                width: '100%',
                maxWidth: '800px',
                flex: 1,
                borderRadius: '12px',
                boxShadow: settings.theme === 'dark' ? '0 10px 40px rgba(0,0,0,0.5)' : '0 10px 40px rgba(0,0,0,0.08)',
                overflow: 'hidden',
                border: `1px solid ${activeTheme.border}`,
                backgroundColor: activeTheme.cardBg,
                transition: 'background-color 0.3s, border 0.3s',
                display: 'flex',
                flexDirection: 'column'
              }}
            >
              <iframe 
                ref={iframeRef} 
                srcDoc={pageHtml}
                style={{ 
                  width: '100%',
                  flex: 1,
                  border: 'none',
                  backgroundColor: 'transparent'
                }}
                title="EPUB Content Canvas"
              />
            </div>
          )}
        </div>

        {/* BOTTOM NAVIGATION / PROGRESS BAR */}
        {!loading && (
          <div 
            className="glass-panel" 
            style={{ 
              display: 'flex', 
              justifyContent: 'space-between', 
              alignItems: 'center', 
              padding: '12px 24px', 
              borderTop: `1px solid ${activeTheme.border}`,
              backgroundColor: activeTheme.cardBg,
              zIndex: 5
            }}
          >
            {/* Previous */}
            <button 
              onClick={handlePrevPage} 
              disabled={currentPage <= 1}
              style={{ 
                color: currentPage <= 1 ? 'var(--text-muted)' : 'inherit', 
                padding: '8px 16px', 
                borderRadius: '8px', 
                backgroundColor: 'rgba(0,0,0,0.02)',
                fontSize: '0.85rem',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                border: `1px solid ${activeTheme.border}`
              }}
              className="hover-highlight"
            >
              <ChevronLeft size={16} /> Prev
            </button>

            {/* Custom progress percentage and bar slider */}
            <div style={{ flex: 1, maxWidth: '480px', display: 'flex', alignItems: 'center', gap: '16px', margin: '0 24px' }}>
              <div 
                style={{ 
                  flex: 1, 
                  height: '6px', 
                  borderRadius: '3px', 
                  backgroundColor: 'rgba(0,0,0,0.1)', 
                  position: 'relative',
                  overflow: 'hidden',
                  background: settings.theme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'
                }}
              >
                <div 
                  style={{ 
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    height: '100%',
                    width: `${percentComplete}%`,
                    backgroundColor: 'var(--accent-primary)',
                    transition: 'width 0.3s ease'
                  }}
                />
              </div>
              <span style={{ fontSize: '0.8rem', fontWeight: 600, width: '70px', textAlign: 'right', color: 'var(--text-secondary)' }}>
                {currentPage} / {spineHrefs.length} ({percentComplete}%)
              </span>
            </div>

            {/* Next */}
            <button 
              onClick={handleNextPage} 
              disabled={currentPage >= spineHrefs.length}
              style={{ 
                color: currentPage >= spineHrefs.length ? 'var(--text-muted)' : 'inherit', 
                padding: '8px 16px', 
                borderRadius: '8px', 
                backgroundColor: 'rgba(0,0,0,0.02)',
                fontSize: '0.85rem',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                border: `1px solid ${activeTheme.border}`
              }}
              className="hover-highlight"
            >
              Next <ChevronRight size={16} />
            </button>
          </div>
        )}

      </div>

      <style>{`
        .hover-white:hover { color: #fff !important; }
        .hover-highlight:hover {
          background-color: ${activeTheme.activeBg} !important;
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

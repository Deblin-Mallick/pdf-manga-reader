import React, { useState, useEffect, useRef, useCallback } from 'react';
import JSZip from 'jszip';
import { Book, User } from '../App';
import { Avatar, Badge, Button, IconButton, Select, Tabs, ToggleGroup } from '../ui';
import * as SubframeCore from "@subframe/core";
import {
  FeatherAlignHorizontalSpaceAround,
  FeatherAlignJustify,
  FeatherArrowLeft,
  FeatherBookmark,
  FeatherBookOpen,
  FeatherChevronLeft,
  FeatherChevronRight,
  FeatherList,
  FeatherMessageSquare,
  FeatherMinus,
  FeatherPanelLeftClose,
  FeatherPlus,
  FeatherRows,
  FeatherSearch,
  FeatherStretchVertical,
  FeatherType,
} from "@subframe/core";

interface EPUBReaderProps {
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

interface TOCItem {
  title: string;
  href: string;
}

interface ReaderSettings {
  fontSize: number;       // font size in px
  lineHeight: 'tight' | 'relaxed' | 'loose';
  theme: 'light' | 'dark' | 'sepia';
  fontFamily: 'Literata' | 'Georgia' | 'Merriweather' | 'System Sans';
  margin: 'narrow' | 'medium' | 'wide';
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
  user,
  token,
  onBack,
  onUpdateProgress,
}: EPUBReaderProps) {
  const localKey = `reader_prefs_${book.id}`;
  const savedPrefs = (() => { try { return JSON.parse(localStorage.getItem(localKey) || '{}'); } catch { return {}; } })();

  const [zip, setZip] = useState<JSZip | null>(null);
  const [spineHrefs, setSpineHrefs] = useState<string[]>([]);
  const [toc, setToc] = useState<TOCItem[]>([]);
  const [currentPage, setCurrentPage] = useState(book.current_page || 1);
  const [pageHtml, setPageHtml] = useState<string>('');
  
  const [settings, setSettings] = useState<ReaderSettings>({
    fontSize: savedPrefs.fontSize ?? (book.zoom ? Math.round(book.zoom * 18) : 18),
    lineHeight: savedPrefs.lineHeight ?? 'relaxed',
    theme: savedPrefs.theme ?? (
      book.view_mode === 'dark' || book.view_mode === 'sepia' || book.view_mode === 'light'
        ? book.view_mode
        : 'dark'
    ),
    fontFamily: savedPrefs.fontFamily ?? 'Literata',
    margin: savedPrefs.margin ?? 'medium',
  });

  const [loading, setLoading] = useState<boolean>(true);
  const [loadingText, setLoadingText] = useState<string>('Downloading EPUB...');
  
  // Collapsible Sidebar & Tabs
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);
  const [sidebarTab, setSidebarTab] = useState<'toc' | 'search' | 'bookmarks' | 'notes'>('toc');
  
  // Bookmarks, Notes, Search states
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>([]);
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [newNote, setNewNote] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState<boolean>(false);

  // Persist all reader settings to localStorage on change
  useEffect(() => {
    localStorage.setItem(localKey, JSON.stringify(settings));
  }, [settings, localKey]);

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
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);

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
        onBackRef.current();
      }
    };

    loadEpub();

    return () => {
      isMounted = false;
    };
  }, [book.id, token]);

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
      blobUrlsRef.current.forEach((url: string) => URL.revokeObjectURL(url));
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
      let fontStack = "";
      if (settings.fontFamily === 'Literata') {
        fontStack = "'Literata', Georgia, serif";
      } else if (settings.fontFamily === 'Georgia') {
        fontStack = "Georgia, serif";
      } else if (settings.fontFamily === 'Merriweather') {
        fontStack = "'Merriweather', serif";
      } else {
        fontStack = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
      }

      const googleFonts = `<link href="https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,200..900;1,7..72,200..900&family=Merriweather:ital,wght@0,300;0,400;0,700;1,300&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">`;

      const lineHeightVal = settings.lineHeight === 'tight' ? 1.3 : settings.lineHeight === 'loose' ? 2.0 : 1.6;
      
      const marginPadding = settings.margin === 'narrow' 
        ? '40px 20px 100px 20px' 
        : settings.margin === 'wide' 
          ? '40px 120px 100px 120px' 
          : '40px 60px 100px 60px';
      
      const maxWidth = settings.margin === 'narrow' 
        ? '800px' 
        : settings.margin === 'wide' 
          ? '600px' 
          : '700px';

      const styleInjection = `
        ${googleFonts}
        <style>
          body {
            background-color: ${activeTheme.cardBg} !important;
            color: ${activeTheme.text} !important;
            font-family: ${fontStack} !important;
            font-size: ${settings.fontSize}px !important;
            line-height: ${lineHeightVal} !important;
            padding: ${marginPadding} !important;
            margin: 0 auto !important;
            max-width: ${maxWidth} !important;
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
  }, [zip, spineHrefs, currentPage, settings.fontSize, settings.lineHeight, settings.theme, settings.fontFamily, settings.margin]);

  // Load content when dependencies change
  useEffect(() => {
    loadPageContent();
  }, [loadPageContent]);

  // Clean up Object URLs on unmount
  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach((url: string) => URL.revokeObjectURL(url));
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
      setCurrentPage((prev: number) => prev + 1);
    }
  }, [currentPage, spineHrefs.length]);

  const handlePrevPage = useCallback(() => {
    if (currentPage > 1) {
      setCurrentPage((prev: number) => prev - 1);
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
    const matchingTOC = toc.find((item: TOCItem) => item.href === currentPath);
    return matchingTOC ? matchingTOC.title : toc[0]?.title || 'Chapter';
  };

  // Add / Remove bookmark for current chapter
  const toggleBookmark = () => {
    const chapterTitle = currentChapterTitle();
    const hasBookmark = bookmarks.some((b: BookmarkItem) => b.chapterIndex === currentPage);
    let updated: BookmarkItem[];

    if (hasBookmark) {
      updated = bookmarks.filter((b: BookmarkItem) => b.chapterIndex !== currentPage);
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
    const updated = notes.filter((n: NoteItem) => n.id !== id);
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
          
          const tempDoc = new DOMParser().parseFromString(text, 'text/html');
          const cleanText = tempDoc.body.textContent || tempDoc.body.innerText || '';

          const index = cleanText.toLowerCase().indexOf(searchQuery.toLowerCase());
          if (index !== -1) {
            const start = Math.max(0, index - 30);
            const end = Math.min(cleanText.length, index + searchQuery.length + 30);
            const snippet = cleanText.substring(start, end).replace(/\s+/g, ' ').trim();
            
            const chTitle = toc.find((item: TOCItem) => item.href === path)?.title || `Chapter ${i + 1}`;

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

  const handleIframeLoad = () => {};

  const activeTheme = themeStyles[settings.theme];
  const percentComplete = Math.round(((currentPage) / (spineHrefs.length || 1)) * 100);

  return (
    <div 
      className="flex h-full w-full items-start"
      style={{
        backgroundColor: activeTheme.bg,
        color: activeTheme.text,
        transition: 'all 0.3s ease'
      }}
    >
      {/* LEFT SIDEBAR */}
      {isSidebarOpen && (
        <div 
          className="flex w-72 flex-none flex-col items-start self-stretch border-r border-solid mobile:hidden"
          style={{
            backgroundColor: activeTheme.sidebarBg,
            borderColor: activeTheme.border,
            color: activeTheme.sidebarText,
            transition: 'all 0.3s ease'
          }}
        >
          <div className="flex w-full items-center gap-2 border-b border-solid px-4 py-3" style={{ borderColor: activeTheme.border }}>
            <FeatherBookOpen className="text-heading-3 font-heading-3 text-brand-600" />
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
            <Tabs.Item active={sidebarTab === 'toc'} icon={<FeatherList />} onClick={() => setSidebarTab('toc')}>
              TOC
            </Tabs.Item>
            <Tabs.Item active={sidebarTab === 'search'} icon={<FeatherSearch />} onClick={() => setSidebarTab('search')}>
              Search
            </Tabs.Item>
            <Tabs.Item active={sidebarTab === 'bookmarks'} icon={<FeatherBookmark />} onClick={() => setSidebarTab('bookmarks')}>
              Bookmarks
            </Tabs.Item>
            <Tabs.Item active={sidebarTab === 'notes'} icon={<FeatherMessageSquare />} onClick={() => setSidebarTab('notes')}>
              Notes
            </Tabs.Item>
          </Tabs>

          {/* TOC PANEL */}
          {sidebarTab === 'toc' && (
            <div className="flex w-full grow shrink-0 basis-0 flex-col items-start gap-1 px-2 py-3 overflow-auto">
              <span className="text-caption-bold font-caption-bold text-subtext-color px-2 py-1">
                CONTENTS
              </span>
              {toc.map((item, index) => {
                const spineIndex = spineHrefs.indexOf(item.href) + 1;
                const isActive = spineIndex === currentPage;
                return (
                  <div
                    key={index}
                    onClick={() => {
                      if (spineIndex > 0) setCurrentPage(spineIndex);
                    }}
                    className={`flex w-full items-center gap-3 rounded-md px-3 py-2 cursor-pointer transition-all ${
                      isActive
                        ? "border-l-2 border-solid border-brand-600 bg-brand-50"
                        : "hover:bg-neutral-100"
                    }`}
                  >
                    <span className={`w-5 flex-none text-caption ${isActive ? "font-caption-bold text-brand-700" : "text-subtext-color"}`}>
                      {index + 1}
                    </span>
                    <span className={`grow shrink-0 basis-0 text-body ${isActive ? "font-body-bold text-brand-700" : "text-subtext-color"}`}
                          style={isActive ? { color: 'var(--color-brand-600)' } : undefined}>
                      {item.title}
                    </span>
                    {isActive && (
                      <Badge variant="brand" icon={null}>
                        Active
                      </Badge>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* SEARCH PANEL */}
          {sidebarTab === 'search' && (
            <div className="flex w-full grow shrink-0 basis-0 flex-col items-start gap-3 px-3 py-3 overflow-auto">
              <span className="text-caption-bold font-caption-bold text-subtext-color px-1">
                SEARCH INSIDE BOOK
              </span>
              <form onSubmit={handleSearch} className="flex w-full items-center gap-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search text..."
                  className="grow rounded-md border border-solid border-neutral-border bg-neutral-0 px-3 py-1.5 text-body font-body text-default-font focus:outline-none focus:ring-1 focus:ring-brand-600"
                  style={{
                    backgroundColor: activeTheme.cardBg,
                    borderColor: activeTheme.border,
                    color: activeTheme.text
                  }}
                />
                <Button type="submit" variant="brand-primary" icon={<FeatherSearch />} className="px-3" />
              </form>
              {searchLoading ? (
                <div className="flex w-full justify-center py-4">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-solid border-brand-200 border-t-brand-600" />
                </div>
              ) : (
                <div className="flex w-full flex-col gap-2">
                  <span className="text-caption font-caption text-subtext-color px-1">
                    {searchResults.length} matches found
                  </span>
                  {searchResults.map((res, i) => (
                    <div
                      key={i}
                      onClick={() => setCurrentPage(res.chapterIndex)}
                      className="flex w-full flex-col items-start gap-1 rounded-md border border-solid p-3 cursor-pointer hover:bg-neutral-100 transition-all"
                      style={{
                        borderColor: activeTheme.border,
                        backgroundColor: activeTheme.cardBg
                      }}
                    >
                      <span className="text-caption-bold font-caption-bold text-brand-700">
                        {res.chapterTitle}
                      </span>
                      <span className="text-caption font-caption text-default-font italic line-clamp-3">
                        {res.snippet}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* BOOKMARKS PANEL */}
          {sidebarTab === 'bookmarks' && (
            <div className="flex w-full grow shrink-0 basis-0 flex-col items-start gap-3 px-3 py-3 overflow-auto">
              <span className="text-caption-bold font-caption-bold text-subtext-color px-1">
                BOOKMARKS
              </span>
              <Button
                variant="brand-secondary"
                icon={<FeatherBookmark />}
                onClick={toggleBookmark}
                className="w-full justify-center"
              >
                {bookmarks.some(b => b.chapterIndex === currentPage) ? "Remove Bookmark" : "Add Bookmark"}
              </Button>
              <div className="flex w-full flex-col gap-2 mt-2">
                <span className="text-caption-bold font-caption-bold text-subtext-color px-1">
                  SAVED BOOKMARKS
                </span>
                {bookmarks.length === 0 ? (
                  <span className="text-body font-body text-subtext-color px-1 italic">
                    No bookmarks added yet.
                  </span>
                ) : (
                  bookmarks.map((b) => (
                    <div
                      key={b.id}
                      className="flex w-full items-center justify-between gap-2 rounded-md border border-solid p-3 hover:bg-neutral-100 transition-all"
                      style={{
                        borderColor: activeTheme.border,
                        backgroundColor: activeTheme.cardBg
                      }}
                    >
                      <div
                        onClick={() => setCurrentPage(b.chapterIndex)}
                        className="flex grow flex-col items-start gap-1 cursor-pointer"
                      >
                        <span className="text-caption-bold font-caption-bold text-default-font" style={{ color: activeTheme.heading }}>
                          {b.chapterTitle}
                        </span>
                        <span className="text-caption font-caption text-subtext-color">
                          Page {b.chapterIndex} • {b.addedAt}
                        </span>
                      </div>
                      <IconButton
                        variant="destructive-tertiary"
                        icon={<FeatherMinus />}
                        onClick={() => {
                          const updated = bookmarks.filter(bm => bm.id !== b.id);
                          setBookmarks(updated);
                          localStorage.setItem(`reader_bookmarks_${book.id}`, JSON.stringify(updated));
                        }}
                      />
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* NOTES PANEL */}
          {sidebarTab === 'notes' && (
            <div className="flex w-full grow shrink-0 basis-0 flex-col items-start gap-3 px-3 py-3 overflow-auto">
              <span className="text-caption-bold font-caption-bold text-subtext-color px-1">
                CHAPTER NOTES
              </span>
              <form onSubmit={handleAddNote} className="flex w-full flex-col gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Write note for current chapter..."
                  className="w-full rounded-md border border-solid border-neutral-border bg-neutral-0 px-3 py-2 text-body font-body text-default-font focus:outline-none focus:ring-1 focus:ring-brand-600 resize-none"
                  style={{
                    backgroundColor: activeTheme.cardBg,
                    borderColor: activeTheme.border,
                    color: activeTheme.text
                  }}
                  rows={3}
                />
                <Button type="submit" variant="brand-secondary" className="w-full justify-center">
                  Save Note
                </Button>
              </form>
              <div className="flex w-full flex-col gap-2 mt-2">
                <span className="text-caption-bold font-caption-bold text-subtext-color px-1">
                  SAVED NOTES
                </span>
                {notes.length === 0 ? (
                  <span className="text-body font-body text-subtext-color px-1 italic">
                    No notes written yet.
                  </span>
                ) : (
                  notes.map((n) => (
                    <div
                      key={n.id}
                      className="flex w-full flex-col items-start gap-1 rounded-md border border-solid p-3 hover:bg-neutral-100 transition-all"
                      style={{
                        borderColor: activeTheme.border,
                        backgroundColor: activeTheme.cardBg
                      }}
                    >
                      <div className="flex w-full items-center justify-between">
                        <span
                          onClick={() => setCurrentPage(n.chapterIndex)}
                          className="text-caption-bold font-caption-bold text-brand-700 cursor-pointer"
                        >
                          {n.chapterTitle}
                        </span>
                        <IconButton
                          variant="destructive-tertiary"
                          icon={<FeatherMinus />}
                          onClick={() => handleDeleteNote(n.id)}
                        />
                      </div>
                      <span className="text-caption font-caption text-default-font whitespace-pre-wrap">
                        {n.noteText}
                      </span>
                      <span className="text-caption font-caption text-subtext-color mt-1">
                        {n.addedAt}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* USER AVATAR / PROFILE FOOTER IN SIDEBAR */}
          <div className="flex w-full items-center gap-3 border-t border-solid px-4 py-3" style={{ borderColor: activeTheme.border }}>
            <Avatar size="small" image={user?.picture || undefined}>
              {user?.name ? user.name[0].toUpperCase() : 'G'}
            </Avatar>
            <div className="flex grow shrink-0 basis-0 flex-col items-start">
              <span className="text-caption-bold font-caption-bold text-default-font" style={{ color: activeTheme.heading }}>
                {user?.name || 'Guest User'}
              </span>
              <span className="text-caption font-caption text-subtext-color">
                {user?.email || 'Guest Session'}
              </span>
            </div>
          </div>
        </div>
      )}

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
          {!isSidebarOpen && (
            <IconButton
              variant="neutral-tertiary"
              icon={<FeatherList />}
              onClick={() => setIsSidebarOpen(true)}
            />
          )}
          <div className="flex h-6 w-px flex-none flex-col items-start bg-neutral-border mobile:hidden" style={{ backgroundColor: activeTheme.border }} />
          <div className="flex min-w-[0px] grow shrink-0 basis-0 flex-col items-start">
            <span className="line-clamp-1 w-full text-body-bold font-body-bold text-default-font" style={{ color: activeTheme.heading }}>
              {book.title}
            </span>
            <span className="line-clamp-1 w-full text-caption font-caption text-subtext-color">
              EPUB Document
            </span>
          </div>

          <div className="flex items-center gap-1">
            <IconButton
              variant="neutral-tertiary"
              icon={<FeatherSearch />}
              onClick={() => {
                setIsSidebarOpen(true);
                setSidebarTab('search');
              }}
            />
            <IconButton
              variant="neutral-tertiary"
              icon={<FeatherBookmark />}
              style={bookmarks.some(b => b.chapterIndex === currentPage) ? { color: 'var(--color-brand-600)' } : undefined}
              onClick={toggleBookmark}
            />

            {/* Typography Dropdown Menu */}
            <SubframeCore.DropdownMenu.Root>
              <SubframeCore.DropdownMenu.Trigger asChild>
                <Button
                  variant="neutral-secondary"
                  icon={<FeatherType />}
                >
                  Aa
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
                      backgroundColor: settings.theme === 'light' ? '#ffffff' : settings.theme === 'sepia' ? '#FDF6E3' : '#1e293b',
                      borderColor: settings.theme === 'light' ? '#e2e8f0' : settings.theme === 'sepia' ? '#e4dcc4' : '#334155',
                      color: settings.theme === 'light' ? '#1f2937' : settings.theme === 'sepia' ? '#5C4636' : '#f8fafc',
                    }}
                  >
                    {/* FONT FAMILY */}
                    <div className="flex w-full flex-col items-start gap-1.5">
                      <span className="text-caption-bold font-caption-bold text-subtext-color" style={{ color: settings.theme === 'light' ? '#64748b' : settings.theme === 'sepia' ? '#8c7662' : '#94a3b8' }}>
                        FONT FAMILY
                      </span>
                      <Select
                        className="h-auto w-full flex-none"
                        variant="filled"
                        placeholder="Select font"
                        value={settings.fontFamily}
                        onValueChange={(value: string) => {
                          setSettings(prev => ({ ...prev, fontFamily: value as any }));
                        }}
                      >
                        <Select.Item value="Literata">Literata</Select.Item>
                        <Select.Item value="Georgia">Georgia</Select.Item>
                        <Select.Item value="Merriweather">Merriweather</Select.Item>
                        <Select.Item value="System Sans">System Sans</Select.Item>
                      </Select>
                    </div>

                    {/* FONT SIZE */}
                    <div className="flex w-full flex-col items-start gap-1.5">
                      <span className="text-caption-bold font-caption-bold text-subtext-color" style={{ color: settings.theme === 'light' ? '#64748b' : settings.theme === 'sepia' ? '#8c7662' : '#94a3b8' }}>
                        FONT SIZE
                      </span>
                      <div className="flex w-full items-center justify-between rounded-md px-2 py-1.5"
                           style={{ backgroundColor: settings.theme === 'light' ? '#f1f5f9' : settings.theme === 'sepia' ? '#f4ecd8' : '#0f172a' }}>
                        <IconButton
                          variant="neutral-tertiary"
                          size="small"
                          icon={<FeatherMinus />}
                          onClick={() => {
                            setSettings(prev => ({ ...prev, fontSize: Math.max(12, prev.fontSize - 1) }));
                          }}
                        />
                        <span className="text-body-bold font-body-bold text-default-font" style={{ color: settings.theme === 'light' ? '#1f2937' : settings.theme === 'sepia' ? '#5C4636' : '#f8fafc' }}>
                          {settings.fontSize} px
                        </span>
                        <IconButton
                          variant="neutral-tertiary"
                          size="small"
                          icon={<FeatherPlus />}
                          onClick={() => {
                            setSettings(prev => ({ ...prev, fontSize: Math.min(36, prev.fontSize + 1) }));
                          }}
                        />
                      </div>
                    </div>

                    {/* LINE SPACING */}
                    <div className="flex w-full flex-col items-start gap-1.5">
                      <span className="text-caption-bold font-caption-bold text-subtext-color" style={{ color: settings.theme === 'light' ? '#64748b' : settings.theme === 'sepia' ? '#8c7662' : '#94a3b8' }}>
                        LINE SPACING
                      </span>
                      <ToggleGroup
                        className="h-auto w-full flex-none"
                        value={settings.lineHeight}
                        onValueChange={(value: string) => {
                          if (value) setSettings(prev => ({ ...prev, lineHeight: value as any }));
                        }}
                      >
                        <ToggleGroup.Item icon={<FeatherAlignJustify />} value="tight">Tight</ToggleGroup.Item>
                        <ToggleGroup.Item icon={<FeatherRows />} value="relaxed">Relaxed</ToggleGroup.Item>
                        <ToggleGroup.Item icon={<FeatherStretchVertical />} value="loose">Loose</ToggleGroup.Item>
                      </ToggleGroup>
                    </div>

                    {/* MARGINS */}
                    <div className="flex w-full flex-col items-start gap-1.5">
                      <span className="text-caption-bold font-caption-bold text-subtext-color" style={{ color: settings.theme === 'light' ? '#64748b' : settings.theme === 'sepia' ? '#8c7662' : '#94a3b8' }}>
                        MARGINS
                      </span>
                      <ToggleGroup
                        className="h-auto w-full flex-none"
                        value={settings.margin}
                        onValueChange={(value: string) => {
                          if (value) setSettings(prev => ({ ...prev, margin: value as any }));
                        }}
                      >
                        <ToggleGroup.Item icon={<FeatherAlignHorizontalSpaceAround />} value="narrow">Narrow</ToggleGroup.Item>
                        <ToggleGroup.Item icon={<FeatherAlignHorizontalSpaceAround />} value="medium">Medium</ToggleGroup.Item>
                        <ToggleGroup.Item icon={<FeatherAlignHorizontalSpaceAround />} value="wide">Wide</ToggleGroup.Item>
                      </ToggleGroup>
                    </div>

                    <div className="flex h-px w-full flex-none items-start bg-neutral-200" style={{ backgroundColor: settings.theme === 'light' ? '#e2e8f0' : settings.theme === 'sepia' ? '#e4dcc4' : '#334155' }} />

                    {/* THEME */}
                    <div className="flex w-full items-center justify-between">
                      <span className="text-caption-bold font-caption-bold text-subtext-color" style={{ color: settings.theme === 'light' ? '#64748b' : settings.theme === 'sepia' ? '#8c7662' : '#94a3b8' }}>
                        THEME
                      </span>
                      <div className="flex items-center gap-2">
                        <button 
                          onClick={() => setSettings(prev => ({ ...prev, theme: 'dark' }))}
                          className={`flex h-7 w-7 flex-none items-center justify-center rounded-full bg-slate-900 border border-solid border-slate-700 cursor-pointer ${settings.theme === 'dark' ? 'ring-2 ring-brand-600 ring-offset-1 ring-offset-slate-900' : ''}`}
                        >
                          <span className="text-caption-bold font-caption-bold text-slate-100">
                            A
                          </span>
                        </button>
                        <button 
                          onClick={() => setSettings(prev => ({ ...prev, theme: 'sepia' }))}
                          className={`flex h-7 w-7 flex-none items-center justify-center rounded-full bg-[#f5ecd8] border border-solid border-[#d7cbaf] cursor-pointer ${settings.theme === 'sepia' ? 'ring-2 ring-brand-600 ring-offset-1 ring-offset-neutral-100' : ''}`}
                        >
                          <span className="text-caption-bold font-caption-bold text-[#5b4a2f]">
                            A
                          </span>
                        </button>
                        <button 
                          onClick={() => setSettings(prev => ({ ...prev, theme: 'light' }))}
                          className={`flex h-7 w-7 flex-none items-center justify-center rounded-full bg-white border border-solid border-neutral-300 cursor-pointer ${settings.theme === 'light' ? 'ring-2 ring-brand-600 ring-offset-1 ring-offset-neutral-100' : ''}`}
                        >
                          <span className="text-caption-bold font-caption-bold text-neutral-900">
                            A
                          </span>
                        </button>
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
            className="flex w-full grow flex-col items-center justify-center rounded-xl border border-solid shadow-md overflow-hidden"
            style={{
              borderColor: activeTheme.border,
              backgroundColor: activeTheme.cardBg,
              width: '100%',
              maxWidth: '96%',
              height: '100%',
              transition: 'all 0.3s ease'
            }}
          >
            {loading ? (
              <div className="flex flex-col items-center gap-4">
                <div className="h-10 w-10 animate-spin rounded-full border-3 border-solid border-brand-200 border-t-brand-600" />
                <p className="text-body font-body text-subtext-color">{loadingText}</p>
              </div>
            ) : (
              <iframe
                ref={iframeRef}
                srcDoc={pageHtml}
                onLoad={handleIframeLoad}
                className="w-full h-full border-none bg-transparent"
                title="EPUB Content Canvas"
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
                onClick={handlePrevPage}
              />
              <div className="flex grow shrink-0 basis-0 flex-col items-center gap-2">
                <div className="flex w-full items-center justify-between">
                  <span className="line-clamp-1 text-caption-bold font-caption-bold text-default-font" style={{ color: activeTheme.heading }}>
                    {currentChapterTitle()}
                  </span>
                  <span className="text-caption font-caption text-subtext-color">
                    Page {currentPage} of {spineHrefs.length} ({percentComplete}%)
                  </span>
                </div>
                <div 
                  onClick={(e) => {
                    if (spineHrefs.length === 0) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const clickX = e.clientX - rect.left;
                    const percentage = clickX / rect.width;
                    const targetPage = Math.max(1, Math.min(spineHrefs.length, Math.round(percentage * spineHrefs.length)));
                    setCurrentPage(targetPage);
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
                disabled={currentPage >= spineHrefs.length}
                onClick={handleNextPage}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

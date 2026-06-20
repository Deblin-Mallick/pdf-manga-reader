import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import JSZip from 'jszip';
import { RefreshCw, Trash2 } from 'lucide-react';
import * as SubframeCore from '@subframe/core';
import { Book as BookType, User } from '../App';
import { Avatar } from '@/ui/components/Avatar';
import { Badge } from '@/ui/components/Badge';
import { Button } from '@/ui/components/Button';
import { IconButton } from '@/ui/components/IconButton';
import { Progress } from '@/ui/components/Progress';
import { Select } from '@/ui/components/Select';
import { TextField } from '@/ui/components/TextField';
import { ToggleGroup } from '@/ui/components/ToggleGroup';
import {
  FeatherArrowRight,
  FeatherBell,
  FeatherBook,
  FeatherBookOpen,
  FeatherBookOpenCheck,
  FeatherClock,
  FeatherFiles,
  FeatherGrid,
  FeatherHeart,
  FeatherLayout,
  FeatherList,
  FeatherMenu,
  FeatherPlay,
  FeatherSearch,
  FeatherSettings,
  FeatherTrendingUp,
  FeatherUploadCloud,
} from '@subframe/core';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';

interface DashboardProps {
  books: BookType[];
  user: User | null;
  token: string | null;
  googleClientId: string;
  onSelectBook: (book: BookType) => void;
  onUploadSuccess: (book: BookType) => void;
  onDeleteBook: (bookId: string) => void;
  onConvertBook: (bookId: string) => void;
  onInitGoogleAuth: () => void;
  onSignOut?: () => void;
}

type SortMode = 'recent' | 'title' | 'progress' | 'added';
type ViewMode = 'grid' | 'list';

function progressFor(book: BookType) {
  if (!book.total_pages) return 0;
  return Math.min(100, Math.round((book.current_page / book.total_pages) * 100));
}

function formatRelativeDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not read yet';
  const diff = Date.now() - date.getTime();
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function typeColor(type: string) {
  if (type === 'epub') return 'text-emerald-400 bg-emerald-400/10';
  if (type === 'pdf') return 'text-blue-400 bg-blue-400/10';
  return 'text-orange-400 bg-orange-400/10';
}

function Cover({ book, className }: { book: BookType; className: string }) {
  if (book.cover_path) {
    return (
      <img
        className={`${className} border border-white/10 shadow-[0_8px_32px_0_rgba(0,0,0,0.4)] transition-all duration-300 group-hover:scale-[1.03] group-hover:shadow-[0_12px_40px_0_rgba(139,92,246,0.2)] group-hover:border-purple-500/40`}
        src={book.cover_path}
        alt={`${book.title} cover`}
      />
    );
  }

  const colors: Record<string, string> = {
    pdf: 'from-blue-950/60 via-neutral-950 to-blue-900/20',
    epub: 'from-emerald-950/60 via-neutral-950 to-emerald-900/20',
    cbz: 'from-orange-950/60 via-neutral-950 to-orange-900/20',
    zip: 'from-orange-950/60 via-neutral-950 to-orange-900/20',
  };
  const iconColors: Record<string, string> = {
    pdf: 'text-blue-400/70',
    epub: 'text-emerald-400/70',
    cbz: 'text-orange-400/70',
    zip: 'text-orange-400/70',
  };

  return (
    <div
      className={`${className} flex flex-col items-center justify-center gap-2 bg-gradient-to-br ${colors[book.type] || colors.pdf} border border-white/8 shadow-[0_8px_32px_0_rgba(0,0,0,0.4)] transition-all duration-300 group-hover:scale-[1.03] group-hover:shadow-[0_12px_40px_0_rgba(139,92,246,0.2)] group-hover:border-purple-500/30`}
    >
      <FeatherBookOpen className={`text-heading-1 font-heading-1 ${iconColors[book.type] || iconColors.pdf}`} />
      <span className="text-[10px] font-bold uppercase tracking-widest text-white/20 px-2 text-center line-clamp-2">{book.title}</span>
    </div>
  );
}

function RailItem({ icon, label, active = false, badge, onClick }: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  badge?: number;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`relative flex h-10 w-10 items-center justify-center rounded-xl transition-all duration-200 ${
        active
          ? 'bg-purple-500/15 text-purple-400 border border-purple-500/25 shadow-[0_0_16px_rgba(139,92,246,0.25)]'
          : 'text-neutral-500 hover:bg-white/5 hover:text-neutral-200'
      }`}
    >
      {icon}
      {badge ? (
        <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-purple-500 px-1 text-[9px] font-bold text-white shadow-[0_0_8px_rgba(139,92,246,0.6)]">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

export default function Dashboard({
  books,
  user,
  token,
  googleClientId,
  onSelectBook,
  onUploadSuccess,
  onDeleteBook,
  onConvertBook,
  onInitGoogleAuth,
  onSignOut,
}: DashboardProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [uploadStatus, setUploadStatus] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [convertToEpub, setConvertToEpub] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const displayName = user?.name?.split(' ')[0] || 'Reader';

  type TabMode = 'dashboard' | 'library' | 'in-progress' | 'completed' | 'favorites' | 'uploads';
  const [activeTab, setActiveTab] = useState<TabMode>('dashboard');
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const [favorites, setFavorites] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem('reader_favorites');
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  const toggleFavorite = (bookId: string) => {
    const newFavs = { ...favorites, [bookId]: !favorites[bookId] };
    setFavorites(newFavs);
    localStorage.setItem('reader_favorites', JSON.stringify(newFavs));
  };

  const inProgress = useMemo(
    () => books.filter((book) => book.current_page > 0 && progressFor(book) < 100),
    [books],
  );
  const completed = useMemo(() => books.filter((book) => progressFor(book) >= 100), [books]);

  const filteredBooks = useMemo(() => {
    let list = books;
    if (activeTab === 'in-progress') {
      list = inProgress;
    } else if (activeTab === 'completed') {
      list = completed;
    } else if (activeTab === 'favorites') {
      list = books.filter((book) => favorites[book.id]);
    }
    return list;
  }, [books, activeTab, inProgress, completed, favorites]);

  const visibleBooks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const filtered = filteredBooks.filter((book) => book.title.toLowerCase().includes(query));
    return [...filtered].sort((a, b) => {
      if (sortMode === 'title') return a.title.localeCompare(b.title);
      if (sortMode === 'progress') return progressFor(b) - progressFor(a);
      if (sortMode === 'added') return new Date(b.added_at).getTime() - new Date(a.added_at).getTime();
      return new Date(b.last_read_at).getTime() - new Date(a.last_read_at).getTime();
    });
  }, [filteredBooks, searchQuery, sortMode]);

  const resumeBook = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const candidates = inProgress.filter(
      (book) => !query || book.title.toLowerCase().includes(query)
    );
    return [...candidates].sort(
      (a, b) => new Date(b.last_read_at).getTime() - new Date(a.last_read_at).getTime()
    )[0];
  }, [inProgress, searchQuery]);

  const getGreetingDetails = () => {
    if (activeTab === 'library') {
      return {
        title: 'Your Library',
        desc: `You have ${books.length} ${books.length === 1 ? 'book' : 'books'} in your collection.`
      };
    }
    if (activeTab === 'in-progress') {
      return {
        title: 'Continue Reading',
        desc: `You have ${inProgress.length} ${inProgress.length === 1 ? 'book' : 'books'} in progress.`
      };
    }
    if (activeTab === 'completed') {
      return {
        title: 'Completed Books',
        desc: `You have read ${completed.length} ${completed.length === 1 ? 'book' : 'books'} completely!`
      };
    }
    if (activeTab === 'favorites') {
      return {
        title: 'Your Favorites',
        desc: `You have favorited ${books.filter((b) => favorites[b.id]).length} books.`
      };
    }
    if (activeTab === 'uploads') {
      return {
        title: 'Upload Center',
        desc: 'Add new books, manga archives, or EPUBs to your shelf.'
      };
    }
    return {
      title: `${getGreeting()}, ${displayName}`,
      desc: inProgress.length === 0
        ? 'Your library is all caught up. Ready to start something new?'
        : `You have ${inProgress.length} ${inProgress.length === 1 ? 'book' : 'books'} in progress.`
    };
  };

  const greetingDetails = getGreetingDetails();


  useEffect(() => {
    if (user?.id.startsWith('guest_') && googleClientId) {
      const timer = window.setTimeout(onInitGoogleAuth, 100);
      return () => window.clearTimeout(timer);
    }
  }, [googleClientId, onInitGoogleAuth, user]);

  const createThumbnailBlob = (imageBlob: Blob): Promise<Blob> =>
    new Promise((resolve) => {
      const img = new Image();
      img.src = URL.createObjectURL(imageBlob);
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 320 / Math.max(img.width, img.height));
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const context = canvas.getContext('2d');
        if (!context) return resolve(imageBlob);
        context.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => resolve(blob ?? imageBlob), 'image/jpeg', 0.85);
      };
      img.onerror = () => resolve(imageBlob);
    });

  const processFile = async (file: File) => {
    const isPdf = file.name.toLowerCase().endsWith('.pdf');
    const isManga = /\.(cbz|zip)$/i.test(file.name);
    if (!isPdf && !isManga) {
      alert('Supported formats: PDF, CBZ, and ZIP manga archives.');
      return;
    }

    setUploadStatus('Analyzing document...');
    setUploadProgress(10);
    try {
      const fileBuffer = await file.arrayBuffer();
      let totalPages = 1;
      let coverBlob: Blob | null = null;
      if (isPdf) {
        const pdf = await pdfjsLib.getDocument({ data: fileBuffer }).promise;
        totalPages = pdf.numPages;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 0.6 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const context = canvas.getContext('2d');
        if (context) {
          await page.render({ canvasContext: context, viewport }).promise;
          coverBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
        }
      } else {
        const zip = await JSZip.loadAsync(fileBuffer);
        const images = Object.keys(zip.files)
          .filter((name) => /\.(jpe?g|png|webp|gif|bmp)$/i.test(name) && !zip.files[name].dir)
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        if (!images.length) throw new Error('No images found in the archive.');
        totalPages = images.length;
        coverBlob = await createThumbnailBlob(await zip.files[images[0]].async('blob'));
      }

      setUploadStatus('Uploading and compressing file...');
      setUploadProgress(40);
      const formData = new FormData();
      formData.append('title', file.name.replace(/\.[^.]+$/, ''));
      formData.append('type', isPdf ? 'pdf' : 'cbz');
      formData.append('total_pages', String(totalPages));
      formData.append('file', file);
      if (coverBlob) formData.append('cover', coverBlob, 'cover.jpg');
      if (isPdf && convertToEpub) formData.append('convert_to_epub', 'true');

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/books');
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) setUploadProgress(40 + Math.round((event.loaded / event.total) * 55));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          onUploadSuccess(JSON.parse(xhr.responseText));
          setUploadStatus('Upload complete');
          setUploadProgress(100);
          window.setTimeout(() => {
            setUploadStatus('');
            setUploadProgress(0);
          }, 1800);
        } else {
          setUploadStatus('');
          alert(`Upload failed: ${xhr.responseText}`);
        }
      };
      xhr.onerror = () => {
        setUploadStatus('');
        alert('An error occurred during file upload.');
      };
      xhr.send(formData);
    } catch (error) {
      setUploadStatus('');
      alert(error instanceof Error ? error.message : 'Error processing document.');
    }
  };

  return (
    <div className="flex min-h-screen w-full items-start bg-transparent text-default-font">
      {/* Mobile Drawer Backdrop */}
      {isMobileMenuOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm hidden mobile:block"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* Left Rail Navigation */}
      <aside
        className={`sticky top-0 flex h-screen w-16 flex-none flex-col items-center gap-2 border-r border-white/[0.04] bg-[#09090e]/50 backdrop-blur-xl py-4 transition-all duration-300 z-40 ${
          isMobileMenuOpen
            ? 'mobile:flex mobile:fixed mobile:left-0 mobile:top-0 mobile:w-20 mobile:bg-[#09090e] mobile:shadow-[0_0_40px_rgba(0,0,0,0.8)]'
            : 'mobile:hidden'
        }`}
      >
        <div className="mb-3 flex w-full justify-center border-b border-white/[0.04] pb-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-purple-600/20 to-indigo-600/20 border border-purple-500/20 shadow-[0_0_12px_rgba(139,92,246,0.15)]">
            <FeatherBookOpen className="text-lg text-purple-400" />
          </div>
        </div>
        <RailItem active={activeTab === 'dashboard'} icon={<FeatherLayout />} label="Dashboard" onClick={() => { setActiveTab('dashboard'); setIsMobileMenuOpen(false); }} />
        <RailItem active={activeTab === 'library'} icon={<FeatherBook />} label="Library" onClick={() => { setActiveTab('library'); setIsMobileMenuOpen(false); }} />
        <RailItem active={activeTab === 'in-progress'} icon={<FeatherBookOpen />} label="Continue Reading" badge={inProgress.length} onClick={() => { setActiveTab('in-progress'); setIsMobileMenuOpen(false); }} />
        <RailItem active={activeTab === 'uploads'} icon={<FeatherUploadCloud />} label="Uploads" onClick={() => { setActiveTab('uploads'); setIsMobileMenuOpen(false); }} />
        <div className="mt-auto flex w-full flex-col items-center gap-2 border-t border-white/[0.04] pt-3">
          <RailItem active={activeTab === 'completed'} icon={<FeatherBookOpenCheck />} label="Completed" onClick={() => { setActiveTab('completed'); setIsMobileMenuOpen(false); }} />
          <RailItem active={activeTab === 'favorites'} icon={<FeatherHeart />} label="Favorites" onClick={() => { setActiveTab('favorites'); setIsMobileMenuOpen(false); }} />
          <RailItem active={activeTab === 'library'} icon={<FeatherFiles />} label="All Files" onClick={() => { setActiveTab('library'); setIsMobileMenuOpen(false); }} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Topbar */}
        <header className="sticky top-0 z-20 flex w-full items-center gap-4 border-b border-white/[0.04] bg-[#09090e]/70 px-6 py-3 backdrop-blur-xl mobile:px-4">
          <IconButton
            className="hidden mobile:flex"
            icon={<FeatherMenu />}
            aria-label="Open navigation"
            onClick={() => setIsMobileMenuOpen(true)}
          />
          <TextField className="h-auto max-w-[300px] flex-1 mobile:max-w-none" variant="filled" icon={<FeatherSearch />}>
            <TextField.Input
              type="search"
              placeholder="Search books, manga, PDFs..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </TextField>
          <div className="flex flex-1 items-center justify-end gap-3">
            <Select
              className="mobile:hidden"
              variant="filled"
              placeholder="Sort by"
              value={sortMode}
              onValueChange={(value) => setSortMode(value as SortMode)}
            >
              <Select.Item value="recent">Recently Read</Select.Item>
              <Select.Item value="title">Title A–Z</Select.Item>
              <Select.Item value="progress">Progress</Select.Item>
              <Select.Item value="added">Date Added</Select.Item>
            </Select>
            <ToggleGroup className="mobile:hidden">
              <div onClick={() => setViewMode('grid')}>
                <ToggleGroup.Item value="grid" icon={<FeatherGrid />} aria-label="Grid view" aria-checked={viewMode === 'grid'} />
              </div>
              <div onClick={() => setViewMode('list')}>
                <ToggleGroup.Item value="list" icon={<FeatherList />} aria-label="List view" aria-checked={viewMode === 'list'} />
              </div>
            </ToggleGroup>
            <Avatar size="small" image={user?.picture}>{displayName.slice(0, 1)}</Avatar>
            <button type="button" title="Settings / Sign out" aria-label="Settings" onClick={onSignOut} className="text-neutral-500 hover:text-neutral-200 transition-colors">
              <FeatherSettings />
            </button>

            <SubframeCore.DropdownMenu.Root>
              <SubframeCore.DropdownMenu.Trigger asChild>
                <IconButton icon={<FeatherBell />} aria-label="Notifications" />
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
                      NOTIFICATIONS
                    </span>
                    <div className="flex h-px w-full flex-none bg-[#334155]" />
                    <div className="flex flex-col gap-2 w-full">
                      <div className="flex flex-col gap-1 rounded-md bg-[#0f172a] p-2.5">
                        <span className="text-xs font-bold text-purple-400">Welcome to SleekReader!</span>
                        <span className="text-[11px] text-neutral-300">Start uploading your PDFs, EPUBs, or ZIP manga files to curate your personalized library.</span>
                      </div>
                      <div className="flex flex-col gap-1 rounded-md bg-[#0f172a]/50 p-2.5">
                        <span className="text-xs font-bold text-cyan-400">Tips & Shortcuts</span>
                        <span className="text-[11px] text-neutral-300">Use arrow keys (←/→) to flip pages inside the reader, and customize font sizes using the settings panel.</span>
                      </div>
                    </div>
                  </div>
                </SubframeCore.DropdownMenu.Content>
              </SubframeCore.DropdownMenu.Portal>
            </SubframeCore.DropdownMenu.Root>
          </div>
        </header>

        <main className="flex w-full flex-col gap-10 px-8 py-8 mobile:gap-8 mobile:px-4 mobile:py-6">
          {/* ─── Greeting ─── */}
          <section className="flex w-full items-center justify-between gap-4">
            <div className="flex flex-col gap-1">
              <h1 className="text-heading-1 font-heading-1 mobile:text-heading-2 mobile:font-heading-2">
                {activeTab === 'dashboard' ? (
                  <>
                    {getGreeting()},{' '}
                    <span className="bg-gradient-to-r from-purple-400 to-indigo-400 bg-clip-text text-transparent">{displayName}</span>
                  </>
                ) : (
                  greetingDetails.title
                )}
              </h1>
              <p className="text-body font-body text-subtext-color">
                {greetingDetails.desc}
              </p>
            </div>
            <Button
              className="mobile:hidden"
              variant="neutral-secondary"
              icon={<FeatherUploadCloud />}
              onClick={() => fileInputRef.current?.click()}
            >
              Upload File
            </Button>
            <input
              ref={fileInputRef}
              className="hidden"
              type="file"
              accept=".pdf,.cbz,.zip"
              onChange={(event) => event.target.files?.[0] && processFile(event.target.files[0])}
            />
          </section>

          {/* ─── Resume Hero Card ─── */}
          {activeTab === 'dashboard' && resumeBook ? (
            <section className="flex w-full flex-col gap-4">
              <div className="flex items-center justify-between">
                <h2 className="text-heading-3 font-heading-3">Pick Up Where You Left Off</h2>
                <Button variant="neutral-tertiary" size="small" iconRight={<FeatherArrowRight />} onClick={() => setActiveTab('in-progress')}>All In Progress</Button>
              </div>
              <div
                className="relative overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-br from-[#13131e] to-[#0d0d16] shadow-[0_8px_40px_rgba(0,0,0,0.5)] hover:border-purple-500/20 transition-all duration-500 group"
              >
                {/* Background accent glow */}
                <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-purple-600/10 blur-3xl" />
                <div className="pointer-events-none absolute -bottom-8 -left-8 h-36 w-36 rounded-full bg-indigo-600/10 blur-2xl" />

                <div className="relative flex w-full items-start gap-6 p-6 mobile:flex-col mobile:p-4">
                  <div className="relative flex-none">
                    <Cover
                      book={resumeBook}
                      className="h-52 w-36 rounded-xl object-cover shadow-[0_8px_24px_rgba(0,0,0,0.5)] mobile:h-44 mobile:w-32"
                    />
                    {/* Progress ring on cover corner */}
                    <div className="absolute -bottom-2 -right-2 flex h-10 w-10 items-center justify-center rounded-full border-2 border-[#09090e] bg-gradient-to-br from-purple-600 to-indigo-600 text-xs font-bold text-white shadow-[0_0_12px_rgba(139,92,246,0.5)]">
                      {progressFor(resumeBook)}%
                    </div>
                  </div>

                  <div className="flex min-w-0 flex-1 flex-col gap-5 py-1">
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${typeColor(resumeBook.type)}`}>
                          {resumeBook.type}
                        </span>
                      </div>
                      <h3 className="text-xl font-bold text-white leading-tight tracking-tight mobile:text-lg line-clamp-2">
                        {resumeBook.title}
                      </h3>
                    </div>

                    {/* Progress bar section */}
                    <div className="flex w-full max-w-sm flex-col gap-2">
                      <div className="flex items-center justify-between text-xs font-medium">
                        <span className="text-neutral-400">Reading progress</span>
                        <span className="text-purple-300 font-bold">{progressFor(resumeBook)}%</span>
                      </div>
                      <Progress value={progressFor(resumeBook)} />
                    </div>

                    {/* Meta info */}
                    <div className="flex flex-wrap items-center gap-5">
                      <span className="flex items-center gap-1.5 text-sm text-neutral-400">
                        <FeatherBookOpen className="text-purple-400 text-base" />
                        Page {resumeBook.current_page} of {resumeBook.total_pages}
                      </span>
                      <span className="flex items-center gap-1.5 text-sm text-neutral-400">
                        <FeatherClock className="text-purple-400 text-base" />
                        {formatRelativeDate(resumeBook.last_read_at)}
                      </span>
                    </div>

                    <Button
                      className="self-start bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-semibold border-0 shadow-[0_0_20px_rgba(139,92,246,0.35)] hover:shadow-[0_0_28px_rgba(139,92,246,0.5)] transition-all duration-300"
                      icon={<FeatherPlay />}
                      onClick={() => onSelectBook(resumeBook)}
                    >
                      Resume Reading
                    </Button>
                  </div>
                </div>
              </div>
            </section>
          ) : null}

          {/* ─── Stats Row ─── */}
          {(activeTab === 'dashboard' || activeTab === 'uploads' || activeTab === 'library') && (
            <section className="grid w-full grid-cols-3 gap-4 mobile:grid-cols-1 mobile:gap-3">
              <Metric
                label="In Progress"
                value={inProgress.length}
                detail={`of ${books.length} total`}
                accentColor="from-purple-500/10 to-indigo-500/5"
                dotColor="bg-purple-400"
              />
              <Metric
                label="Pages Read"
                value={books.reduce((sum, book) => sum + book.current_page, 0)}
                trend="Current library"
                accentColor="from-cyan-500/10 to-blue-500/5"
                dotColor="bg-cyan-400"
              />
              <Metric
                label="Completed"
                value={completed.length}
                detail="books total"
                accentColor="from-emerald-500/10 to-teal-500/5"
                dotColor="bg-emerald-400"
              />
            </section>
          )}

          {/* ─── Books Shelf ─── */}
          {activeTab !== 'uploads' && (
            <section className="flex w-full flex-col gap-4">
              <div className="flex items-center justify-between">
                <h2 className="text-heading-3 font-heading-3">
                  {activeTab === 'library' ? 'All Books' :
                   activeTab === 'in-progress' ? 'In Progress' :
                   activeTab === 'completed' ? 'Completed' :
                   activeTab === 'favorites' ? 'Favorites' :
                   'Recently Read'}
                </h2>
                {activeTab === 'dashboard' && (
                  <Button variant="neutral-tertiary" size="small" iconRight={<FeatherArrowRight />} onClick={() => setActiveTab('library')}>View All</Button>
                )}
              </div>
              {visibleBooks.length ? (
                <div
                  className={
                    viewMode === 'grid'
                      ? 'grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6'
                      : 'flex flex-col gap-3'
                  }
                >
                  {visibleBooks.map((book) =>
                    viewMode === 'grid' ? (
                      <GridBookCard
                        key={book.id}
                        book={book}
                        isFavorite={Boolean(favorites[book.id])}
                        onToggleFavorite={() => toggleFavorite(book.id)}
                        onSelect={() => onSelectBook(book)}
                        onDelete={() => onDeleteBook(book.id)}
                        onConvert={book.type === 'pdf' ? () => onConvertBook(book.id) : undefined}
                      />
                    ) : (
                      <ListBookCard
                        key={book.id}
                        book={book}
                        isFavorite={Boolean(favorites[book.id])}
                        onToggleFavorite={() => toggleFavorite(book.id)}
                        onSelect={() => onSelectBook(book)}
                        onDelete={() => onDeleteBook(book.id)}
                        onConvert={book.type === 'pdf' ? () => onConvertBook(book.id) : undefined}
                      />
                    )
                  )}
                </div>
              ) : (
                <EmptyState hasBooks={filteredBooks.length > 0} onUpload={() => fileInputRef.current?.click()} />
              )}
            </section>
          )}

          {/* ─── Upload Banner ─── */}
          {(activeTab === 'dashboard' || activeTab === 'uploads') && (
            <section className="relative overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-r from-purple-950/15 via-[#13131e] to-indigo-950/15 px-6 py-5 mobile:flex-col mobile:items-start hover:border-purple-500/20 transition-all duration-300">
              <div className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full bg-indigo-600/8 blur-3xl" />
              <div className="flex items-center justify-between gap-4 mobile:flex-col mobile:items-start">
                <div>
                  <h2 className="text-body-bold font-body-bold text-white">Add to Your Library</h2>
                  <p className="text-caption font-caption text-neutral-400 mt-0.5">Supports PDF, CBZ, and ZIP manga archives.</p>
                </div>
                <div className="flex items-center gap-4 mobile:w-full mobile:flex-col mobile:items-stretch">
                  <label className="flex items-center gap-2 text-caption font-caption text-neutral-400 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      className="accent-purple-500 rounded border-white/10"
                      checked={convertToEpub}
                      onChange={(event) => setConvertToEpub(event.target.checked)}
                    />
                    Convert PDF to EPUB
                  </label>
                  <Button
                    icon={<FeatherUploadCloud />}
                    loading={Boolean(uploadStatus)}
                    onClick={() => fileInputRef.current?.click()}
                    className="bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-semibold border-0 shadow-[0_0_16px_rgba(139,92,246,0.25)]"
                  >
                    {uploadStatus || 'Upload File'}
                  </Button>
                </div>
              </div>
              {uploadStatus ? (
                <Progress className="absolute left-0 bottom-0 w-full h-[3px]" value={uploadProgress} />
              ) : null}
            </section>
          )}

          {/* ─── Google Sign-In Nudge ─── */}
          {activeTab === 'dashboard' && user?.id.startsWith('guest_') && googleClientId ? (
            <section className="flex items-center justify-between gap-4 rounded-2xl border border-purple-500/25 bg-gradient-to-r from-purple-600/8 to-indigo-600/8 px-6 py-5 mobile:flex-col mobile:items-start shadow-[0_0_24px_rgba(139,92,246,0.08)]">
              <div>
                <h2 className="text-body-bold font-body-bold text-white flex items-center gap-2">
                  <span className="flex h-2 w-2 rounded-full bg-purple-400 animate-pulse" />
                  Save your library permanently
                </h2>
                <p className="text-caption font-caption text-neutral-400 mt-1">
                  Sign in with Google and your guest library syncs automatically.
                </p>
              </div>
              <div id="google-signin-btn-nudge" />
            </section>
          ) : null}
        </main>
      </div>
    </div>
  );
}

/* ─── Sub-components ──────────────────────────────────────────────── */

function GridBookCard({
  book,
  isFavorite,
  onToggleFavorite,
  onSelect,
  onDelete,
  onConvert,
}: {
  book: BookType;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  onSelect: () => void;
  onDelete: () => void;
  onConvert?: () => void;
}) {
  const pct = progressFor(book);
  return (
    <article className="group flex min-w-0 flex-col gap-3">
      <button type="button" className="relative text-left" onClick={onSelect}>
        <Cover
          book={book}
          className="h-56 w-full rounded-xl object-cover shadow-md mobile:h-48"
        />
        {/* Progress mini badge */}
        <span
          className={`absolute bottom-2 right-2 rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
            pct >= 100 ? 'bg-emerald-500/90 text-white' : 'bg-black/70 text-neutral-200'
          }`}
        >
          {pct >= 100 ? '✓ Done' : `${pct}%`}
        </span>
      </button>
      <div className="min-w-0 px-0.5">
        <button
          type="button"
          className="line-clamp-2 w-full text-left text-body-bold font-body-bold text-white hover:text-purple-300 transition-colors text-sm leading-snug"
          onClick={onSelect}
        >
          {book.title}
        </button>
        <div className="mt-1 flex items-center justify-between">
          <p className="truncate text-caption font-caption text-neutral-500 text-xs">
            {book.type.toUpperCase()} · {book.total_pages}p
          </p>
          <span className="text-[10px] text-neutral-500">{formatRelativeDate(book.last_read_at)}</span>
        </div>
        {/* Slim progress bar */}
        {pct > 0 && pct < 100 && (
          <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/5">
            <div
              className="h-full rounded-full bg-gradient-to-r from-purple-500 to-indigo-500 transition-all duration-700"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </div>
      {/* Action buttons on hover */}
      <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 -mt-1 px-0.5">
        <IconButton
          icon={<FeatherHeart className={isFavorite ? 'fill-red-500 text-red-500' : 'text-neutral-400'} size={13} />}
          aria-label={isFavorite ? `Unfavorite ${book.title}` : `Favorite ${book.title}`}
          onClick={onToggleFavorite}
        />
        {onConvert && (
          <IconButton icon={<RefreshCw size={13} />} aria-label={`Convert ${book.title} to EPUB`} onClick={onConvert} />
        )}
        <IconButton icon={<Trash2 size={13} />} aria-label={`Delete ${book.title}`} onClick={onDelete} />
      </div>
    </article>
  );
}

function ListBookCard({
  book,
  isFavorite,
  onToggleFavorite,
  onSelect,
  onDelete,
  onConvert,
}: {
  book: BookType;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  onSelect: () => void;
  onDelete: () => void;
  onConvert?: () => void;
}) {
  const pct = progressFor(book);
  return (
    <article className="group flex items-center gap-4 rounded-xl border border-white/[0.05] bg-[#12121a]/60 hover:bg-[#12121a]/90 hover:border-white/10 p-4 transition-all duration-300">
      <button type="button" className="flex-none text-left" onClick={onSelect}>
        <Cover book={book} className="h-20 w-14 rounded-lg object-cover shadow-sm" />
      </button>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          className="line-clamp-1 w-full text-left font-bold text-white hover:text-purple-300 transition-colors"
          onClick={onSelect}
        >
          {book.title}
        </button>
        <div className="mt-0.5 flex items-center gap-3">
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${typeColor(book.type)}`}>
            {book.type}
          </span>
          <span className="text-xs text-neutral-500">
            {book.current_page}/{book.total_pages} pages
          </span>
          <span className="text-xs text-neutral-600">{formatRelativeDate(book.last_read_at)}</span>
        </div>
        {pct > 0 && (
          <div className="mt-2.5 flex items-center gap-2">
            <div className="flex-1 h-1 overflow-hidden rounded-full bg-white/5">
              <div
                className="h-full rounded-full bg-gradient-to-r from-purple-500 to-indigo-500 transition-all duration-700"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-[10px] font-bold text-neutral-500 w-7 text-right">{pct}%</span>
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <IconButton
          icon={<FeatherHeart className={isFavorite ? 'fill-red-500 text-red-500' : 'text-neutral-400'} size={13} />}
          aria-label={isFavorite ? `Unfavorite ${book.title}` : `Favorite ${book.title}`}
          onClick={onToggleFavorite}
        />
        {onConvert && (
          <IconButton icon={<RefreshCw size={13} />} aria-label={`Convert ${book.title} to EPUB`} onClick={onConvert} />
        )}
        <IconButton icon={<Trash2 size={13} />} aria-label={`Delete ${book.title}`} onClick={onDelete} />
      </div>
    </article>
  );
}

function EmptyState({ hasBooks, onUpload }: { hasBooks: boolean; onUpload: () => void }) {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-white/8 bg-[#12121a]/20 p-10 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-purple-500/10 border border-purple-500/15">
        <FeatherBookOpen className="text-2xl text-purple-400/80" />
      </div>
      <div>
        <h3 className="text-body-bold font-body-bold text-white">{hasBooks ? 'No matching books' : 'Your library is empty'}</h3>
        <p className="text-caption font-caption text-neutral-500 mt-1">
          {hasBooks ? 'Try a different search term.' : 'Upload a PDF or manga archive to get started.'}
        </p>
      </div>
      {!hasBooks ? (
        <Button
          icon={<FeatherUploadCloud />}
          onClick={onUpload}
          className="bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 border-none text-white shadow-[0_0_16px_rgba(139,92,246,0.3)]"
        >
          Upload your first book
        </Button>
      ) : null}
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  trend,
  accentColor,
  dotColor,
}: {
  label: string;
  value: number;
  detail?: string;
  trend?: string;
  accentColor: string;
  dotColor: string;
}) {
  return (
    <div className={`relative overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-br ${accentColor} from-[#12121a]/80 p-5 shadow-[0_4px_24px_rgba(0,0,0,0.3)] hover:border-white/10 transition-all duration-300`}>
      <div className="flex items-start justify-between">
        <span className="text-caption font-caption text-neutral-500 uppercase tracking-wider">{label}</span>
        <span className={`mt-1 h-2 w-2 rounded-full ${dotColor} opacity-80`} />
      </div>
      <div className="mt-3 flex items-end gap-2">
        <span className="text-3xl font-bold bg-gradient-to-b from-white to-neutral-300 bg-clip-text text-transparent leading-none">
          {value}
        </span>
        {trend ? (
          <span className="flex items-center gap-1 pb-0.5 text-caption font-caption text-emerald-400">
            <FeatherTrendingUp className="text-emerald-400" /> {trend}
          </span>
        ) : null}
        {detail ? <span className="pb-0.5 text-caption font-caption text-neutral-500">{detail}</span> : null}
      </div>
    </div>
  );
}

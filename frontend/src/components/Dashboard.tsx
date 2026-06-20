import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import JSZip from 'jszip';
import { RefreshCw, Trash2 } from 'lucide-react';
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
  if (hours < 1) return 'Read just now';
  if (hours < 24) return `Read ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `Read ${days} day${days === 1 ? '' : 's'} ago`;
}

function Cover({ book, className }: { book: BookType; className: string }) {
  if (book.cover_path) {
    return <img className={className} src={book.cover_path} alt={`${book.title} cover`} />;
  }

  return (
    <div className={`${className} flex items-center justify-center bg-gradient-to-br from-brand-100 to-neutral-200 p-4`}>
      <FeatherBookOpen className="text-heading-1 font-heading-1 text-brand-700" />
    </div>
  );
}

function RailItem({ icon, label, active = false, badge }: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  badge?: number;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={`relative flex w-10 items-center justify-center rounded-md px-2 py-2 ${
        active ? 'bg-neutral-100 text-brand-600' : 'text-subtext-color hover:bg-neutral-100'
      }`}
    >
      {icon}
      {badge ? (
        <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-600 px-1 text-[10px] font-medium text-black">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

export default function Dashboard({
  books,
  user,
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

  const inProgress = useMemo(
    () => books.filter((book) => book.current_page > 0 && progressFor(book) < 100),
    [books],
  );
  const completed = useMemo(() => books.filter((book) => progressFor(book) >= 100), [books]);
  const resumeBook = [...inProgress].sort(
    (a, b) => new Date(b.last_read_at).getTime() - new Date(a.last_read_at).getTime(),
  )[0];

  const visibleBooks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const filtered = books.filter((book) => book.title.toLowerCase().includes(query));
    return [...filtered].sort((a, b) => {
      if (sortMode === 'title') return a.title.localeCompare(b.title);
      if (sortMode === 'progress') return progressFor(b) - progressFor(a);
      if (sortMode === 'added') return new Date(b.added_at).getTime() - new Date(a.added_at).getTime();
      return new Date(b.last_read_at).getTime() - new Date(a.last_read_at).getTime();
    });
  }, [books, searchQuery, sortMode]);

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
      const token = localStorage.getItem('reader_jwt');
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

  const displayName = user?.name?.split(' ')[0] || 'Reader';

  return (
    <div className="flex min-h-screen w-full items-start bg-neutral-0 text-default-font">
      <aside className="sticky top-0 flex h-screen w-16 flex-none flex-col items-center gap-1 border-r border-neutral-border bg-neutral-0 py-4 mobile:hidden">
        <div className="mb-2 flex w-full justify-center border-b border-neutral-border pb-4">
          <FeatherBookOpen className="text-heading-2 font-heading-2 text-brand-600" />
        </div>
        <RailItem active icon={<FeatherLayout />} label="Dashboard" />
        <RailItem icon={<FeatherBook />} label="Library" />
        <RailItem icon={<FeatherBookOpen />} label="Continue Reading" badge={inProgress.length} />
        <RailItem icon={<FeatherUploadCloud />} label="Uploads" />
        <div className="mt-1 flex w-full flex-col items-center gap-1 border-t border-neutral-border pt-2">
          <RailItem icon={<FeatherBookOpenCheck />} label="Completed" />
          <RailItem icon={<FeatherHeart />} label="Favorites" />
          <RailItem icon={<FeatherFiles />} label="All PDFs" />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex w-full items-center gap-4 border-b border-neutral-border bg-neutral-0/95 px-6 py-3 backdrop-blur mobile:px-4">
          <IconButton className="hidden mobile:flex" icon={<FeatherMenu />} aria-label="Open navigation" />
          <TextField className="h-auto max-w-[320px] flex-1 mobile:max-w-none" variant="filled" icon={<FeatherSearch />}>
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
              <Select.Item value="title">Title A-Z</Select.Item>
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
            <button type="button" title="Sign out" aria-label="Sign out" onClick={onSignOut} className="text-subtext-color hover:text-default-font">
              <FeatherSettings />
            </button>
            <IconButton icon={<FeatherBell />} aria-label="Notifications" />
          </div>
        </header>

        <main className="flex w-full flex-col gap-10 px-8 py-8 mobile:gap-8 mobile:px-4 mobile:py-6">
          <section className="flex w-full items-center justify-between gap-4">
            <div className="flex flex-col gap-1">
              <h1 className="text-heading-1 font-heading-1 mobile:text-heading-2 mobile:font-heading-2">Good evening, {displayName}</h1>
              <p className="text-body font-body text-subtext-color">
                You have {inProgress.length} {inProgress.length === 1 ? 'book' : 'books'} in progress. Pick up where you left off.
              </p>
            </div>
            <Button className="mobile:hidden" variant="neutral-secondary" icon={<FeatherUploadCloud />} onClick={() => fileInputRef.current?.click()}>
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

          {resumeBook ? (
            <section className="flex w-full flex-col gap-4">
              <div className="flex items-center justify-between">
                <h2 className="text-heading-3 font-heading-3">Pick Up Where You Left Off</h2>
                <Button variant="neutral-tertiary" size="small" iconRight={<FeatherArrowRight />}>All In Progress</Button>
              </div>
              <div className="flex w-full items-start gap-6 rounded-lg border border-neutral-200 bg-neutral-50 px-6 py-6 mobile:flex-col mobile:px-4 mobile:py-4">
                <Cover book={resumeBook} className="h-52 w-36 flex-none rounded-md object-cover shadow-md mobile:h-44 mobile:w-32" />
                <div className="flex min-w-0 flex-1 flex-col gap-4 py-1">
                  <div>
                    <h3 className="text-heading-2 font-heading-2 mobile:text-heading-3 mobile:font-heading-3">{resumeBook.title}</h3>
                    <p className="text-body font-body text-subtext-color">{resumeBook.type.toUpperCase()}</p>
                  </div>
                  <div className="flex w-full max-w-[400px] flex-col gap-2">
                    <div className="flex items-center gap-3">
                      <Progress value={progressFor(resumeBook)} />
                      <span className="text-caption-bold font-caption-bold text-subtext-color">{progressFor(resumeBook)}%</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-4">
                      <span className="flex items-center gap-1.5 text-caption font-caption text-subtext-color"><FeatherBookOpen /> Page {resumeBook.current_page} of {resumeBook.total_pages}</span>
                      <span className="flex items-center gap-1.5 text-caption font-caption text-subtext-color"><FeatherClock /> {formatRelativeDate(resumeBook.last_read_at)}</span>
                    </div>
                  </div>
                  <Button className="mt-1 self-start" icon={<FeatherPlay />} onClick={() => onSelectBook(resumeBook)}>Resume Reading</Button>
                </div>
              </div>
            </section>
          ) : null}

          <section className="grid w-full grid-cols-3 gap-4 mobile:grid-cols-1 mobile:gap-3">
            <Metric label="Books in Progress" value={inProgress.length} detail={`of ${books.length} total`} />
            <Metric label="Pages Read" value={books.reduce((sum, book) => sum + book.current_page, 0)} trend="Current library" />
            <Metric label="Completed" value={completed.length} detail="books total" />
          </section>

          <section className="flex w-full flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-heading-3 font-heading-3">Recently Read</h2>
              <Button variant="neutral-tertiary" size="small" iconRight={<FeatherArrowRight />}>View All</Button>
            </div>
            {visibleBooks.length ? (
              <div className={viewMode === 'grid' ? 'grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6' : 'flex flex-col gap-3'}>
                {visibleBooks.map((book) => (
                  <article
                    key={book.id}
                    className={viewMode === 'grid' ? 'group flex min-w-0 flex-col gap-3' : 'group flex items-center gap-4 rounded-lg border border-neutral-200 bg-neutral-50 p-3'}
                  >
                    <button type="button" className="relative text-left" onClick={() => onSelectBook(book)}>
                      <Cover book={book} className={viewMode === 'grid' ? 'h-56 w-full rounded-md object-cover shadow-md mobile:h-48' : 'h-20 w-14 rounded-md object-cover shadow-sm'} />
                      <Badge className="absolute bottom-2 right-2" variant={progressFor(book) >= 100 ? 'success' : 'neutral'}>{progressFor(book)}%</Badge>
                    </button>
                    <div className="min-w-0 flex-1">
                      <button type="button" className="line-clamp-2 w-full text-left text-caption-bold font-caption-bold" onClick={() => onSelectBook(book)}>{book.title}</button>
                      <p className="mt-1 truncate text-caption font-caption text-subtext-color">{book.type.toUpperCase()} · {book.current_page}/{book.total_pages} pages</p>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      {book.type === 'pdf' ? <IconButton icon={<RefreshCw size={14} />} aria-label={`Convert ${book.title} to EPUB`} onClick={() => onConvertBook(book.id)} /> : null}
                      <IconButton icon={<Trash2 size={14} />} aria-label={`Delete ${book.title}`} onClick={() => onDeleteBook(book.id)} />
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-8 text-center">
                <FeatherBookOpen className="text-heading-1 font-heading-1 text-neutral-400" />
                <div>
                  <h3 className="text-body-bold font-body-bold">{books.length ? 'No matching books' : 'Your library is empty'}</h3>
                  <p className="text-caption font-caption text-subtext-color">{books.length ? 'Try a different search.' : 'Upload a PDF or manga archive to start reading.'}</p>
                </div>
                {!books.length ? <Button icon={<FeatherUploadCloud />} onClick={() => fileInputRef.current?.click()}>Upload your first book</Button> : null}
              </div>
            )}
          </section>

          <section className="relative flex w-full items-center justify-between gap-4 overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 px-5 py-4 mobile:flex-col mobile:items-start">
            <div>
              <h2 className="text-body-bold font-body-bold">New Uploads</h2>
              <p className="text-caption font-caption text-subtext-color">Add PDF, CBZ, or ZIP files to your library.</p>
            </div>
            <div className="flex items-center gap-3 mobile:w-full mobile:flex-col mobile:items-stretch">
              <label className="flex items-center gap-2 text-caption font-caption text-subtext-color">
                <input type="checkbox" checked={convertToEpub} onChange={(event) => setConvertToEpub(event.target.checked)} />
                Convert PDF uploads to EPUB
              </label>
              <Button icon={<FeatherUploadCloud />} loading={Boolean(uploadStatus)} onClick={() => fileInputRef.current?.click()}>
                {uploadStatus || 'Upload'}
              </Button>
            </div>
            {uploadStatus ? <Progress className="absolute left-0 bottom-0" value={uploadProgress} /> : null}
          </section>

          {user?.id.startsWith('guest_') && googleClientId ? (
            <section className="flex items-center justify-between gap-4 rounded-lg border border-brand-200 bg-brand-50 px-5 py-4 mobile:flex-col mobile:items-start">
              <div>
                <h2 className="text-body-bold font-body-bold">Save your library permanently</h2>
                <p className="text-caption font-caption text-subtext-color">Sign in and your guest library will transfer automatically.</p>
              </div>
              <div id="google-signin-btn-nudge" />
            </section>
          ) : null}
        </main>
      </div>
    </div>
  );
}

function Metric({ label, value, detail, trend }: { label: string; value: number; detail?: string; trend?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-neutral-200 bg-neutral-50 px-5 py-4">
      <span className="text-caption font-caption text-subtext-color">{label}</span>
      <div className="flex items-end gap-2">
        <span className="text-heading-1 font-heading-1">{value}</span>
        {trend ? <span className="flex items-center gap-1 pb-1 text-caption font-caption text-success-600"><FeatherTrendingUp /> {trend}</span> : null}
        {detail ? <span className="pb-1 text-caption font-caption text-subtext-color">{detail}</span> : null}
      </div>
    </div>
  );
}

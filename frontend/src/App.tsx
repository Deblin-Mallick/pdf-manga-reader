import { useState, useEffect, useRef, useCallback } from 'react';
import { LogOut, BookOpen } from 'lucide-react';
import Dashboard from './components/Dashboard';
import Welcome from './components/Welcome';
import PDFReader from './components/PDFReader';
import MangaReader from './components/MangaReader';
import EPUBReader from './components/EPUBReader';

declare global {
  interface Window {
    google?: any;
  }
}

export interface Book {
  id: string;
  user_id: string;
  title: string;
  type: 'pdf' | 'cbz' | 'zip' | 'epub';
  file_path: string;
  cover_path: string;
  added_at: string;
  last_read_at: string;
  current_page: number;
  total_pages: number;
  zoom: number;
  view_mode: string;
  scroll_position: number;
  reading_direction: 'ltr' | 'rtl';
}

export interface User {
  id: string;
  email: string;
  name: string;
  picture: string;
}

export default function App() {
  const [token, setToken] = useState<string | null>(localStorage.getItem('reader_jwt'));
  const [user, setUser] = useState<User | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [currentBook, setCurrentBook] = useState<Book | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  // ID of the last-opened book — ref so it never triggers re-renders
  const pendingBookIdRef = useRef<string | null>(
    sessionStorage.getItem('reader_open_book_id')
  );
  
  // Local configuration for Google Client ID
  const [googleClientId, setGoogleClientId] = useState<string>(
    localStorage.getItem('google_client_id') || ''
  );

  // Fetch Google Client ID config from backend on mount
  useEffect(() => {
    fetch('/api/auth/config')
      .then((res) => res.json())
      .then((data) => {
        if (data.google_client_id) {
          setGoogleClientId(data.google_client_id);
          localStorage.setItem('google_client_id', data.google_client_id);
        }
      })
      .catch((err) => console.error('Failed to load backend config:', err));
  }, []);

  // Helper to make authenticated API requests
  const apiFetch = useCallback(async (url: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers || {});
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401 && token) {
      // Token expired, log out
      handleSignOut();
      throw new Error('Session expired. Please log in again.');
    }
    return res;
  }, [token]);

  // Fetch current profile and books
  const fetchUserData = useCallback(async () => {
    if (!token) {
      const isGuest = localStorage.getItem('reader_guest_mode') === 'true';
      if (!isGuest) {
        setUser(null);
        return;
      }
      
      // In guest mode
      setUser({
        id: 'guest',
        name: 'Guest Reader',
        email: 'guest@local.dev',
        picture: '',
      });
      try {
        const res = await fetch('/api/books');
        if (res.ok) {
          const data: Book[] = await res.json();
          setBooks(data);
          // Restore open book for guest users too
          if (pendingBookIdRef.current) {
            const restored = data.find((b) => b.id === pendingBookIdRef.current);
            if (restored) setCurrentBook(restored);
            pendingBookIdRef.current = null;
          }
        }
      } catch (err) {
        console.error('Failed to fetch guest books:', err);
      }
      return;
    }

    setIsLoading(true);
    try {
      const profileRes = await apiFetch('/api/auth/me');
      if (profileRes.ok) {
        const profile = await profileRes.json();
        setUser(profile);
      }
      
      const booksRes = await apiFetch('/api/books');
      if (booksRes.ok) {
        const booksData: Book[] = await booksRes.json();
        setBooks(booksData);
        // Restore the previously open book after a page refresh
        if (pendingBookIdRef.current) {
          const restored = booksData.find((b) => b.id === pendingBookIdRef.current);
          if (restored) setCurrentBook(restored);
          pendingBookIdRef.current = null;
        }
      }
    } catch (err) {
      console.error('Failed to load user data:', err);
    } finally {
      setIsLoading(false);
    }
  }, [token, apiFetch]);

  useEffect(() => {
    fetchUserData();
  }, [fetchUserData]);

  // Handle Google Token Callback
  const handleGoogleCredentialResponse = useCallback(async (response: any) => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id_token: response.credential }),
      });
      
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Failed to authenticate');
      }

      const data = await res.json();
      localStorage.setItem('reader_jwt', data.token);
      localStorage.removeItem('reader_guest_mode');
      setToken(data.token);
      setUser(data.user);
      
      // Load their books
      const booksRes = await fetch('/api/books', {
        headers: { 'Authorization': `Bearer ${data.token}` }
      });
      if (booksRes.ok) {
        setBooks(await booksRes.json());
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initialize Google Login Sign-In Button
  const initGoogleLogin = useCallback(() => {
    if (window.google && googleClientId) {
      try {
        window.google.accounts.id.initialize({
          client_id: googleClientId,
          callback: handleGoogleCredentialResponse,
          auto_select: false,
        });

        const btnDiv = document.getElementById('google-signin-btn');
        if (btnDiv) {
          window.google.accounts.id.renderButton(btnDiv, {
            theme: 'filled_dark',
            size: 'large',
            shape: 'pill',
          });
        }
      } catch (err) {
        console.error('Failed to render Google login button:', err);
      }
    }
  }, [googleClientId, handleGoogleCredentialResponse]);

  useEffect(() => {
    // Attempt login init
    initGoogleLogin();
  }, [googleClientId, initGoogleLogin]);

  // Re-initialize Google Login button in the header if Guest mode is active
  useEffect(() => {
    if (user?.id === 'guest' && googleClientId) {
      const timer = setTimeout(() => {
        initGoogleLogin();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [user, googleClientId, initGoogleLogin]);

  const handleSignOut = () => {
    localStorage.removeItem('reader_jwt');
    localStorage.removeItem('reader_guest_mode');
    setToken(null);
    setUser(null);
    setBooks([]);
    setCurrentBook(null);
  };

  const handleSaveClientId = (clientId: string) => {
    localStorage.setItem('google_client_id', clientId);
    setGoogleClientId(clientId);
    window.location.reload();
  };

  const handleBookUploadSuccess = (newBook: Book) => {
    setBooks((prev) => [newBook, ...prev]);
  };

  const handleBookDelete = async (bookId: string) => {
    if (!confirm('Are you sure you want to delete this book?')) return;
    
    try {
      const res = await apiFetch(`/api/books/${bookId}`, { method: 'DELETE' });
      if (res.ok) {
        setBooks((prev) => prev.filter((b) => b.id !== bookId));
      }
    } catch (err) {
      alert('Failed to delete book');
    }
  };

  const handleBookConvert = async (bookId: string) => {
    if (!confirm('Would you like to convert this PDF book to EPUB format?')) return;
    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/books/${bookId}/convert`, { method: 'POST' });
      if (res.ok) {
        const updated = await res.json();
        setBooks((prev) => prev.map((b) => (b.id === bookId ? updated : b)));
        alert('Book successfully converted to EPUB!');
      } else {
        const err = await res.json();
        alert('Conversion failed: ' + (err.detail || 'Unknown error'));
      }
    } catch (err) {
      console.error(err);
      alert('An error occurred during conversion.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdateProgress = useCallback(async (
    bookId: string,
    progress: {
      current_page: number;
      zoom: number;
      view_mode: string;
      scroll_position: number;
      reading_direction: 'ltr' | 'rtl';
    }
  ) => {
    try {
      const res = await apiFetch(`/api/books/${bookId}/progress`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(progress),
      });
      if (res.ok) {
        const updated = await res.json();
        // Update books list in background
        setBooks((prev) => prev.map((b) => (b.id === bookId ? updated : b)));
        // If it's the active book, update current state using functional update
        setCurrentBook((curr) => (curr && curr.id === bookId ? updated : curr));
      }
    } catch (err) {
      console.error('Failed to sync progress:', err);
    }
  }, [apiFetch]);

  const handleBack = useCallback(() => {
    sessionStorage.removeItem('reader_open_book_id');
    setCurrentBook(null);
    fetchUserData();
  }, [fetchUserData]);

  // Persist the open book ID whenever it changes
  useEffect(() => {
    if (currentBook) {
      sessionStorage.setItem('reader_open_book_id', currentBook.id);
    } else {
      sessionStorage.removeItem('reader_open_book_id');
    }
  }, [currentBook]);

  if (!user && !isLoading) {
    return (
      <div className="app-container">
        <Welcome 
          googleClientId={googleClientId}
          onInitGoogleAuth={initGoogleLogin}
          onContinueAsGuest={() => {
            localStorage.setItem('reader_guest_mode', 'true');
            fetchUserData();
          }}
          onSaveClientId={handleSaveClientId}
        />
      </div>
    );
  }

  return (
    <div className="app-container">
      {/* Header Panel */}
      <header className="glass-panel" style={{ margin: '16px', padding: '12px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', zIndex: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }} onClick={() => setCurrentBook(null)} className="cursor-pointer">
          <BookOpen size={28} className="pulse-glow" style={{ color: 'var(--accent-primary)' }} />
          <h1 style={{ fontSize: '1.4rem', background: 'linear-gradient(135deg, #fff 30%, var(--text-secondary) 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            SleekReader
          </h1>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {/* User Section */}
          {user && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              {user.picture ? (
                <img src={user.picture} alt={user.name} style={{ width: '36px', height: '36px', borderRadius: '50%', border: '1.5px solid var(--accent-secondary)' }} />
              ) : (
                <div style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                  {user.name[0]}
                </div>
              )}
              <span style={{ fontSize: '0.9rem', color: 'var(--text-primary)', fontWeight: 500 }} className="desktop-only">
                {user.name}
              </span>
              {user.id !== 'guest' ? (
                <button onClick={handleSignOut} className="btn-secondary" style={{ padding: '8px 12px' }} title="Log Out">
                  <LogOut size={16} />
                </button>
              ) : (
                /* Google login button in header for Guest users */
                googleClientId && (
                  <div id="google-signin-btn" style={{ display: 'inline-block' }}></div>
                )
              )}
            </div>
          )}
        </div>
      </header>

      {/* Main Body */}
      <main style={{ flex: 1, padding: '0 16px 32px 16px', display: 'flex', flexDirection: 'column' }}>
        {isLoading ? (
          <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '16px' }}>
            <div style={{ width: '48px', height: '48px', borderRadius: '50%', border: '4px solid var(--border-glass)', borderTopColor: 'var(--accent-primary)', animation: 'spin 1s linear infinite' }} />
            <p style={{ color: 'var(--text-secondary)' }}>Loading library...</p>
          </div>
        ) : currentBook ? (
          /* Reader Section */
          currentBook.type === 'pdf' ? (
            <PDFReader 
              book={currentBook} 
              token={token}
              onBack={handleBack} 
              onUpdateProgress={handleUpdateProgress} 
            />
          ) : currentBook.type === 'epub' ? (
            <EPUBReader 
              book={currentBook} 
              token={token}
              onBack={handleBack} 
              onUpdateProgress={handleUpdateProgress} 
            />
          ) : (
            <MangaReader 
              book={currentBook} 
              token={token}
              onBack={handleBack} 
              onUpdateProgress={handleUpdateProgress} 
            />
          )
        ) : (
          /* Dashboard Shelf */
          <Dashboard 
            books={books} 
            user={user}
            googleClientId={googleClientId}
            onSelectBook={(book) => setCurrentBook(book)} 
            onUploadSuccess={handleBookUploadSuccess}
            onDeleteBook={handleBookDelete}
            onConvertBook={handleBookConvert}
            onInitGoogleAuth={initGoogleLogin}
          />
        )}
      </main>



      {/* Add spin animation locally for loader */}
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        .cursor-pointer { cursor: pointer; }
        @media (max-width: 768px) {
          .desktop-only { display: none !important; }
        }
      `}</style>
    </div>
  );
}

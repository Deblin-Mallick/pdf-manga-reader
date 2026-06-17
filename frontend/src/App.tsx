import { useState, useEffect, useCallback } from 'react';
import { Settings, LogOut, BookOpen, AlertCircle } from 'lucide-react';
import Dashboard from './components/Dashboard';
import PDFReader from './components/PDFReader';
import MangaReader from './components/MangaReader';

declare global {
  interface Window {
    google?: any;
  }
}

export interface Book {
  id: string;
  user_id: string;
  title: string;
  type: 'pdf' | 'cbz' | 'zip';
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
  const [showSettings, setShowSettings] = useState(false);
  
  // Local configuration for Google Client ID
  const [googleClientId, setGoogleClientId] = useState<string>(
    localStorage.getItem('google_client_id') || ''
  );

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
          const data = await res.json();
          setBooks(data);
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
        const booksData = await booksRes.json();
        setBooks(booksData);
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

  const handleSignOut = () => {
    localStorage.removeItem('reader_jwt');
    setToken(null);
    setUser(null);
    setBooks([]);
    setCurrentBook(null);
  };

  const handleSaveSettings = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const clientId = data.get('clientId') as string;
    localStorage.setItem('google_client_id', clientId);
    setGoogleClientId(clientId);
    setShowSettings(false);
    // Reload page to re-initialize Google libraries
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

  const handleUpdateProgress = async (
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
        // If it's the active book, update current state
        if (currentBook && currentBook.id === bookId) {
          setCurrentBook(updated);
        }
      }
    } catch (err) {
      console.error('Failed to sync progress:', err);
    }
  };

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
              {user.id !== 'guest' && (
                <button onClick={handleSignOut} className="btn-secondary" style={{ padding: '8px 12px' }} title="Log Out">
                  <LogOut size={16} />
                </button>
              )}
            </div>
          )}

          {/* Settings Trigger */}
          <button onClick={() => setShowSettings(true)} className="btn-secondary" style={{ padding: '8px 12px' }} title="Configure Settings">
            <Settings size={18} />
          </button>
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
              onBack={() => { setCurrentBook(null); fetchUserData(); }} 
              onUpdateProgress={handleUpdateProgress} 
            />
          ) : (
            <MangaReader 
              book={currentBook} 
              token={token}
              onBack={() => { setCurrentBook(null); fetchUserData(); }} 
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
            onInitGoogleAuth={initGoogleLogin}
          />
        )}
      </main>

      {/* Settings Modal */}
      {showSettings && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, backdropFilter: 'blur(8px)' }}>
          <div className="glass-panel" style={{ width: '100%', maxWidth: '480px', padding: '32px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Settings size={22} style={{ color: 'var(--accent-primary)' }} />
              <h2>Reader Settings</h2>
            </div>
            
            <form onSubmit={handleSaveSettings} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Google OAuth Client ID</label>
                <input 
                  type="text" 
                  name="clientId" 
                  defaultValue={googleClientId}
                  placeholder="Paste client ID here..." 
                  style={{ width: '100%', padding: '12px', borderRadius: '8px', border: '1px solid var(--border-glass)', backgroundColor: 'rgba(255,255,255,0.03)', color: '#fff', fontSize: '0.9rem', outline: 'none' }}
                />
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <AlertCircle size={12} />
                  Paste Client ID to enable secure cloud library login.
                </span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '12px' }}>
                <button type="button" onClick={() => setShowSettings(false)} className="btn-secondary">
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  Save & Reload
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

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

import { useState, useEffect, useCallback, useRef } from 'react';
import { Routes, Route, Navigate, useNavigate, useParams, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';

// ---------------------------------------------------------------------------
// Guest session helpers – 20-minute localStorage-backed expiry
// ---------------------------------------------------------------------------
const GUEST_SESSION_KEY = 'reader_guest_session';
const GUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface GuestSession {
  id: string;
  expiry: number; // unix ms
}

function loadGuestSession(): string | null {
  try {
    const raw = localStorage.getItem(GUEST_SESSION_KEY);
    if (!raw) return null;
    const session: GuestSession = JSON.parse(raw);
    if (Date.now() > session.expiry) {
      localStorage.removeItem(GUEST_SESSION_KEY);
      return null;
    }
    return session.id;
  } catch {
    return null;
  }
}

function saveGuestSession(id: string): void {
  const session: GuestSession = { id, expiry: Date.now() + GUEST_TTL_MS };
  localStorage.setItem(GUEST_SESSION_KEY, JSON.stringify(session));
}

function renewGuestSession(id: string): void {
  // Only renew if the session actually belongs to the current guest
  try {
    const raw = localStorage.getItem(GUEST_SESSION_KEY);
    if (!raw) return;
    const session: GuestSession = JSON.parse(raw);
    if (session.id === id) saveGuestSession(id);
  } catch { /* ignore */ }
}

function clearGuestSession(): void {
  localStorage.removeItem(GUEST_SESSION_KEY);
}
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

const pageVariants = {
  initial: { opacity: 0, y: 15 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' as const } },
  exit: { opacity: 0, y: -15, transition: { duration: 0.2, ease: 'easeIn' as const } }
};

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  const [token, setToken] = useState<string | null>(
    () => localStorage.getItem('reader_jwt') || loadGuestSession()
  );

  // Fetch Google Client ID config from backend on mount
  const { data: authConfig } = useQuery({
    queryKey: ['authConfig'],
    queryFn: async () => {
      const res = await fetch('/api/auth/config');
      if (!res.ok) throw new Error('Failed to load backend config');
      const data = await res.json();
      if (data.google_client_id) {
        localStorage.setItem('google_client_id', data.google_client_id);
      }
      return data;
    },
    staleTime: Infinity,
  });

  const googleClientId = authConfig?.google_client_id || localStorage.getItem('google_client_id') || '';

  // Handle Google Token Callback — also sends current guest_id so backend can merge books
  const loginMutation = useMutation({
    mutationFn: async (response: any) => {
      const guestId = token?.startsWith('guest_') ? token : undefined;
      const res = await fetch('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id_token: response.credential, guest_id: guestId }),
      });
      
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Failed to authenticate');
      }
      return res.json();
    },
    onSuccess: (data) => {
      localStorage.setItem('reader_jwt', data.token);
      clearGuestSession();
      setToken(data.token);
      queryClient.setQueryData(['user', data.token], data.user);
      queryClient.invalidateQueries({ queryKey: ['books', data.token] });
      if (data.merged_books > 0) {
        // Brief toast: books were merged from guest shelf
        setTimeout(() => alert(`✅ ${data.merged_books} book${data.merged_books > 1 ? 's' : ''} from your guest library have been saved to your account!`), 300);
      }
      navigate('/');
    },
    onError: (err) => {
      alert(err.message || 'Login failed');
    }
  });

  const handleGoogleCredentialResponse = useCallback((response: any) => {
    loginMutation.mutate(response);
  }, [loginMutation]);

  // Initialize Google Login Sign-In Button (renders into header slot + nudge banner slot)
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

        // Also populate the nudge banner button if it's visible
        const nudgeBtnDiv = document.getElementById('google-signin-btn-nudge');
        if (nudgeBtnDiv) {
          window.google.accounts.id.renderButton(nudgeBtnDiv, {
            theme: 'filled_dark',
            size: 'medium',
            shape: 'pill',
            text: 'signin_with',
          });
        }
      } catch (err) {
        console.error('Failed to render Google login button:', err);
      }
    }
  }, [googleClientId, handleGoogleCredentialResponse]);

  // Initialize login button
  useEffect(() => {
    initGoogleLogin();
  }, [googleClientId, initGoogleLogin]);

  // Query User Profile
  const { data: user, isLoading: isLoadingUser } = useQuery<User | null>({
    queryKey: ['user', token],
    queryFn: async () => {
      if (!token) return null;
      if (token.startsWith('guest_')) {
        return {
          id: token,
          name: 'Guest Reader',
          email: 'guest@local.dev',
          picture: '',
        };
      }
      const res = await fetch('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.status === 401) {
        handleSignOut();
        throw new Error('Session expired');
      }
      if (!res.ok) throw new Error('Failed to load profile');
      return res.json();
    },
    enabled: !!token,
  });

  // Query Books Library
  const { data: books = [], isLoading: isLoadingBooks } = useQuery<Book[]>({
    queryKey: ['books', token],
    queryFn: async () => {
      if (!token) return [];
      const res = await fetch('/api/books', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.status === 401) {
        handleSignOut();
        throw new Error('Session expired');
      }
      if (!res.ok) throw new Error('Failed to fetch books');
      return res.json();
    },
    enabled: !!token,
  });

  // Renew guest expiry on activity so an active reader never gets kicked out
  const renewalRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleActivity = useCallback(() => {
    if (token?.startsWith('guest_')) {
      if (renewalRef.current) clearTimeout(renewalRef.current);
      // Debounce renewals to avoid hammering localStorage
      renewalRef.current = setTimeout(() => renewGuestSession(token), 2000);
    }
  }, [token]);

  // Attach a single activity listener for guest sessions
  useEffect(() => {
    if (!token?.startsWith('guest_')) return;
    window.addEventListener('pointerdown', handleActivity);
    window.addEventListener('keydown', handleActivity);
    return () => {
      window.removeEventListener('pointerdown', handleActivity);
      window.removeEventListener('keydown', handleActivity);
    };
  }, [token, handleActivity]);

  // Logout mutation-like function
  const handleSignOut = async () => {
    try {
      if (token && !token.startsWith('guest_')) {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        });
      }
    } catch (err) {
      console.error('Failed to log out session on backend:', err);
    }

    localStorage.removeItem('reader_jwt');
    
    // Generate a fresh unique guest ID – previous session data remains until it expires
    const guestId = 'guest_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    saveGuestSession(guestId);
    
    setToken(guestId);
    queryClient.clear();
    navigate('/');
  };

  const handleBookUploadSuccess = (newBook: Book) => {
    queryClient.setQueryData(['books', token], (oldBooks: Book[] | undefined) => {
      if (!oldBooks) return [newBook];
      return [newBook, ...oldBooks];
    });
  };

  // Delete Book Mutation
  const deleteBookMutation = useMutation({
    mutationFn: async (bookId: string) => {
      const res = await fetch(`/api/books/${bookId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to delete book');
    },
    onSuccess: (_, bookId) => {
      queryClient.setQueryData(['books', token], (oldBooks: Book[] | undefined) => {
        if (!oldBooks) return [];
        return oldBooks.filter((b) => b.id !== bookId);
      });
    },
    onError: () => {
      alert('Failed to delete book');
    }
  });

  // Convert Book Mutation
  const convertBookMutation = useMutation({
    mutationFn: async (bookId: string) => {
      const res = await fetch(`/api/books/${bookId}/convert`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Unknown error');
      }
      return res.json();
    },
    onSuccess: (updatedBook) => {
      queryClient.setQueryData(['books', token], (oldBooks: Book[] | undefined) => {
        if (!oldBooks) return [updatedBook];
        return oldBooks.map((b) => (b.id === updatedBook.id ? updatedBook : b));
      });
      alert('Book successfully converted to EPUB!');
    },
    onError: (err: any) => {
      alert('Conversion failed: ' + err.message);
    }
  });

  // Update Progress Mutation
  const updateProgressMutation = useMutation({
    mutationFn: async ({
      bookId,
      progress
    }: {
      bookId: string;
      progress: {
        current_page: number;
        zoom: number;
        view_mode: string;
        scroll_position: number;
        reading_direction: 'ltr' | 'rtl';
      };
    }) => {
      const res = await fetch(`/api/books/${bookId}/progress`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(progress),
      });
      if (!res.ok) throw new Error('Failed to sync progress');
      return res.json();
    },
    onSuccess: (updatedBook) => {
      // Update books query data directly for snappy UI updates
      queryClient.setQueryData(['books', token], (oldBooks: Book[] | undefined) => {
        if (!oldBooks) return [updatedBook];
        return oldBooks.map((b) => (b.id === updatedBook.id ? updatedBook : b));
      });
    }
  });

  // Re-initialize Google Login button in the header if Guest mode is active
  useEffect(() => {
    if (user?.id?.startsWith('guest_') && googleClientId) {
      const timer = setTimeout(() => {
        initGoogleLogin();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [user, googleClientId, initGoogleLogin]);

  // If there is no token, render Welcome onboarding routes only
  if (!token) {
    return (
      <AnimatePresence mode="wait">
        <Routes location={location} key={location.pathname}>
          <Route
            path="/welcome"
            element={
              <motion.div variants={pageVariants} initial="initial" animate="animate" exit="exit" className="flex-1 flex flex-col">
                <Welcome
                  googleClientId={googleClientId}
                  onInitGoogleAuth={initGoogleLogin}
                  onContinueAsGuest={() => {
                    const existingId = loadGuestSession();
                    const guestId = existingId ?? (
                      'guest_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
                    );
                    saveGuestSession(guestId);
                    setToken(guestId);
                    navigate('/');
                  }}
                />
              </motion.div>
            }
          />
          <Route path="*" element={<Navigate to="/welcome" replace />} />
        </Routes>
      </AnimatePresence>
    );
  }

  return (
    <div className={location.pathname === '/' ? 'min-h-screen' : 'app-container'}>
      <main className={location.pathname === '/' ? 'flex min-h-screen flex-col' : 'flex flex-1 flex-col px-4 pb-8'}>
        {isLoadingBooks || isLoadingUser ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4">
            <div className="w-12 h-12 rounded-full border-4 border-[var(--border-glass)] border-t-[var(--accent-primary)] animate-spin" />
            <p className="text-[var(--text-secondary)]">Loading library...</p>
          </div>
        ) : (
          <AnimatePresence mode="wait">
            <Routes location={location} key={location.pathname}>
              <Route
                path="/"
                element={
                  <motion.div variants={pageVariants} initial="initial" animate="animate" exit="exit" className="flex-1 flex flex-col">
                    <Dashboard
                      books={books}
                      user={user || null}
                      googleClientId={googleClientId}
                      onSelectBook={(book) => navigate(`/book/${book.id}`)}
                      onUploadSuccess={handleBookUploadSuccess}
                      onDeleteBook={(id) => {
                        if (confirm('Are you sure you want to delete this book?')) {
                          deleteBookMutation.mutate(id);
                        }
                      }}
                      onConvertBook={(id) => {
                        if (confirm('Would you like to convert this PDF book to EPUB format?')) {
                          convertBookMutation.mutate(id);
                        }
                      }}
                      onInitGoogleAuth={initGoogleLogin}
                      onSignOut={handleSignOut}
                    />
                  </motion.div>
                }
              />
              <Route
                path="/book/:id"
                element={
                  <motion.div variants={pageVariants} initial="initial" animate="animate" exit="exit" className="flex-1 flex flex-col">
                    <ReaderWrapper
                      books={books}
                      user={user || null}
                      token={token}
                      updateProgressMutation={updateProgressMutation}
                    />
                  </motion.div>
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </AnimatePresence>
        )}
      </main>
    </div>
  );
}

interface ReaderWrapperProps {
  books: Book[];
  user: User | null;
  token: string | null;
  updateProgressMutation: any;
}

function ReaderWrapper({ books, user, token, updateProgressMutation }: ReaderWrapperProps) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const book = books.find((b) => b.id === id);

  if (!book) {
    return (
      <div className="text-center mt-10">
        <h2 className="mb-4 text-xl">Book not found</h2>
        <button className="btn-secondary" onClick={() => navigate('/')}>
          Go back to shelf
        </button>
      </div>
    );
  }

  const handleBack = useCallback(() => {
    navigate('/');
  }, [navigate]);

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
    updateProgressMutation.mutate({ bookId, progress });
  }, [updateProgressMutation]);

  if (book.type === 'pdf') {
    return (
      <PDFReader
        book={book}
        token={token}
        onBack={handleBack}
        onUpdateProgress={handleUpdateProgress}
      />
    );
  } else if (book.type === 'epub') {
    return (
      <EPUBReader
        book={book}
        user={user}
        token={token}
        onBack={handleBack}
        onUpdateProgress={handleUpdateProgress}
      />
    );
  } else {
    return (
      <MangaReader
        book={book}
        token={token}
        onBack={handleBack}
        onUpdateProgress={handleUpdateProgress}
      />
    );
  }
}

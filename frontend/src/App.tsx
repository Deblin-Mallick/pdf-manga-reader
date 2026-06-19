import { useState, useEffect, useCallback } from 'react';
import { LogOut, BookOpen } from 'lucide-react';
import { Routes, Route, Navigate, useNavigate, useParams, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
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
    localStorage.getItem('reader_jwt') || sessionStorage.getItem('reader_guest_id')
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

  // Handle Google Token Callback
  const loginMutation = useMutation({
    mutationFn: async (response: any) => {
      const res = await fetch('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id_token: response.credential }),
      });
      
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Failed to authenticate');
      }
      return res.json();
    },
    onSuccess: (data) => {
      localStorage.setItem('reader_jwt', data.token);
      localStorage.removeItem('reader_guest_mode');
      sessionStorage.removeItem('reader_guest_id');
      setToken(data.token);
      queryClient.setQueryData(['user', data.token], data.user);
      queryClient.invalidateQueries({ queryKey: ['books', data.token] });
      navigate('/');
    },
    onError: (err) => {
      alert(err.message || 'Login failed');
    }
  });

  const handleGoogleCredentialResponse = useCallback((response: any) => {
    loginMutation.mutate(response);
  }, [loginMutation]);

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
    
    // Generate a fresh unique guest ID to shift the user to a clean Guest Shelf
    const guestId = 'guest_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    sessionStorage.setItem('reader_guest_id', guestId);
    
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
                    const guestId = 'guest_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
                    sessionStorage.setItem('reader_guest_id', guestId);
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
    <div className="app-container">
      {/* Header Panel */}
      <header className="glass-panel m-4 px-6 py-3 flex justify-between items-center z-10">
        <div className="flex items-center gap-3 cursor-pointer" onClick={() => navigate('/')}>
          <BookOpen size={28} className="pulse-glow text-[var(--accent-primary)]" />
          <h1 className="text-xl bg-gradient-to-r from-white to-[var(--text-secondary)] bg-clip-text text-transparent font-semibold">
            SleekReader
          </h1>
        </div>

        <div className="flex items-center gap-4">
          {/* User Section */}
          {user && (
            <div className="flex items-center gap-3">
              {user.picture ? (
                <img src={user.picture} alt={user.name} className="w-9 h-9 rounded-full border-1.5 border-[var(--accent-secondary)]" />
              ) : (
                <div className="w-9 h-9 rounded-full bg-[var(--accent-primary)] flex items-center justify-center font-bold">
                  {user.name[0]}
                </div>
              )}
              <span className="text-sm text-[var(--text-primary)] font-medium hidden md:inline">
                {user.name}
              </span>
              {!user.id.startsWith('guest_') ? (
                <button onClick={handleSignOut} className="btn-secondary py-2 px-3" title="Log Out">
                  <LogOut size={16} />
                </button>
              ) : (
                /* Google login button in header for Guest users */
                googleClientId && (
                  <div id="google-signin-btn" className="inline-block"></div>
                )
              )}
            </div>
          )}
        </div>
      </header>

      {/* Main Body */}
      <main className="flex-1 px-4 pb-8 flex flex-col">
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
  token: string | null;
  updateProgressMutation: any;
}

function ReaderWrapper({ books, token, updateProgressMutation }: ReaderWrapperProps) {
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

  const handleBack = () => {
    navigate('/');
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
    updateProgressMutation.mutate({ bookId, progress });
  };

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

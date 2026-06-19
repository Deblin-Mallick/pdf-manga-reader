import { useEffect } from 'react';
import { BookOpen, Cloud, FileText, AlertCircle, ArrowRight, Lock } from 'lucide-react';

interface WelcomeProps {
  googleClientId: string;
  onInitGoogleAuth: () => void;
  onContinueAsGuest: () => void;
}

export default function Welcome({
  googleClientId,
  onInitGoogleAuth,
  onContinueAsGuest,
}: WelcomeProps) {
  // Initialize the Google button if Client ID exists
  useEffect(() => {
    if (googleClientId) {
      const timer = setTimeout(() => {
        onInitGoogleAuth();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [googleClientId, onInitGoogleAuth]);

  return (
    <div className="flex items-center justify-center flex-grow relative p-6 min-h-[calc(100vh-120px)] overflow-hidden">
      {/* Background Glow Orbs */}
      <div className="absolute w-[300px] h-[300px] rounded-full blur-[120px] opacity-10 bg-[var(--accent-primary)] top-[15%] left-[20%] pointer-events-none animate-[pulse_6s_infinite_alternate_ease-in-out]" />
      <div className="absolute w-[300px] h-[300px] rounded-full blur-[120px] opacity-10 bg-[var(--accent-secondary)] bottom-[15%] right-[20%] pointer-events-none animate-[pulse_6s_infinite_alternate-reverse_ease-in-out]" />

      <div className="welcome-card glass-panel w-full max-w-[580px] p-8 md:p-12 flex flex-col gap-8 z-10 relative border border-[var(--border-glass)] shadow-[0_20px_50px_rgba(0,0,0,0.4)]">
        {/* Header Branding */}
        <div className="text-center flex flex-col items-center gap-3">
          <div className="brand-logo pulse-glow w-[72px] h-[72px] rounded-[20px] bg-gradient-to-br from-[rgba(139,92,246,0.15)] to-[rgba(6,182,212,0.15)] border border-[var(--border-glass-active)] flex items-center justify-center text-[var(--accent-primary)] mb-2 shadow-[var(--shadow-neon-purple)]">
            <BookOpen size={48} />
          </div>
          <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight bg-gradient-to-r from-white to-[var(--text-secondary)] bg-clip-text text-transparent">
            SleekReader
          </h1>
          <p className="text-sm md:text-base text-[var(--text-secondary)] max-w-[380px] leading-relaxed">
            Your personal cloud-connected PDF & Manga reading shelf
          </p>
        </div>

        {/* Feature Grid */}
        <div className="flex flex-col gap-5 py-2">
          <div className="flex gap-4 items-start">
            <div className="flex items-center justify-center w-10 h-10 rounded-[10px] bg-[rgba(255,255,255,0.03)] border border-[var(--border-glass)] text-[var(--accent-secondary)] shrink-0">
              <Cloud size={20} />
            </div>
            <div>
              <h3 className="text-sm md:text-base text-[var(--text-primary)] mb-1 font-semibold">
                Personal Cloud Shelf
              </h3>
              <p className="text-xs md:text-sm text-[var(--text-secondary)] leading-relaxed">
                Keep your collection safe. Files are linked directly to your Google account.
              </p>
            </div>
          </div>

          <div className="flex gap-4 items-start">
            <div className="flex items-center justify-center w-10 h-10 rounded-[10px] bg-[rgba(255,255,255,0.03)] border border-[var(--border-glass)] text-[var(--accent-secondary)] shrink-0">
              <Lock size={20} />
            </div>
            <div>
              <h3 className="text-sm md:text-base text-[var(--text-primary)] mb-1 font-semibold">
                Seamless Progress Sync
              </h3>
              <p className="text-xs md:text-sm text-[var(--text-secondary)] leading-relaxed">
                Pick up exactly where you left off, whether on desktop, tablet, or phone.
              </p>
            </div>
          </div>

          <div className="flex gap-4 items-start">
            <div className="flex items-center justify-center w-10 h-10 rounded-[10px] bg-[rgba(255,255,255,0.03)] border border-[var(--border-glass)] text-[var(--accent-secondary)] shrink-0">
              <FileText size={20} />
            </div>
            <div>
              <h3 className="text-sm md:text-base text-[var(--text-primary)] mb-1 font-semibold">
                Format Versatility
              </h3>
              <p className="text-xs md:text-sm text-[var(--text-secondary)] leading-relaxed">
                Natively read PDFs, EPUBs, and CBZ or ZIP manga archive formats.
              </p>
            </div>
          </div>
        </div>

        {/* Auth Section */}
        <div className="flex flex-col gap-5 border-t border-[var(--border-glass)] pt-7">
          {googleClientId ? (
            <div className="flex flex-col items-center justify-center w-full">
              <p className="text-xs md:text-sm text-[var(--text-secondary)] text-center mb-4">
                Sign in with Google to access your synced library
              </p>
              <div id="google-signin-btn" className="min-h-[44px] flex items-center justify-center"></div>
            </div>
          ) : (
            <div className="flex gap-[14px] p-4 items-center border border-[rgba(239,68,68,0.15)] bg-[rgba(239,68,68,0.03)] rounded-xl">
              <AlertCircle size={20} className="text-[#ef4444] shrink-0" />
              <div>
                <h4 className="text-sm text-[#fca5a5] font-semibold mb-1">
                  Google OAuth Not Configured
                </h4>
                <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                  Google Sign-In is disabled because no Client ID is configured yet.
                </p>
              </div>
            </div>
          )}

          {/* Action Row */}
          <div className="flex gap-3 w-full">
            <button
              onClick={onContinueAsGuest}
              className="btn-secondary flex-1 flex justify-center font-medium bg-[rgba(255,255,255,0.03)] py-3 rounded-xl gap-2 items-center"
              title="Continue without syncing"
            >
              <span>Continue as Guest</span>
              <ArrowRight size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

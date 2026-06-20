import { useEffect } from 'react';
import { BookOpen, Cloud, FileText, AlertCircle, ArrowRight, Lock, Zap } from 'lucide-react';

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
  useEffect(() => {
    if (googleClientId) {
      const timer = setTimeout(() => {
        onInitGoogleAuth();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [googleClientId, onInitGoogleAuth]);

  return (
    <div className="relative flex min-h-[calc(100vh-64px)] items-center justify-center overflow-hidden p-6">
      {/* Ambient Background Orbs */}
      <div
        className="pointer-events-none absolute h-[420px] w-[420px] rounded-full blur-[130px] opacity-[0.12]"
        style={{
          background: 'var(--color-purple)',
          top: '10%',
          left: '15%',
          animation: 'floatOrb 9s ease-in-out infinite',
        }}
      />
      <div
        className="pointer-events-none absolute h-[380px] w-[380px] rounded-full blur-[130px] opacity-[0.09]"
        style={{
          background: 'var(--color-cyan)',
          bottom: '10%',
          right: '15%',
          animation: 'floatOrb 11s ease-in-out infinite reverse',
        }}
      />
      <div
        className="pointer-events-none absolute h-[200px] w-[200px] rounded-full blur-[80px] opacity-[0.08]"
        style={{
          background: 'var(--color-pink)',
          top: '55%',
          left: '55%',
          animation: 'floatOrb 7s ease-in-out infinite',
        }}
      />

      {/* Card */}
      <div className="relative z-10 w-full max-w-[560px]">
        {/* Glass Card */}
        <div
          className="relative overflow-hidden rounded-[24px] border p-8 md:p-12 flex flex-col gap-8 shadow-[0_24px_64px_rgba(0,0,0,0.5)]"
          style={{
            background: 'rgba(14, 14, 22, 0.8)',
            borderColor: 'rgba(255,255,255,0.07)',
            backdropFilter: 'blur(24px)',
          }}
        >
          {/* Inner glow accent */}
          <div className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 h-48 w-48 rounded-full blur-3xl opacity-20"
            style={{ background: 'var(--color-purple)' }}
          />

          {/* ─── Branding ─── */}
          <div className="text-center flex flex-col items-center gap-4">
            <div
              className="pulse-glow relative flex h-[76px] w-[76px] items-center justify-center rounded-[22px] mb-2"
              style={{
                background: 'linear-gradient(135deg, rgba(139,92,246,0.18), rgba(6,182,212,0.12))',
                border: '1px solid rgba(139,92,246,0.3)',
                boxShadow: '0 0 24px rgba(139,92,246,0.2), inset 0 1px 0 rgba(255,255,255,0.08)',
              }}
            >
              <BookOpen size={40} className="text-purple-400" />
            </div>

            <div>
              <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight leading-none mb-2">
                <span style={{
                  background: 'linear-gradient(135deg, #f8fafc 0%, #a78bfa 50%, #67e8f9 100%)',
                  backgroundSize: '200% 200%',
                  animation: 'gradientShift 5s ease infinite',
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }}>
                  SleekReader
                </span>
              </h1>
              <p className="text-sm md:text-base max-w-[360px] leading-relaxed mx-auto" style={{ color: 'var(--text-secondary)' }}>
                Your personal cloud-connected reading shelf for PDFs, EPUBs & Manga
              </p>
            </div>
          </div>

          {/* ─── Features ─── */}
          <div className="flex flex-col gap-4">
            {[
              {
                icon: <Cloud size={18} />,
                color: 'text-cyan-400',
                bg: 'rgba(6,182,212,0.08)',
                border: 'rgba(6,182,212,0.15)',
                title: 'Personal Cloud Shelf',
                desc: 'Files linked to your Google account, accessible anywhere.',
              },
              {
                icon: <Zap size={18} />,
                color: 'text-purple-400',
                bg: 'rgba(139,92,246,0.08)',
                border: 'rgba(139,92,246,0.15)',
                title: 'Seamless Progress Sync',
                desc: 'Pick up exactly where you left off across all devices.',
              },
              {
                icon: <FileText size={18} />,
                color: 'text-indigo-400',
                bg: 'rgba(99,102,241,0.08)',
                border: 'rgba(99,102,241,0.15)',
                title: 'All Major Formats',
                desc: 'Natively reads PDF, EPUB, CBZ, and ZIP manga archives.',
              },
            ].map((f) => (
              <div key={f.title} className="flex gap-4 items-start group">
                <div
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-transform duration-300 group-hover:scale-110"
                  style={{ background: f.bg, border: `1px solid ${f.border}` }}
                >
                  <span className={f.color}>{f.icon}</span>
                </div>
                <div className="pt-0.5">
                  <h3 className="text-sm font-semibold text-white mb-0.5">{f.title}</h3>
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{f.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* ─── Auth Section ─── */}
          <div
            className="flex flex-col gap-5 pt-6"
            style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
          >
            {googleClientId ? (
              <div className="flex flex-col items-center gap-3">
                <p className="text-xs text-center" style={{ color: 'var(--text-secondary)' }}>
                  Sign in with Google to access your synced library
                </p>
                <div id="google-signin-btn" className="min-h-[44px] flex items-center justify-center" />
              </div>
            ) : (
              <div
                className="flex gap-3 items-start rounded-xl p-4"
                style={{
                  border: '1px solid rgba(239,68,68,0.2)',
                  background: 'rgba(239,68,68,0.04)',
                }}
              >
                <AlertCircle size={18} className="text-red-400 shrink-0 mt-0.5" />
                <div>
                  <h4 className="text-sm font-semibold text-red-300 mb-1">Google OAuth Not Configured</h4>
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    Google Sign-In is disabled. No Client ID is set.
                  </p>
                </div>
              </div>
            )}

            {/* Guest button */}
            <button
              onClick={onContinueAsGuest}
              className="group relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl py-3 font-medium text-sm transition-all duration-300"
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: 'var(--text-secondary)',
              }}
              title="Continue without signing in"
            >
              <span className="transition-colors duration-300 group-hover:text-white">Continue as Guest</span>
              <ArrowRight size={15} className="transition-transform duration-300 group-hover:translate-x-1" />
              {/* Hover shimmer */}
              <span
                className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                style={{ background: 'rgba(255,255,255,0.03)' }}
              />
            </button>

            <p className="text-center text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Guest sessions last 7 days · No sign-in required
            </p>
          </div>
        </div>

        {/* Bottom badge */}
        <div className="mt-4 flex items-center justify-center gap-1.5">
          <Lock size={11} className="text-neutral-600" />
          <span className="text-[11px] text-neutral-600">Your files are never shared with third parties</span>
        </div>
      </div>
    </div>
  );
}

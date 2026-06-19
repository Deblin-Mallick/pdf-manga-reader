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
      // Small timeout to let the DOM render the target div
      const timer = setTimeout(() => {
        onInitGoogleAuth();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [googleClientId, onInitGoogleAuth]);

  return (
    <div className="welcome-wrapper fade-in">
      {/* Background Glow Orbs */}
      <div className="glow-orb orb-primary" />
      <div className="glow-orb orb-secondary" />

      <div className="welcome-card glass-panel">
        {/* Header Branding */}
        <div className="welcome-header">
          <div className="brand-logo pulse-glow">
            <BookOpen size={48} />
          </div>
          <h1>SleekReader</h1>
          <p className="welcome-subtitle">
            Your personal cloud-connected PDF & Manga reading shelf
          </p>
        </div>

        {/* Feature Grid */}
        <div className="features-grid">
          <div className="feature-item">
            <div className="feature-icon">
              <Cloud size={20} />
            </div>
            <div className="feature-content">
              <h3>Personal Cloud Shelf</h3>
              <p>Keep your collection safe. Files are linked directly to your Google account.</p>
            </div>
          </div>

          <div className="feature-item">
            <div className="feature-icon">
              <Lock size={20} />
            </div>
            <div className="feature-content">
              <h3>Seamless Progress Sync</h3>
              <p>Pick up exactly where you left off, whether on desktop, tablet, or phone.</p>
            </div>
          </div>

          <div className="feature-item">
            <div className="feature-icon">
              <FileText size={20} />
            </div>
            <div className="feature-content">
              <h3>Format Versatility</h3>
              <p>Natively read PDFs, EPUBs, and CBZ or ZIP manga archive formats.</p>
            </div>
          </div>
        </div>

        {/* Auth Section */}
        <div className="auth-section">
          {googleClientId ? (
            <div className="google-auth-container">
              <p className="auth-instructions">Sign in with Google to access your synced library</p>
              <div id="google-signin-btn" className="google-btn-wrapper"></div>
            </div>
          ) : (
            <div className="auth-warning glass-panel">
              <AlertCircle size={20} className="warning-icon" />
              <div>
                <h4>Google OAuth Not Configured</h4>
                <p>Google Sign-In is disabled because no Client ID is configured yet.</p>
              </div>
            </div>
          )}

          {/* Action Row */}
          <div className="action-row">
            <button 
              onClick={onContinueAsGuest} 
              className="btn-secondary guest-btn"
              title="Continue without syncing"
            >
              <span>Continue as Guest</span>
              <ArrowRight size={16} />
            </button>
          </div>
        </div>
      </div>

      <style>{`
        .welcome-wrapper {
          display: flex;
          align-items: center;
          justify-content: center;
          flex: 1;
          position: relative;
          padding: 24px;
          min-height: calc(100vh - 120px);
        }

        .glow-orb {
          position: absolute;
          width: 300px;
          height: 300px;
          border-radius: 50%;
          filter: blur(120px);
          opacity: 0.12;
          z-index: 0;
          pointer-events: none;
        }

        .orb-primary {
          background: var(--accent-primary);
          top: 15%;
          left: 20%;
          animation: driftOrb 12s infinite alternate ease-in-out;
        }

        .orb-secondary {
          background: var(--accent-secondary);
          bottom: 15%;
          right: 20%;
          animation: driftOrb 12s infinite alternate-reverse ease-in-out;
        }

        @keyframes driftOrb {
          0% { transform: translate(0, 0) scale(1); }
          100% { transform: translate(40px, 30px) scale(1.15); }
        }

        .welcome-card {
          width: 100%;
          max-width: 580px;
          padding: 48px;
          display: flex;
          flex-direction: column;
          gap: 32px;
          z-index: 1;
          position: relative;
          border: 1px solid var(--border-glass);
          box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4);
        }

        .welcome-header {
          text-align: center;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
        }

        .brand-logo {
          width: 72px;
          height: 72px;
          border-radius: 20px;
          background: linear-gradient(135deg, rgba(139, 92, 246, 0.15), rgba(6, 182, 212, 0.15));
          border: 1.5px solid var(--border-glass-active);
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--accent-primary);
          margin-bottom: 8px;
          box-shadow: var(--shadow-neon-purple);
        }

        .welcome-header h1 {
          font-size: 2.2rem;
          font-weight: 800;
          letter-spacing: -0.03em;
          background: linear-gradient(135deg, #fff 40%, var(--text-secondary) 100%);
          -webkit-background-clip: text;
          -webkit-text-fillColor: transparent;
        }

        .welcome-subtitle {
          font-size: 0.95rem;
          color: var(--text-secondary);
          max-width: 380px;
          line-height: 1.5;
        }

        .features-grid {
          display: flex;
          flex-direction: column;
          gap: 20px;
          padding: 8px 0;
        }

        .feature-item {
          display: flex;
          gap: 16px;
          align-items: flex-start;
        }

        .feature-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 40px;
          height: 40px;
          border-radius: 10px;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid var(--border-glass);
          color: var(--accent-secondary);
          flex-shrink: 0;
        }

        .feature-content h3 {
          font-size: 0.95rem;
          color: var(--text-primary);
          margin-bottom: 4px;
          font-weight: 600;
        }

        .feature-content p {
          font-size: 0.82rem;
          color: var(--text-secondary);
          line-height: 1.4;
        }

        .auth-section {
          display: flex;
          flex-direction: column;
          gap: 20px;
          border-top: 1px solid var(--border-glass);
          padding-top: 28px;
        }

        .auth-instructions {
          font-size: 0.85rem;
          color: var(--text-secondary);
          text-align: center;
          margin-bottom: 12px;
        }

        .google-auth-container {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          width: 100%;
        }

        .google-btn-wrapper {
          min-height: 44px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .auth-warning {
          display: flex;
          gap: 14px;
          padding: 16px 20px;
          align-items: center;
          border-color: rgba(239, 68, 68, 0.15);
          background: rgba(239, 68, 68, 0.03);
        }

        .warning-icon {
          color: #ef4444;
          flex-shrink: 0;
        }

        .auth-warning h4 {
          font-size: 0.88rem;
          color: #fca5a5;
          margin-bottom: 2px;
        }

        .auth-warning p {
          font-size: 0.78rem;
          color: var(--text-secondary);
          line-height: 1.4;
        }

        .action-row {
          display: flex;
          gap: 12px;
          width: 100%;
        }

        .guest-btn {
          flex: 1;
          display: flex;
          justify-content: center;
          font-weight: 500;
          background: rgba(255, 255, 255, 0.03);
        }

        .config-toggle-btn {
          flex-shrink: 0;
          width: auto;
          display: flex;
          gap: 8px;
        }

        .config-toggle-btn.active {
          border-color: var(--border-glass-active);
          background: rgba(139, 92, 246, 0.05);
          color: var(--accent-primary);
        }

        .inline-config-panel {
          border: 1px solid var(--border-glass);
          background: rgba(0, 0, 0, 0.2);
          border-radius: 12px;
          padding: 20px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .config-header {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .config-header h4 {
          font-size: 0.9rem;
          color: var(--text-primary);
        }

        .config-help {
          font-size: 0.78rem;
          color: var(--text-secondary);
          line-height: 1.4;
        }

        .config-form {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .config-input {
          width: 100%;
          padding: 10px 14px;
          border-radius: 8px;
          border: 1px solid var(--border-glass);
          background: rgba(255, 255, 255, 0.02);
          color: #fff;
          font-size: 0.82rem;
          outline: none;
          transition: var(--transition-fast);
        }

        .config-input:focus {
          border-color: var(--border-glass-active);
          box-shadow: 0 0 10px rgba(139, 92, 246, 0.15);
        }

        .config-buttons {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
        }

        .btn-sm {
          padding: 6px 12px;
          font-size: 0.8rem;
          border-radius: 6px;
        }

        @media (max-width: 640px) {
          .welcome-card {
            padding: 32px 20px;
          }
          .welcome-header h1 {
            font-size: 1.8rem;
          }
          .action-row {
            flex-direction: column;
          }
          .guest-btn, .config-toggle-btn {
            width: 100%;
            justify-content: center;
          }
        }
      `}</style>
    </div>
  );
}

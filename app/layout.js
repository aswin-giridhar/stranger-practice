import './globals.css';

export const metadata = {
  title: 'Stranger Practice — Spoken Conversation Gym for ADHD Adults',
  description:
    'Rehearse talking to strangers against distinct AI personas in 3-minute sessions with measured behavioral metrics and constructive coaching. Not therapy — a practice gym.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <div className="site-wrapper">
          <header className="site-header">
            <div className="header-inner">
              <div className="logo-group">
                <span className="logo-badge">PRACTICE GYM</span>
                <h1 className="logo-title">Stranger Practice</h1>
              </div>
              <div className="header-status">
                <span className="live-dot"></span>
                <span>Gemini 2.5 Active</span>
              </div>
            </div>
          </header>

          <main className="main-content">{children}</main>

          <footer className="site-footer">
            <div className="footer-inner">
              <p className="disclaimer">
                <strong>Disclaimer:</strong> Stranger Practice is an educational communication rehearsal gym. It is not
                therapy, diagnosis, or clinical treatment.
              </p>
              <p className="footer-meta">Powered by Google Gemini & GCP • XPRIZE Hackathon 2026</p>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}

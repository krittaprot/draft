// Registers the service worker so Tandem can be installed (Safari: File → Add to Dock; iPhone: Share → Add to Home Screen).
if ('serviceWorker' in navigator) {
  addEventListener('load', () => { navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {}); });
}

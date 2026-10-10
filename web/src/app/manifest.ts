import type { MetadataRoute } from 'next';

// Installable: Add to Home Screen opens Isobar full-screen, without browser chrome.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Isobar',
    short_name: 'Isobar',
    description: 'Weather maps and ATPL training.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#f8fbfc',
    theme_color: '#1c5888',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

import type { Metadata, Viewport } from 'next';
import { AppShell } from '@/components/AppShell';
import './globals.css';

const themeScript = `(function(){try{var t=localStorage.getItem('isobar-theme');var dark=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',dark);}catch(e){}})();`;

export const metadata: Metadata = {
  title: 'Isobar',
  description: 'Australian weather, and ATPL training behind it.',
  appleWebApp: { capable: true, title: 'Isobar', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8fbfc' },
    { media: '(prefers-color-scheme: dark)', color: '#11161a' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}

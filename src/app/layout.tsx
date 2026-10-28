import type { Metadata, Viewport } from 'next';
import { Oswald, Roboto } from 'next/font/google';
import './globals.css';

// mesmas famílias do rossik.dev.br: Roboto no texto, Oswald nos títulos
const roboto = Roboto({ subsets: ['latin'], weight: ['300', '400', '500', '700'], variable: '--font-roboto', display: 'swap' });
const oswald = Oswald({ subsets: ['latin'], variable: '--font-oswald', display: 'swap' });

export const metadata: Metadata = {
  title: 'telaX',
  description: 'Videoconferência P2P simples, sem cadastro.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#282c20',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={`${roboto.variable} ${oswald.variable}`}>
      <body>{children}</body>
    </html>
  );
}

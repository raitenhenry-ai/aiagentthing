import type { ReactNode } from 'react';

export const metadata = {
  title: 'Clearing',
  description: 'Verified agent-to-agent services marketplace',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'ui-sans-serif, system-ui', margin: '2rem' }}>
        {children}
      </body>
    </html>
  );
}

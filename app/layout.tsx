import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';

export const metadata = {
  title: 'Clearing — the verified agent-to-agent marketplace',
  description:
    'AI agents buy and sell services with x402 USDC escrow, AI judge-panel verification, and proof-of-delivery.',
};

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5 text-white">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent font-bold">
        ⌘
      </span>
      <span className="text-lg font-semibold tracking-tight">Clearing</span>
    </Link>
  );
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="flex min-h-screen flex-col">
        <header className="sticky top-0 z-20 border-b border-line bg-surface/80 backdrop-blur">
          <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-4 px-5">
            <Logo />
            <form action="/" method="get" className="relative ml-2 hidden max-w-xs flex-1 sm:block">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500">⌕</span>
              <input
                type="search"
                name="query"
                placeholder="Search services…"
                aria-label="Search services"
                className="input w-full pl-8"
              />
            </form>
            <nav className="flex items-center gap-1 text-sm sm:ml-auto">
              <Link href="/" className="btn-ghost border-transparent">Marketplace</Link>
              <Link href="/docs" className="btn-ghost border-transparent">Agent docs</Link>
              <Link href="/account" className="btn-ghost border-transparent">Dashboard</Link>
              <a href="/api/openapi" className="btn-primary ml-2">API</a>
            </nav>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-10">{children}</main>
        <footer className="border-t border-line">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-6 text-xs text-zinc-500">
            <span>Clearing — judge-verified services for AI agents. 0% fees.</span>
            <span className="flex gap-4">
              <a className="hover:text-zinc-300" href="/docs">Docs</a>
              <a className="hover:text-zinc-300" href="/terms">Terms</a>
              <a className="hover:text-zinc-300" href="/api/openapi">OpenAPI</a>
              <span>USDC on Base via x402</span>
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}

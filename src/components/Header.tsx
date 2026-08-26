"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const nav = [
  { href: "/", label: "Home" },
  { href: "/schedule", label: "Schedule" },
  { href: "/prizes", label: "Prizes" },
  { href: "/volunteers", label: "Volunteers" },
  { href: "/sponsors", label: "Sponsors" },
  { href: "/resources", label: "Resources" },
];

export function Header() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-border/80 bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link href="/" className="group flex flex-col leading-tight">
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-neon">
            Groton
          </span>
          <span className="text-sm font-semibold text-foreground group-hover:text-blue-bright sm:text-base">
            NASA Space Apps Challenge
          </span>
        </Link>

        <button
          type="button"
          className="inline-flex items-center justify-center rounded-md border border-border px-3 py-2 text-sm text-foreground md:hidden"
          aria-expanded={open}
          aria-controls="primary-nav"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Close" : "Menu"}
        </button>

        <nav
          id="primary-nav"
          aria-label="Primary"
          className={`${open ? "flex" : "hidden"} absolute left-0 right-0 top-full flex-col gap-1 border-b border-border bg-surface p-4 md:static md:flex md:flex-row md:items-center md:gap-1 md:border-0 md:bg-transparent md:p-0`}
        >
          {nav.map((item) => {
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={`rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon ${
                  active
                    ? "bg-surface-2 text-neon"
                    : "text-muted hover:bg-surface-2 hover:text-foreground"
                }`}
                aria-current={active ? "page" : undefined}
              >
                {item.label}
              </Link>
            );
          })}
          <a
            href="https://www.spaceappschallenge.org/2026/local-events/groton"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center justify-center rounded-full bg-neon px-4 py-2 text-sm font-bold text-background transition hover:bg-neon-dim focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon md:ml-2 md:mt-0"
          >
            Official page
          </a>
        </nav>
      </div>
    </header>
  );
}

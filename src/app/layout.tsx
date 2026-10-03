import type { Metadata } from "next";
import { Fira_Mono, Overpass } from "next/font/google";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import "./globals.css";

const overpass = Overpass({
  variable: "--font-overpass",
  subsets: ["latin"],
  display: "swap",
});

const firaMono = Fira_Mono({
  variable: "--font-fira-mono",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "NASA Space Apps Challenge · Groton 2026",
    template: "%s · Space Apps Groton",
  },
  description:
    "Groton’s first NASA Space Apps Challenge weekend is fully remote and free. November 14–15, 2026. Anyone in the community can join.",
  openGraph: {
    title: "NASA Space Apps Challenge · Groton 2026",
    description:
      "Fully remote and free, November 14–15, 2026. Anyone in the community can join from wherever they are.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${overpass.variable} ${firaMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col font-sans">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-neon focus:px-3 focus:py-2 focus:text-sm focus:font-bold focus:text-background"
        >
          Skip to content
        </a>
        <Header />
        <main id="main" className="flex-1">
          {children}
        </main>
        <Footer />
      </body>
    </html>
  );
}

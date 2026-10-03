import type { Metadata } from "next";

export const metadata: Metadata = { title: "Prizes" };

export default function PrizesPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight">Prizes</h1>
      <p className="mt-3 max-w-2xl text-muted">
        This is a small community event. There is one judge and no prizes.
      </p>
    </div>
  );
}

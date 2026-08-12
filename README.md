# Space Apps Groton 2026

Local event site for the **NASA Space Apps Challenge** — Groton (Nov 14–15, 2026). Venue TBD (on-base Groton).

- **Ops owner:** Space Boi owns create/ops · **Local Lead:** Cara
- **Board:** https://github.com/caradmico/jarvis-operator/blob/main/ops/plans/06-space-apps.md
- **Register:** https://www.spaceappschallenge.org/2026/local-events/groton
- **Commits:** `space: <short>` (example: `space: scaffold Groton Space Apps local event app v0`)

## Stack

Next.js App Router · TypeScript · Tailwind CSS · Vercel-ready

## Pages

| Route | Purpose |
|-------|---------|
| `/` | Landing — dates, venue TBD, CTA, USO + MWR sponsor strip |
| `/schedule` | Sample 2-day agenda (cannot start before 9:00 AM local; local judging optional) |
| `/prizes` | Placeholder prize tiers |
| `/volunteers` | Low-lift roles + interest mailto stub |
| `/sponsors` | USO + MWR pitch placeholders + become-a-sponsor CTA |
| `/resources` | Official links; challenges Sep 17 (summaries) / Oct 28 (full) |

## Run

```bash
npm install
npm run dev
```

Open http://localhost:3000

```bash
npm run build
npm start
```

Bun also works (`bun install && bun run build`).

## Design

Mobile-first, accessible, dark/space aesthetic (blues + neon yellow). Fonts via `next/font`: Overpass + Fira Mono. No NASA meatball/worm logos. Copy uses **NASA Space Apps Challenge** (not “International”) and city **Groton**.

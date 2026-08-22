# Space Apps Groton 2026

Local event site for the **NASA Space Apps Challenge** -- Groton (Nov 14-15, 2026). Venue TBD (on-base Groton).

WIP. Fun lane: after a mill exam ship, or weekend. Do not open as empty-cycle filler.

- **Ops owner:** Space Boi owns create/ops -- **Local Lead:** Cara
- **Board:** https://github.com/caradmico/jarvis-operator/blob/main/ops/plans/06-space-apps.md
- **Houses:** https://github.com/caradmico/jarvis-operator/blob/main/ops/HOUSES.md
- **Register:** https://www.spaceappschallenge.org/2026/local-events/groton
- **Commits:** `space: <short>`

## Public site ($0)

GitHub Pages (static export): https://caradmico.github.io/space-apps-groton/

Resources (Star Visualizer first): https://caradmico.github.io/space-apps-groton/resources/

First-time only (free on this public repo): **Settings → Pages → Deploy from a branch → `gh-pages` / (root)**. Actions republishes `gh-pages` on push to `main`.

## Stack

Next.js App Router -- TypeScript -- Tailwind CSS -- GitHub Pages static export

## Pages

| Route | Purpose |
|-------|---------|
| `/` | Landing -- dates, venue TBD, CTA, USO + MWR sponsor strip |
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

```bash
npm run build
npm run preview
```

`next start` is a Node server and is not used for the public site. GitHub Actions
builds with `PAGES_BASE_PATH=/space-apps-groton` (project Pages).

Bun also works (`bun install && bun run build`).

## Design

Mobile-first, accessible, dark/space aesthetic (blues + neon yellow). Fonts via `next/font`: Overpass + Fira Mono. No NASA meatball/worm logos. Copy uses **NASA Space Apps Challenge** (not "International") and city **Groton**.

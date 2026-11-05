# moonlet website

The homepage and docs (spec [X85](../../docs/specs/X85-homepage.md)), built with Next.js from the session design in [`docs/design/marketing-homepage-for-moonlet/`](../../docs/design/marketing-homepage-for-moonlet/).

```sh
pnpm homepage                               # from the repo root: dev server on http://localhost:3100
pnpm --filter @moonlet/homepage build       # every page, built statically
pnpm --filter @moonlet/homepage test        # Vitest: the docs logic and links between pages
```

## Where things are

| Path | Contents |
|---|---|
| `app/page.tsx`, `app/home.css` | The homepage, from the design's `index.html` |
| `app/docs/`, `src/components/DocPage.tsx` | The docs pages, from the design's `docs.html` |
| `content/docs/*.md` | One Markdown file per docs page |
| `src/lib/docs.ts` | Front matter, the sidebar, previous and next, headings, notes and code highlighting |
| `styles/system/` | A copy of the moonlet design system's tokens, fonts and the components the site uses |

## Writing a docs page

Add `content/docs/<slug>.md`:

```md
---
title: Heavy commands
description: One sentence shown under the title.
group: Mesh            # Start here, Mesh, Work or Reference
order: 3               # its place in the group
tags: [macOS or Linux] # optional badges
---

## First heading
```

- Start with `##`; `##` and `###` headings make "On this page".
- `> **Note:** …` is a note. Fences in `sh`, `toml`, `json` and `ts` are highlighted.
- Link other pages as `/docs/<slug>`. The tests fail on a link to a page that does not exist.

## Hosting on Vercel

1. In Vercel, import the `1devstudio/moonlet` repository.
2. Set **Root Directory** to `apps/homepage`. The framework is Next.js (`vercel.json`); Vercel installs with pnpm from the workspace's `pnpm-lock.yaml`.
3. The repo pins pnpm in the root `package.json` (`packageManager`). If the install fails on the pnpm version, add the environment variable `ENABLE_EXPERIMENTAL_COREPACK=1` so Vercel uses that pnpm.

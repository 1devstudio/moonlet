# X85 — The moonlet website: a homepage and docs, hosted on Vercel

- **Status:** implemented (the Vercel project not yet connected)
- **Priority / phase:** P1 · phase 4
- **PRD refs:** the README's pitch (one mesh of machines and the phone, design systems and prototypes, start from a task, free and open source)
- **Related ADRs:** none
- **Design:** `docs/design/marketing-homepage-for-moonlet/` (pages `index.html` and `docs.html`)

## Summary

moonlet has no website: the README on GitHub is its only homepage. This spec adds one, in `apps/homepage`, built with Next.js and hosted on Vercel. It has two kinds of page, both copied from the session design:

- the **homepage**, which explains the mesh of machines, the phone, hosts and workers, design systems and prototypes, starting from a task, and that moonlet is free and open source;
- the **docs**, one page per entry of the design's docs sidebar, written in Markdown under `apps/homepage/content/docs/`.

The site uses the moonlet design system's own CSS (tokens, fonts and component classes), so it looks like the app.

The README's opening now makes the same pitch (asked for on 2026-11-05, before the site).

User decisions (2026-11-05): the code lives in `apps/homepage` in this repo; Next.js; every sidebar entry of the docs design gets a page; the repo carries the Vercel config, and the user connects the project in Vercel.

## User journey

1. A visitor opens the site's root. The homepage shows the hero ("Your agents, on every machine you own. Close the lid. They keep going."), the picture of three machines and the evening's four steps.
2. They scroll through the mesh features, hosts and workers, Design mode, Tasks, Free and open source, and Get started.
3. They click **Docs** in the top bar and land on the docs' first page. The sidebar lists every page in four groups. They open **Add an always-on host**, switch the install tabs between Linux and Mac, and follow "On this page" links to its headings.
4. On a phone, the top bar's **Menu** button shows and hides the docs sidebar.

## Behaviour and acceptance criteria

### The homepage (`index.html`)

- [x] `/` renders the design's homepage sections in its order: top bar (`index.html` m2), hero (m17), mesh (m107), hosts and workers (m406), design (m148), tasks (m225), free and open source (m371), get started (m352), footer (m363). (manual: the screenshots in the test plan)
- [x] The top bar's **Docs** link and the closing section's **Read the docs** button open `/docs`. The section links scroll to `#mesh`, `#phone`, `#design`, `#tasks` and `#open-source`.
- [x] **Download for macOS** links to `https://github.com/1devstudio/moonlet/releases/latest`, **GitHub** and **View the source** to `https://github.com/1devstudio/moonlet`, **Read the contributing guide** to the repo's `CONTRIBUTING.md`.
- [x] At 1024 px and below, and at 640 px and below, the page follows the design's two breakpoints (the hero stacks, then everything is one column).

### The docs (`docs.html`)

- [x] Every docs page is a Markdown file in `apps/homepage/content/docs/<slug>.md` with front matter `title`, `description`, `group`, `order` and optional `tags`. A file whose front matter lacks `title`, `group` or `order`, or names a group other than Start here, Mesh, Work and Reference, fails the build with the file's name. (`docs.test.ts`: "reads a page's front matter and body, and names it after its file", "fails with the file's name when the front matter lacks a title, an order or a known group")
- [x] The sidebar lists the pages under their group, groups in the order Start here, Mesh, Work, Reference, pages by `order`; the current page is marked (`aria-current="page"`). (`docs.test.ts`: "lists the groups in the design's order, each page by its order, and leaves out empty groups", "marks the page being read, and only that one")
- [x] `/docs` shows the first page of the first group. `/docs/<slug>` shows that page; an unknown slug is a 404. (`docs.test.ts`: "opens /docs on the first page of the first group", "finds a page by its slug, and nothing for a slug no page has"; the 404: manual, `curl` of `/docs/nope` against the built site)
- [x] A page shows breadcrumbs (Docs › group › title), the title, the description, its tags as badges, the body, Previous and Next links in sidebar order (none before the first page or after the last), and an "Edit this page on GitHub" link to the file on `main`. (`docs.test.ts`: "links the pages before and after in sidebar order, across groups", "has no previous page before the first, and no next page after the last", "links a page to its Markdown file on main"; the rest: manual, the screenshots)
- [x] "On this page" lists the body's `##` and `###` headings, `###` indented, each linking to the heading's id; ids are the heading text in lower case, runs of anything but letters and digits turned into `-`, with no `-` at either end, and `section` when nothing is left; when that id is taken, the heading gets the first free one of `-2`, `-3`, …. The entry of the section being read is marked as the page scrolls. (`docs.test.ts`: "gives each ## and ### heading an id, and lists them for On this page", "never gives two headings the same id, even when one's text looks like a numbered repeat"; the marking: manual)
- [x] A blockquote that starts with **Note:** renders as the design's note (`alert-box--note`). (`docs.test.ts`: "renders a blockquote that starts with Note: as the design's note, and leaves other quotes alone")
- [x] Code fences in `sh`, `toml`, `json` and `ts` are highlighted with the design system's syntax colours. (`docs.test.ts`: "highlights a toml fence with the design system's hljs classes", "highlights sh, json and ts fences too")
- [x] Links in a page to `/docs/<slug>` name pages that exist. (`docs.test.ts`: "lists the docs pages a body links to, without their #fragment", "finds only pages that exist, in every file of content/docs")
- [x] The install tabs on **Add an always-on host** switch between Linux and Mac; below 800 px the **Menu** button shows and hides the sidebar. (manual: clicked in headless Chrome over the DevTools protocol, 2026-11-05)

### Hosting

- [x] `pnpm --filter @moonlet/homepage build` builds every page statically, also after `pnpm dev` has run (`tsconfig.json` leaves out `.next/dev`, whose generated types fail this repo's `noUnusedLocals`).
- [x] `apps/homepage/vercel.json` names the framework, so a Vercel project whose Root Directory is `apps/homepage` builds it with pnpm from the workspace.
- [x] `pnpm check` typechecks the site and runs its tests.

## UI

The two pages of the design, at its three widths (1440, 834 and 390 px). The page CSS is the design's, split into a shared file (`app/globals.css`: base rules, the top bar, the wrap) and one file per page, scoped to it (`app/home.css` under `.home`, `app/docs/docs.css` under `.docs-site`).

Left out of `docs.html`:
- the Hosts settings figure (m134): the steps above it say the same, and a drawn settings screen goes stale;
- "Updated 5 November 2026" in the page footer (m207): the site has no per-page date; the footer names the license instead.

## Protocol and RPCs

None.

## Data and config

- `apps/homepage/content/docs/*.md`: the docs pages.
- `apps/homepage/styles/system/`: a copy of the moonlet design system's CSS and fonts (tokens, `base.css`, the components the pages use), from the design's system as of 2026-11-05.
- `apps/homepage/public/moonlet-icon.svg` (the top bar's logo), `app/icon.svg` and `app/apple-icon.png`: the desktop app's icon, copied from `apps/desktop/src-tauri/icons/` (`source/icon-32.svg` and `icon.png`).
- `apps/homepage/vercel.json`.

## Security considerations

The Markdown is the repo's own, written by its maintainers, and is rendered at build time. Raw HTML in a page is a convention, not a check: only the install tabs use it, and review keeps it that way. The site has no server code, forms or cookies.

## Out of scope

- Search: the search box is shown but does nothing yet.
- A blog, a changelog page, analytics, a custom domain.
- Deploying: the user connects the repo in Vercel.

## Test plan

- Vitest (`apps/homepage/src/lib/docs.test.ts`): front matter validation, sidebar order and the current page, previous and next, the page `/docs` opens, finding a page, the edit link, heading ids and "On this page", notes, code highlighting, links between pages.
- Manual: build, start, and screenshot `/` and `/docs/add-an-always-on-host` at 1440, 834 and 390 px; compare with the design.

## Open questions

- The iPhone app has no public download yet; the homepage's **Pair your phone** button links to the docs page.

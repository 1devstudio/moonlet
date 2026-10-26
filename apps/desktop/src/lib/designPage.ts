// A workspace design's page and its file (X65): `index` is
// `pages/index.html` in the design's folder. One build and one parse.

/** The page's file name, `<page>.html`. */
export function pageFile(page: string): string {
  return `${page}.html`;
}

/** The page's path in its design's folder, `pages/<page>.html`. */
export function pagePath(page: string): string {
  return `pages/${pageFile(page)}`;
}

/** A page's name, `index` for `pages/index.html`, as the daemon takes it
 *  (`is_page_name` in design/pages.rs): not empty, no folder, no hidden
 *  file, and no `@`, which names a snapshot's folder (`designs/<slug>@<n>/`). */
export function isPageName(page: string): boolean {
  return page !== "" && !page.startsWith(".") && !/[/\\\0@]/.test(page);
}

/** The page a file name (`<page>.html`) is, or null: the parse of {@link pageFile}. */
export function pageOfFile(file: string): string | null {
  const page = file.endsWith(".html") ? file.slice(0, -".html".length) : null;
  return page !== null && isPageName(page) ? page : null;
}

/** The page a path in the design's folder is, or null for any other file. */
export function pageOfPath(path: string): string | null {
  return path.startsWith("pages/") ? pageOfFile(path.slice("pages/".length)) : null;
}

/** A page as a line of a message to the design's agent names it (X65):
 *  `<page>.html`, or, for a session design, whose designs share the
 *  session's agent, its path in the worktree, `<folder>/pages/<page>.html`. */
export function linePage(page: string, folder: string | null): string {
  return folder ? `${folder}/${pagePath(page)}` : pageFile(page);
}

/** The page and folder {@link linePage} wrote, read back; null for
 *  anything else. */
export function pageOfLine(text: string): { page: string; folder: string | null } | null {
  const at = text.lastIndexOf("/pages/");
  if (at < 0) {
    const page = pageOfFile(text);
    return page === null ? null : { page, folder: null };
  }
  const page = pageOfFile(text.slice(at + "/pages/".length));
  const folder = text.slice(0, at);
  return page === null || folder === "" ? null : { page, folder };
}

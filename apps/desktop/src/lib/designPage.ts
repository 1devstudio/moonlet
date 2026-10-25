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

/** The page a path in the design's folder is, or null for any other file. */
export function pageOfPath(path: string): string | null {
  return /^pages\/([^/]+)\.html$/.exec(path)?.[1] ?? null;
}

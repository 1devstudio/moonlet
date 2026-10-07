/**
 * File-type icons of the Files tab (X25), named after the SVGs of the
 * `material-icon-theme` package that `components/FileIcon.tsx` bundles.
 */
export type FileIconId =
  | "astro" | "audio" | "babel" | "biome" | "c" | "certificate" | "changelog" | "codeowners" | "console" | "cpp" | "csharp" | "css"
  | "dart" | "database" | "docker" | "document" | "editorconfig" | "eslint" | "font" | "git" | "gitlab" | "go" | "graphql"
  | "h" | "hpp" | "html" | "husky" | "image" | "java" | "javascript" | "json" | "key" | "kotlin" | "license" | "lock" | "log"
  | "lua" | "makefile" | "markdown" | "mdx" | "nix" | "nodejs" | "npm" | "pdf" | "php" | "pnpm" | "prettier" | "python"
  | "react" | "react_ts" | "readme" | "ruby" | "rust" | "sass" | "settings" | "svelte" | "svg" | "swift" | "tailwindcss"
  | "tauri" | "terraform" | "test-js" | "test-jsx" | "test-ts" | "toml" | "tsconfig" | "tune" | "typescript"
  | "typescript-def" | "video" | "vite" | "vitest" | "vue" | "xml" | "yaml" | "yarn" | "zip";

/** Whole file names, lower-cased. */
const NAMES: Record<string, FileIconId> = {
  ".gitignore": "git",
  ".gitattributes": "git",
  ".gitmodules": "git",
  ".gitkeep": "git",
  ".mailmap": "git",
  ".gitlab-ci.yml": "gitlab",
  ".npmrc": "npm",
  ".npmignore": "npm",
  "package.json": "nodejs",
  "package-lock.json": "npm",
  ".nvmrc": "nodejs",
  ".node-version": "nodejs",
  "pnpm-lock.yaml": "pnpm",
  "pnpm-workspace.yaml": "pnpm",
  ".pnpmfile.cjs": "pnpm",
  "yarn.lock": "yarn",
  ".yarnrc": "yarn",
  ".yarnrc.yml": "yarn",
  ".prettierignore": "prettier",
  "dockerfile": "docker",
  ".dockerignore": "docker",
  "cargo.toml": "rust",
  "cargo.lock": "rust",
  "rust-toolchain": "rust",
  "rust-toolchain.toml": "rust",
  "codeowners": "codeowners",
  "license": "license",
  "license.md": "license",
  "license.txt": "license",
  "licence": "license",
  "copying": "license",
  "readme.md": "readme",
  "readme": "readme",
  "changelog.md": "changelog",
  "changelog": "changelog",
  "makefile": "makefile",
  "gnumakefile": "makefile",
  ".editorconfig": "editorconfig",
  "biome.json": "biome",
  "biome.jsonc": "biome",
  ".babelrc": "babel",
  "tauri.conf.json": "tauri",
  "go.mod": "go",
  "go.sum": "go",
  "gemfile": "ruby",
  "flake.nix": "nix",
};

/** Families of names: `.env.local`, `vite.config.ts`, `tsconfig.app.json`… */
const PATTERNS: [RegExp, FileIconId][] = [
  [/^\.env(\..+)?$/, "tune"],
  [/^\.prettierrc/, "prettier"],
  [/^prettier\.config\./, "prettier"],
  [/^\.eslintrc/, "eslint"],
  [/^eslint\.config\./, "eslint"],
  [/^tsconfig(\..+)?\.json$/, "tsconfig"],
  [/^vite\.config\./, "vite"],
  [/^vitest\.(config|workspace)\./, "vitest"],
  [/^tailwind\.config\./, "tailwindcss"],
  [/^babel\.config\./, "babel"],
  [/^(docker-)?compose(\..+)?\.ya?ml$/, "docker"],
  [/^dockerfile\./, "docker"],
  [/^\.husky$/, "husky"],
];

/** Extensions without the dot, lower-cased; compound ones like `test.ts` win over `ts`. */
const EXTENSIONS: Record<string, FileIconId> = {
  json: "json",
  jsonc: "json",
  json5: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  xml: "xml",
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  txt: "document",
  log: "log",
  lock: "lock",
  ini: "settings",
  conf: "settings",
  cfg: "settings",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  "d.ts": "typescript-def",
  "d.mts": "typescript-def",
  tsx: "react_ts",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "react",
  "test.ts": "test-ts",
  "spec.ts": "test-ts",
  "test.tsx": "test-jsx",
  "spec.tsx": "test-jsx",
  "test.js": "test-js",
  "spec.js": "test-js",
  "test.jsx": "test-jsx",
  "spec.jsx": "test-jsx",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  html: "html",
  htm: "html",
  css: "css",
  scss: "sass",
  sass: "sass",
  rs: "rust",
  go: "go",
  py: "python",
  rb: "ruby",
  php: "php",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  dart: "dart",
  cs: "csharp",
  c: "c",
  h: "h",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "hpp",
  lua: "lua",
  nix: "nix",
  tf: "terraform",
  tfvars: "terraform",
  graphql: "graphql",
  gql: "graphql",
  sql: "database",
  sqlite: "database",
  db: "database",
  sh: "console",
  bash: "console",
  zsh: "console",
  fish: "console",
  ps1: "console",
  svg: "svg",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  ico: "image",
  bmp: "image",
  icns: "image",
  mp4: "video",
  mov: "video",
  webm: "video",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  flac: "audio",
  ttf: "font",
  otf: "font",
  woff: "font",
  woff2: "font",
  pdf: "pdf",
  zip: "zip",
  tar: "zip",
  gz: "zip",
  tgz: "zip",
  "7z": "zip",
  pem: "certificate",
  crt: "certificate",
  cer: "certificate",
  key: "key",
};

/**
 * The icon of a file, by its whole name first, then by its longest known
 * extension; null for the plain file icon.
 */
export function fileIcon(name: string): FileIconId | null {
  const n = name.toLowerCase();
  if (NAMES[n]) return NAMES[n];
  for (const [re, icon] of PATTERNS) if (re.test(n)) return icon;
  // "a.test.ts" tries "test.ts", then "ts"; a leading dot is not an extension.
  const parts = n.replace(/^\.+/, "").split(".");
  for (let i = 1; i < parts.length; i++) {
    const icon = EXTENSIONS[parts.slice(i).join(".")];
    if (icon) return icon;
  }
  return null;
}

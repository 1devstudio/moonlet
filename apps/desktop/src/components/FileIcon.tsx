import { File, Folder, FolderOpen } from "lucide-react";
import { fileIcon, type FileIconId } from "../lib/fileIcons";
import i_astro from "material-icon-theme/icons/astro.svg";
import i_audio from "material-icon-theme/icons/audio.svg";
import i_babel from "material-icon-theme/icons/babel.svg";
import i_biome from "material-icon-theme/icons/biome.svg";
import i_c from "material-icon-theme/icons/c.svg";
import i_certificate from "material-icon-theme/icons/certificate.svg";
import i_changelog from "material-icon-theme/icons/changelog.svg";
import i_codeowners from "material-icon-theme/icons/codeowners.svg";
import i_console from "material-icon-theme/icons/console.svg";
import i_cpp from "material-icon-theme/icons/cpp.svg";
import i_csharp from "material-icon-theme/icons/csharp.svg";
import i_css from "material-icon-theme/icons/css.svg";
import i_dart from "material-icon-theme/icons/dart.svg";
import i_database from "material-icon-theme/icons/database.svg";
import i_docker from "material-icon-theme/icons/docker.svg";
import i_document from "material-icon-theme/icons/document.svg";
import i_editorconfig from "material-icon-theme/icons/editorconfig.svg";
import i_eslint from "material-icon-theme/icons/eslint.svg";
import i_font from "material-icon-theme/icons/font.svg";
import i_git from "material-icon-theme/icons/git.svg";
import i_gitlab from "material-icon-theme/icons/gitlab.svg";
import i_go from "material-icon-theme/icons/go.svg";
import i_graphql from "material-icon-theme/icons/graphql.svg";
import i_h from "material-icon-theme/icons/h.svg";
import i_hpp from "material-icon-theme/icons/hpp.svg";
import i_html from "material-icon-theme/icons/html.svg";
import i_husky from "material-icon-theme/icons/husky.svg";
import i_image from "material-icon-theme/icons/image.svg";
import i_java from "material-icon-theme/icons/java.svg";
import i_javascript from "material-icon-theme/icons/javascript.svg";
import i_json from "material-icon-theme/icons/json.svg";
import i_key from "material-icon-theme/icons/key.svg";
import i_kotlin from "material-icon-theme/icons/kotlin.svg";
import i_license from "material-icon-theme/icons/license.svg";
import i_lock from "material-icon-theme/icons/lock.svg";
import i_log from "material-icon-theme/icons/log.svg";
import i_lua from "material-icon-theme/icons/lua.svg";
import i_makefile from "material-icon-theme/icons/makefile.svg";
import i_markdown from "material-icon-theme/icons/markdown.svg";
import i_mdx from "material-icon-theme/icons/mdx.svg";
import i_nix from "material-icon-theme/icons/nix.svg";
import i_nodejs from "material-icon-theme/icons/nodejs.svg";
import i_npm from "material-icon-theme/icons/npm.svg";
import i_pdf from "material-icon-theme/icons/pdf.svg";
import i_php from "material-icon-theme/icons/php.svg";
import i_pnpm from "material-icon-theme/icons/pnpm.svg";
import i_prettier from "material-icon-theme/icons/prettier.svg";
import i_python from "material-icon-theme/icons/python.svg";
import i_react from "material-icon-theme/icons/react.svg";
import i_react_ts from "material-icon-theme/icons/react_ts.svg";
import i_readme from "material-icon-theme/icons/readme.svg";
import i_ruby from "material-icon-theme/icons/ruby.svg";
import i_rust from "material-icon-theme/icons/rust.svg";
import i_sass from "material-icon-theme/icons/sass.svg";
import i_settings from "material-icon-theme/icons/settings.svg";
import i_svelte from "material-icon-theme/icons/svelte.svg";
import i_svg from "material-icon-theme/icons/svg.svg";
import i_swift from "material-icon-theme/icons/swift.svg";
import i_tailwindcss from "material-icon-theme/icons/tailwindcss.svg";
import i_tauri from "material-icon-theme/icons/tauri.svg";
import i_terraform from "material-icon-theme/icons/terraform.svg";
import i_test_js from "material-icon-theme/icons/test-js.svg";
import i_test_jsx from "material-icon-theme/icons/test-jsx.svg";
import i_test_ts from "material-icon-theme/icons/test-ts.svg";
import i_toml from "material-icon-theme/icons/toml.svg";
import i_tsconfig from "material-icon-theme/icons/tsconfig.svg";
import i_tune from "material-icon-theme/icons/tune.svg";
import i_typescript from "material-icon-theme/icons/typescript.svg";
import i_typescript_def from "material-icon-theme/icons/typescript-def.svg";
import i_video from "material-icon-theme/icons/video.svg";
import i_vite from "material-icon-theme/icons/vite.svg";
import i_vitest from "material-icon-theme/icons/vitest.svg";
import i_vue from "material-icon-theme/icons/vue.svg";
import i_xml from "material-icon-theme/icons/xml.svg";
import i_yaml from "material-icon-theme/icons/yaml.svg";
import i_yarn from "material-icon-theme/icons/yarn.svg";
import i_zip from "material-icon-theme/icons/zip.svg";

/** SVGs from material-icon-theme (MIT), bundled at build time (X25). */
const ICONS: Record<FileIconId, string> = {
  astro: i_astro,
  audio: i_audio,
  babel: i_babel,
  biome: i_biome,
  c: i_c,
  certificate: i_certificate,
  changelog: i_changelog,
  codeowners: i_codeowners,
  console: i_console,
  cpp: i_cpp,
  csharp: i_csharp,
  css: i_css,
  dart: i_dart,
  database: i_database,
  docker: i_docker,
  document: i_document,
  editorconfig: i_editorconfig,
  eslint: i_eslint,
  font: i_font,
  git: i_git,
  gitlab: i_gitlab,
  go: i_go,
  graphql: i_graphql,
  h: i_h,
  hpp: i_hpp,
  html: i_html,
  husky: i_husky,
  image: i_image,
  java: i_java,
  javascript: i_javascript,
  json: i_json,
  key: i_key,
  kotlin: i_kotlin,
  license: i_license,
  lock: i_lock,
  log: i_log,
  lua: i_lua,
  makefile: i_makefile,
  markdown: i_markdown,
  mdx: i_mdx,
  nix: i_nix,
  nodejs: i_nodejs,
  npm: i_npm,
  pdf: i_pdf,
  php: i_php,
  pnpm: i_pnpm,
  prettier: i_prettier,
  python: i_python,
  react: i_react,
  react_ts: i_react_ts,
  readme: i_readme,
  ruby: i_ruby,
  rust: i_rust,
  sass: i_sass,
  settings: i_settings,
  svelte: i_svelte,
  svg: i_svg,
  swift: i_swift,
  tailwindcss: i_tailwindcss,
  tauri: i_tauri,
  terraform: i_terraform,
  "test-js": i_test_js,
  "test-jsx": i_test_jsx,
  "test-ts": i_test_ts,
  toml: i_toml,
  tsconfig: i_tsconfig,
  tune: i_tune,
  typescript: i_typescript,
  "typescript-def": i_typescript_def,
  video: i_video,
  vite: i_vite,
  vitest: i_vitest,
  vue: i_vue,
  xml: i_xml,
  yaml: i_yaml,
  yarn: i_yarn,
  zip: i_zip,
};

/** A file's type icon, or the outline file icon; folders get the outline folder. */
export function FileIcon({ name, dir = false, open = false }: { name: string; dir?: boolean; open?: boolean }) {
  if (dir) return open ? <FolderOpen size={16} strokeWidth={1.5} className="shrink-0 text-muted" /> : <Folder size={16} strokeWidth={1.5} className="shrink-0 text-muted" />;
  const icon = fileIcon(name);
  if (!icon) return <File size={16} strokeWidth={1.5} className="shrink-0 text-muted" />;
  return <img src={ICONS[icon]} alt="" data-icon={icon} draggable={false} className="h-4 w-4 shrink-0" />;
}

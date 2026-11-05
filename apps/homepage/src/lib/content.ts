// Reads the docs pages from content/docs at build time (X85).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Doc, parseDoc } from "./docs";

const DIR = join(process.cwd(), "content/docs");

let cache: Doc[] | undefined;

/** Every docs page, parsed; a broken page fails the build with its file name. */
export function allDocs(): Doc[] {
  cache ??= readdirSync(DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => parseDoc(f, readFileSync(join(DIR, f), "utf8")));
  return cache;
}

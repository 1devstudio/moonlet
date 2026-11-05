import type { Metadata } from "next";
import { DocPage } from "@/components/DocPage";
import { allDocs } from "@/lib/content";
import { docsNav } from "@/lib/docs";
import "./docs.css";

// /docs is the first page of the first group (X85).
function firstDoc() {
  const docs = allDocs();
  const slug = docsNav(docs)[0].pages[0].slug;
  return { docs, doc: docs.find((d) => d.slug === slug)! };
}

export function generateMetadata(): Metadata {
  const { doc } = firstDoc();
  return { title: doc.title, description: doc.description };
}

export default function Page() {
  const { doc, docs } = firstDoc();
  return <DocPage doc={doc} docs={docs} />;
}

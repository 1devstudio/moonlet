import type { Metadata } from "next";
import { DocPage } from "@/components/DocPage";
import { allDocs } from "@/lib/content";
import { firstDoc } from "@/lib/docs";
import "./docs.css";

// /docs is the first page of the first group (X85).
export function generateMetadata(): Metadata {
  const doc = firstDoc(allDocs());
  return { title: doc.title, description: doc.description };
}

export default function Page() {
  const docs = allDocs();
  return <DocPage doc={firstDoc(docs)} docs={docs} />;
}

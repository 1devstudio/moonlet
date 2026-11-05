import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocPage } from "@/components/DocPage";
import { allDocs } from "@/lib/content";
import "../docs.css";

type Props = { params: Promise<{ slug: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return allDocs().map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const doc = allDocs().find((d) => d.slug === slug);
  return doc ? { title: doc.title, description: doc.description } : {};
}

export default async function Page({ params }: Props) {
  const { slug } = await params;
  const docs = allDocs();
  const doc = docs.find((d) => d.slug === slug);
  if (!doc) notFound();
  return <DocPage doc={doc} docs={docs} />;
}

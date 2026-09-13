import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import "katex/dist/katex.min.css";

export async function generateMetadata(): Promise<Metadata> {
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") || incoming.get("host") || "localhost:3000";
  const protocol = incoming.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const base = new URL(`${protocol}://${host}`);
  const title = "LearnFlow｜大学课程学习与期末冲刺 Agent";
  const description = "把课程资料变成可追问的知识图谱，并联动作业辅导、零前置讲解与期末复习路线。";
  return {
    metadataBase: base,
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      images: [{ url: new URL("/og.png", base).toString(), width: 1731, height: 909, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [new URL("/og.png", base).toString()],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

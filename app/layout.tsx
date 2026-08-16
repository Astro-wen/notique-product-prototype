import type { Metadata } from "next";
import "./globals.css";
import { NotiqueQueryProvider } from "./query-provider";

export const metadata: Metadata = {
  title: "Notique AI · Evidence-backed project records",
  description: "Turn transcripts and supporting materials into reviewable, evidence-linked project records.",
  icons: {
    icon: "/favicon.svg",
  },
  openGraph: {
    title: "Notique AI · Evidence-backed project records",
    description: "Review every important record against its original evidence before it becomes part of a project.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Notique AI · Evidence-backed project records",
    description: "Review every important record against its original evidence before it becomes part of a project.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        <NotiqueQueryProvider>{children}</NotiqueQueryProvider>
      </body>
    </html>
  );
}

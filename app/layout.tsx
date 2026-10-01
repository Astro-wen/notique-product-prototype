import type { Metadata } from "next";
import "./globals.css";
import { NotiqueQueryProvider } from "./query-provider";

export const metadata: Metadata = {
  title: "Notique AI",
  description: "上传录音、逐字稿或笔记，查看原文、整理重点并记录跟进结果。",
  icons: {
    icon: "/favicon.svg",
  },
  openGraph: {
    title: "Notique AI",
    description: "查看沟通记录和原文，确认重点并记录跟进结果。",
  },
  twitter: {
    card: "summary_large_image",
    title: "Notique AI",
    description: "查看沟通记录和原文，确认重点并记录跟进结果。",
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

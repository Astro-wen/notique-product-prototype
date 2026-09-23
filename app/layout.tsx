import type { Metadata } from "next";
import "./globals.css";
import { NotiqueQueryProvider } from "./query-provider";

export const metadata: Metadata = {
  title: "Notique AI",
  description: "上传录音或逐字稿，自动整理重点、原话、待确认内容和下一步。",
  icons: {
    icon: "/favicon.svg",
  },
  openGraph: {
    title: "Notique AI",
    description: "边读、边听、边处理；重要信息始终可以回到原话。",
  },
  twitter: {
    card: "summary_large_image",
    title: "Notique AI",
    description: "边读、边听、边处理；重要信息始终可以回到原话。",
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

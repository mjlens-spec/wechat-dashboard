import type { Metadata } from "next";
import SessionHeartbeat from '@/components/SessionHeartbeat';
import "./globals.css";

export const metadata: Metadata = {
  title: "Chat Dashboard · 微信与飞书分析",
  description: "Private local dashboard for encrypted WeChat and Feishu chat analysis",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full" suppressHydrationWarning>
      <body className="min-h-full">
        <a className="skip-link" href="#main-content">跳到主要内容</a>
        <SessionHeartbeat />
        {children}
      </body>
    </html>
  );
}

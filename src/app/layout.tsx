import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "WingRate - KHR/USD Tracker",
  description: "Real-time exchange rate tracker for Wing Bank KHR/USD",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "WingRate",
  },
};

export const viewport = {
  themeColor: "#E73E3E",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

import PWARegistration from '@/components/PWARegistration';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="text-slate-100 antialiased min-h-screen">
        <PWARegistration />
        {children}
      </body>
    </html>
  );
}

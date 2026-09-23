import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import PWARegistration from "@/components/PWARegistration";

const BRAND = "#4f46e5";
const DARK = "#0a0e1a";

export const metadata: Metadata = {
  title: "WingRate - KHR/USD Tracker",
  description: "Real-time exchange rate tracker for Wing Bank KHR/USD",
  manifest: "/manifest.json",
  applicationName: "WingRate",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "16x16 32x32", type: "image/x-icon" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    // iOS home-screen icon (opaque, 180x180, iOS rounds the corners itself)
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "WingRate",
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: DARK },
    { media: "(prefers-color-scheme: light)", color: DARK },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // Required so the dark app fills the notch / Dynamic Island area on iOS 26.
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="text-slate-100 antialiased min-h-screen">
        <PWARegistration />
        {children}
      </body>
    </html>
  );
}

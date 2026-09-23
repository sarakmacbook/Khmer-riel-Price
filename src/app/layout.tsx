import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import PWARegistration from "@/components/PWARegistration";

const DARK = "#0a0e1a";

export const metadata: Metadata = {
  title: "WingRate - KHR/USD Tracker",
  description: "Real-time exchange rate tracker for Wing Bank KHR/USD",
  manifest: "/manifest.json",
  applicationName: "WingRate",
  icons: {
    // Browser tab (modern browsers use the scalable vector, others the .ico)
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48 64x64", type: "image/x-icon" },
      { url: "/icons/icon-48.png", sizes: "48x48", type: "image/png" },
      { url: "/icons/icon-96.png", sizes: "96x96", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    // iOS home-screen icons — opaque, iOS applies its own rounded corners.
    // Covers every iPhone/iPad generation incl. iPadOS 26.
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
      { url: "/apple-touch-icon-167.png", sizes: "167x167", type: "image/png" },
      { url: "/apple-touch-icon-152.png", sizes: "152x152", type: "image/png" },
      { url: "/apple-touch-icon-120.png", sizes: "120x120", type: "image/png" },
      { url: "/apple-touch-icon-76.png", sizes: "76x76", type: "image/png" },
    ],
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
  // Lets the dark UI fill the notch / Dynamic Island on iOS 26.
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

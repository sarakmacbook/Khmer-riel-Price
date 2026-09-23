"use strict";

// Kept as a small reference for deployments that inspect the public folder.
// The served manifest is public/manifest.json.
const manifest = {
  name: "WingRate — KHR/USD Tracker",
  short_name: "WingRate",
  description: "Live Wing Bank USD/KHR exchange rate, price history and alerts.",
  start_url: "/",
  scope: "/",
  id: "/",
  display: "standalone",
  orientation: "portrait",
  background_color: "#0a0e1a",
  theme_color: "#4f46e5",
  icons: [
    { src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icons/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
    { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

console.log(JSON.stringify(manifest, null, 2));

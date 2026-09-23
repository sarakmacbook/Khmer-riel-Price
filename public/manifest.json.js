"use strict";

/**
 * @typedef {Object} PWAConfig
 * @property {string} name
 * @property {string} short_name
 * @property {string} start_url
 * @property {string} display
 * @property {string} background_color
 * @property {string} theme_color
 * @property {Array<{src: string, sizes: string[], type: string}>} icons
 */

/** @type {PWAConfig} */
const manifest = {
  name: "Wing Bank Rate Tracker",
  short_name: "WingRate",
  start_url: "/",
  display: "standalone",
  background_color: "#ffffff",
  theme_color: "#E73E3E",
  icons: [
    {
      src: "/icons/icon-192x192.png",
      sizes: "192x192",
      type: "image/png",
    },
    {
      src: "/icons/icon-512x512.png",
      sizes: "512x512",
      type: "image/png",
    },
  ],
};

console.log(JSON.stringify(manifest, null, 2));

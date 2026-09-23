"use client";

import { useEffect } from 'react';

export default function PWARegistration() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', async () => {
        try {
          await navigator.serviceWorker.register('/sw.js');
          console.log('Service worker registered successfully');
        } catch (error) {
          console.error('Service worker registration failed:', error);
        }
      });
    }
  }, []);

  return null;
}

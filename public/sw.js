// Minimal service worker: installability + notifications.
// No fetch handler on purpose — it would intercept every API poll for no benefit.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'WingRate', body: 'Check the latest KHR/USD rate!' };
  event.waitUntil(
    self.registration.showNotification(data.title || 'WingRate', {
      body: data.body,
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-192x192.png',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => 'focus' in c);
      return open ? open.focus() : self.clients.openWindow('/');
    }),
  );
});

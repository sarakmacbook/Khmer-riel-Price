self.addEventListener('install', (event) => {
  console.log('SW installed');
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'Rate Update', body: 'Check the latest KHR/USD rate!' };
  const options = {
    body: data.body,
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-192x192.png',
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

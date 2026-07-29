// خدمة الإشعارات بالخلفية — تشتغل حتى لو التطبيق مقفل أو التبويب مسكر
// وجودها مع ملف manifest.json هو اللي يخلي "إضافة للشاشة الرئيسية" تشتغل متل تطبيق حقيقي
self.addEventListener('fetch', () => {}); // مرّرها للشبكة عادي، ماكو تخزين مؤقت حالياً

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  const title = data.title || 'جايك';
  const options = {
    body: data.body || '',
    icon: '/logo.png',
    badge: '/logo.png',
    dir: 'rtl',
    lang: 'ar',
    vibrate: [200, 100, 200],
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes(url) && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

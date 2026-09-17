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
    // اهتزاز أطول للطلب الجديد حتى ينتبه السائق وهو سايق
    vibrate: data.urgent ? [300, 120, 300, 120, 300] : [200, 100, 200],
    // الطلب يبقى معروض بالشاشة لحد ما يضغطه — ما يختفي لحاله ويفوت السائق
    requireInteraction: !!data.urgent,
    // tag ثابت للطلب الواحد: لو وصل نفس الإشعار مرتين ما يتكرر بالشاشة
    tag: data.rideId ? ('ride-' + data.rideId) : undefined,
    renotify: !!data.urgent,
    data: { url: data.url || '/', rideId: data.rideId || null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const url = d.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const forDriver = url.includes('/driver');
      // لو التطبيق مفتوح بالخلفية: نرجع له نفسه ونخبره يتأكد من حالة الرحلة.
      // قبل كان هذا للسائق بس — إشعار الزبون كان يفتح نافذة جديدة، وبالآيفون
      // تنفتح أحياناً بسفاري (مو مسجّل دخول بيها) فما يطلع المبلغ والتقييم.
      for (const c of list) {
        const isDriver = c.url.includes('/driver');
        const isCustomer = c.url.includes('/index.html') || c.url.includes('/ride');
        if ((forDriver ? isDriver : isCustomer) && 'focus' in c) {
          c.postMessage({ type: forDriver ? 'ride:show' : 'ride:check', rideId: d.rideId || null });
          return c.focus();
        }
      }
      // مقفل تماماً: افتحه على رابط فيه رقم الطلب
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

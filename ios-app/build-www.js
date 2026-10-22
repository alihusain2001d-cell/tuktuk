/* ═══════════════════════════════════════════════════════════════
   يجهّز ملفات تطبيق الآيفون من صفحات موقع جايك

   ليش سكربت مو نسخ باليد: كل ما نعدّل الموقع، نشغّل هذا الملف
   ويطلع التطبيق محدّث. لو نسخنا باليد، أول تعديل ينسى واحد
   منهن ويصير التطبيق مختلف عن الموقع.

   التشغيل:  node build-www.js
   ═══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');   // صفحات الموقع بجذر المستودع
const OUT = path.join(__dirname, 'www');
const HOST = 'https://tuktuk-production-d336.up.railway.app';

/* الجسر: ينحقن بأول كل صفحة.

   الصفحات بالتطبيق تنفتح من الجهاز نفسه (capacitor://localhost) مو
   من السيرفر. فأي طلب يبدي بـ"/" يروح يدوّر على ملف بالموبايل بدل
   ما يوصل لجايك. هنا نوجّه الطلبات والاتصال المباشر لسيرفرنا.

   وبالمتصفح العادي ما يسوي شي — الصفحة نفسها تشتغل بالمكانين. */
const BRIDGE = `<script>
(function () {
  var HOST = '${HOST}';
  var native = location.protocol !== 'http:' && location.protocol !== 'https:';
  window.JAYAK_NATIVE = native;
  window.JAYAK_HOST = native ? HOST : '';
  if (!native) return;

  var realFetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === 'string' && input.charAt(0) === '/') {
      input = HOST + input;
    } else if (input && typeof input === 'object' && typeof input.url === 'string' && input.url.indexOf('capacitor') === 0) {
      input = new Request(HOST + new URL(input.url).pathname + new URL(input.url).search, input);
    }
    return realFetch.call(window, input, init);
  };

  /* رقم نسخة التطبيق المنصّبة — الصفحة تقارنه بأقل نسخة تقبلها
     الإدارة، وتطلب التحديث إذا كان أقدم. */
  window.jayakAppVersion = function () {
    var A = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (!A || !A.getInfo) return Promise.resolve(null);
    return A.getInfo().then(function (i) { return (i && i.version) || null; }).catch(function () { return null; });
  };

  /* الإشعارات: آبل تمنع إشعارات المتصفح جوّا التطبيقات، فنسجّل عند
     آبل نفسها وناخذ رمز الجهاز. الصفحة تنادي هاي وترسل الرمز
     للسيرفر. نرجّع null لو الزبون رفض أو تأخر الجواب — والصفحة
     تكمل عادي بلا إشعارات بدل ما تعلق. */
  window.jayakNativePushToken = function () {
    return new Promise(function (resolve) {
      var P = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications;
      if (!P) return resolve(null);

      var done = false;
      var finish = function (t) { if (!done) { done = true; resolve(t || null); } };

      P.addListener('registration', function (t) { finish(t && t.value); });
      P.addListener('registrationError', function () { finish(null); });

      P.requestPermissions()
        .then(function (r) { r && r.receive === 'granted' ? P.register() : finish(null); })
        .catch(function () { finish(null); });

      setTimeout(function () { finish(null); }, 12000);
    });
  };

  /* ضغط الإشعار يفتح الشاشة الصح — السيرفر يرسل الرابط مع الإشعار */
  (function () {
    var P = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications;
    if (!P) return;
    P.addListener('pushNotificationActionPerformed', function (e) {
      var url = e && e.notification && e.notification.data && e.notification.data.url;
      if (!url) return;
      if (url.indexOf('/driver') === 0) location.href = 'driver.html';
      else if (url.indexOf('/ride') === 0) location.href = 'ride.html';
    });
  })();

  var RealWS = window.WebSocket;
  function PatchedWS(url, protocols) {
    if (typeof url === 'string' && !/^wss?:\\/\\/[^/]*tuktuk/.test(url)) {
      url = HOST.replace(/^https/, 'wss');
    }
    return protocols ? new RealWS(url, protocols) : new RealWS(url);
  }
  PatchedWS.prototype = RealWS.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k, i) { PatchedWS[k] = i; });
  window.WebSocket = PatchedWS;
})();
</script>`;

// الصفحة الرئيسية بالتطبيق لازم تكون index.html، وصفحة الزبون عندنا
// اسمها index.html هم — فنعيد تسميتها ride.html ونخلي شاشة الاختيار بمكانها
const PAGES = [
  { from: 'home.html', to: 'index.html' },
  { from: 'index.html', to: 'ride.html' },
  { from: 'driver.html', to: 'driver.html' },
  { from: 'privacy.html', to: 'privacy.html' },
  { from: 'delete-account.html', to: 'delete-account.html' },
];

const ASSETS = ['logo.png', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
  'manifest.json', 'manifest-customer.json', 'manifest-driver.json'];

// المسارات اللي السيرفر يترجمها لصفحات — بالتطبيق تصير ملفات
const LINKS = [
  ['href="/"', 'href="index.html"'],
  ['href="/ride"', 'href="ride.html"'],
  ['href="/driver"', 'href="driver.html"'],
  ['href="/privacy"', 'href="privacy.html"'],
  ['href="/delete-account"', 'href="delete-account.html"'],
  ["location.href='/?pick=1'", "location.href='index.html?pick=1'"],
  ["go = '/driver'", "go = 'driver.html'"],
  ["go = '/ride'", "go = 'ride.html'"],
];

function build() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  let injected = 0;
  for (const page of PAGES) {
    const src = path.join(SRC, page.from);
    if (!fs.existsSync(src)) throw new Error('ماكو ملف: ' + page.from);
    let html = fs.readFileSync(src, 'utf8');

    // الجسر أول شي بالصفحة — قبل أي كود يستعمل fetch
    const anchor = '<meta charset="UTF-8">';
    if (!html.includes(anchor)) throw new Error('ما لگيت مكان الجسر بـ' + page.from);
    html = html.replace(anchor, anchor + '\n' + BRIDGE);
    injected++;

    for (const [a, b] of LINKS) html = html.split(a).join(b);

    // الأصول تنزل جنب الصفحة مو بجذر السيرفر
    for (const asset of ASSETS) html = html.split('"/' + asset + '"').join('"' + asset + '"');

    fs.writeFileSync(path.join(OUT, page.to), html, 'utf8');
    console.log('  ' + page.from.padEnd(22) + ' ← ' + page.to);
  }

  for (const asset of ASSETS) {
    const src = path.join(SRC, asset);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT, asset));
  }

  // تحقّق: ما يبقى أي رابط مطلق يدوّر على ملف مو موجود بالموبايل
  const leftovers = [];
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(OUT, page.to), 'utf8');
    const m = html.match(/(?:href|src)="\/[^"]*"/g);
    if (m) leftovers.push(page.to + ': ' + [...new Set(m)].join(', '));
  }

  console.log('\nالجسر انحقن بـ' + injected + ' صفحات');
  console.log('الأصول: ' + ASSETS.filter(a => fs.existsSync(path.join(OUT, a))).length + ' ملف');
  if (leftovers.length) {
    console.log('\n⚠️ روابط مطلقة باقية — راح تنكسر بالتطبيق:');
    leftovers.forEach(l => console.log('   ' + l));
    process.exitCode = 1;
  } else {
    console.log('✅ ماكو روابط مكسورة');
  }
}

build();

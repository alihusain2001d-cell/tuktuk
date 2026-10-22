/* ═══════════════════════════════════════════════════════════════
   إشعارات الآيفون (APNs)

   إشعارات المتصفح ما تشتغل جوّا تطبيق الآيفون — آبل تمنعها. فتطبيق
   الآيفون لازم يستلم إشعاراته من خدمة آبل نفسها، بنظام مختلف تماماً:
   اتصال HTTP/2، ورمز دخول موقّع بمفتاح خاص، ورمز جهاز لكل موبايل.

   مكتوب بلا مكتبات خارجية — Node عنده http2 وcrypto جاهزين، وما
   نريد نضيف حزمة ثالثة لشي بهاي البساطة.

   الإعدادات تجي من متغيرات السيرفر:
     APNS_KEY        محتوى ملف .p8 كامل
     APNS_KEY_ID     رمز المفتاح (بإسم الملف: AuthKey_XXXX.p8)
     APNS_TEAM_ID    رمز الفريق عند آبل
     APNS_BUNDLE_ID  اسم حزمة التطبيق
     APNS_SANDBOX    "true" للنسخ المبنية من Xcode. نسخ TestFlight
                     والمتجر تستعمل الخادم العادي — فاتركها فاضية.
   ═══════════════════════════════════════════════════════════════ */

const http2 = require('http2');
const crypto = require('crypto');

const KEY = (process.env.APNS_KEY || '').replace(/\\n/g, '\n').trim();
const KEY_ID = (process.env.APNS_KEY_ID || '').trim();
const TEAM_ID = (process.env.APNS_TEAM_ID || '').trim();
const BUNDLE_ID = (process.env.APNS_BUNDLE_ID || 'com.jayak.app').trim();
const HOST = String(process.env.APNS_SANDBOX || '').toLowerCase() === 'true'
  ? 'https://api.sandbox.push.apple.com'
  : 'https://api.push.apple.com';

const ENABLED = !!(KEY && KEY_ID && TEAM_ID);

/* رمز الدخول صالح ساعة عند آبل، وهي ترفض التجديد أكثر من مرة كل
   ٢٠ دقيقة. فنخزنه ونجدده كل نص ساعة — بالنص الآمن بين الحدين. */
let cachedToken = null;
let cachedAt = 0;
const TOKEN_TTL = 30 * 60 * 1000;

function authToken() {
  if (cachedToken && Date.now() - cachedAt < TOKEN_TTL) return cachedToken;

  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'ES256', kid: KEY_ID });
  const body = b64({ iss: TEAM_ID, iat: Math.floor(Date.now() / 1000) });

  // آبل تطلب التوقيع بصيغة r‖s المسطّحة، مو صيغة DER اللي يرجّعها
  // التوقيع الافتراضي — ومن غيرها ترفض الرمز بـ403 بلا توضيح
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), {
    key: KEY,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');

  cachedToken = `${head}.${body}.${sig}`;
  cachedAt = Date.now();
  return cachedToken;
}

/* اتصال واحد مفتوح لكل الإرسالات — فتح اتصال لكل إشعار يضيّع وقت
   بمصافحة TLS، وآبل نفسها توصي بإبقائه مفتوح. */
let session = null;
function getSession() {
  if (session && !session.closed && !session.destroyed) return session;
  session = http2.connect(HOST);
  session.on('error', () => { session = null; });
  session.on('close', () => { session = null; });
  session.setTimeout(5 * 60 * 1000, () => { try { session.close(); } catch (e) {} });
  return session;
}

/* يرسل إشعار لجهاز واحد.
   يرجّع { ok } أو { ok:false, gone } — و gone معناها الجهاز شال
   التطبيق أو الرمز بطل، فالمنادي يمسح الرمز من قاعدة البيانات. */
function sendToDevice(deviceToken, payload) {
  return new Promise((resolve) => {
    if (!ENABLED) return resolve({ ok: false, reason: 'مطفي' });
    if (!deviceToken) return resolve({ ok: false, reason: 'ماكو رمز جهاز' });

    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };

    const body = JSON.stringify({
      aps: {
        alert: { title: payload.title || 'جايك', body: payload.body || '' },
        sound: 'default',
        'interruption-level': 'time-sensitive',   // يوصل حتى بوضع التركيز
      },
      url: payload.url || '/',
    });

    let req;
    try {
      req = getSession().request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        'authorization': `bearer ${authToken()}`,
        'apns-topic': BUNDLE_ID,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
    } catch (e) {
      return finish({ ok: false, reason: e.message });
    }

    let status = 0, data = '';
    req.setTimeout(8000, () => { try { req.close(); } catch (e) {} finish({ ok: false, reason: 'تأخر' }); });
    req.on('response', (h) => { status = Number(h[':status']) || 0; });
    req.on('data', (c) => { data += c; });
    req.on('error', (e) => finish({ ok: false, reason: e.message }));
    req.on('end', () => {
      if (status === 200) return finish({ ok: true });
      let reason = data;
      try { reason = JSON.parse(data).reason || data; } catch (e) {}
      // 410 = الرمز بطل · BadDeviceToken = رمز غلط أو لبيئة ثانية
      const gone = status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered';
      finish({ ok: false, gone, status, reason });
    });

    req.end(body);
  });
}

module.exports = { sendToDevice, ENABLED, BUNDLE_ID, SANDBOX: HOST.includes('sandbox') };

// ============================================================
//  جايك - السيرفر (مع قاعدة بيانات دائمة)
//  Jayak Server - PostgreSQL persistence
// ============================================================

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '10mb' })); // حد أعلى للصور

// ============ إعدادات الأجرة ============
const FARE = {
  base: 1000,       // أجرة الأساس (دينار)
  perKm: 500,       // سعر الكيلومتر (دينار)
  minimum: 1500,    // أقل أجرة
};

// ============ مفتاح لوحة التحكم ============
const ADMIN_KEY = process.env.ADMIN_KEY || '1994';

// المسارات
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'home.html')));
app.get('/ride', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/driver', (req, res) => res.sendFile(path.join(__dirname, 'driver.html')));
app.use(express.static(path.join(__dirname)));

// ============================================================
//  الحالة اللحظية (بالذاكرة — طبيعي، هاي مؤقتة)
// ============================================================
const sockets = new Map();       // socketId -> ws
const onlineDrivers = new Map(); // driverId -> { socketId, lat, lng, name, phone, car }
const activeRides = new Map();   // rideId -> بيانات الرحلة النشطة

function uid() { return crypto.randomBytes(6).toString('hex'); }

function calcFare(km) {
  const raw = FARE.base + km * FARE.perKm;
  return Math.max(FARE.minimum, Math.round(raw / 250) * 250);
}

function broadcast(role, type, data) {
  for (const [, ws] of sockets) {
    if (ws.readyState === 1 && ws._role === role) {
      ws.send(JSON.stringify({ type, data }));
    }
  }
}

function sendTo(socketId, type, data) {
  const ws = sockets.get(socketId);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, data }));
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ============================================================
//  WebSocket
// ============================================================
wss.on('connection', (ws) => {
  const socketId = uid();
  ws._id = socketId;
  ws._role = null;
  sockets.set(socketId, ws);
  ws.send(JSON.stringify({ type: 'welcome', data: { socketId } }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, data } = msg;

    try {
      switch (type) {
        case 'driver:online': {
          // تأكد إنه مسموح له يشتغل (تجربة أو اشتراك)
          const access = await db.getDriverAccess(data.driverId);
          if (!access.allowed) {
            ws.send(JSON.stringify({ type: 'driver:blocked', data: access }));
            return;
          }
          ws._role = 'driver';
          ws._driverId = data.driverId;
          onlineDrivers.set(data.driverId, {
            socketId, lat: data.lat, lng: data.lng,
            name: data.name, phone: data.phone, car: data.car,
          });
          await db.updateDriverLocation(data.driverId, data.lat, data.lng);
          ws.send(JSON.stringify({ type: 'driver:confirmed', data: { online: true, access } }));
          break;
        }

        case 'driver:location': {
          const d = onlineDrivers.get(ws._driverId);
          if (d) { d.lat = data.lat; d.lng = data.lng; }
          for (const ride of activeRides.values()) {
            if (ride.driverId === ws._driverId && ['accepted','arriving'].includes(ride.status)) {
              sendTo(ride.customerSocketId, 'driver:moved', { lat: data.lat, lng: data.lng });
            }
          }
          break;
        }

        case 'driver:offline': {
          onlineDrivers.delete(ws._driverId);
          break;
        }

        case 'customer:hello': { ws._role = 'customer'; break; }
        default: break;
      }
    } catch (e) { console.error('خطأ بالرسالة:', e.message); }
  });

  ws.on('close', () => {
    if (ws._role === 'driver' && ws._driverId) onlineDrivers.delete(ws._driverId);
    sockets.delete(socketId);
  });
});

// ============================================================
//  تأكيد رقم الموبايل بكود (OTP)
// ============================================================
// الأكواد تنحفظ مؤقتاً بالذاكرة (تنتهي بعد ٥ دقايق)
const otpCodes = new Map(); // phone -> { code, expiresAt, attempts, lastSentAt }

const OTP_TTL = 5 * 60 * 1000;        // صلاحية الكود: ٥ دقايق
const OTP_RESEND_WAIT = 60 * 1000;    // ما يقدر يعيد الإرسال قبل دقيقة
const OTP_MAX_ATTEMPTS = 5;           // أقصى محاولات خاطئة

// وضع التطوير: الكود يرجع بالرد حتى تجرّب بدون خدمة SMS
const OTP_DEV_MODE = process.env.OTP_DEV_MODE !== 'false';

function genOTP() {
  return String(Math.floor(100000 + Math.random() * 900000)); // ٦ أرقام
}

// إرسال الكود — حالياً يطبعه بالسجل. لاحقاً نربطه بـ Firebase أو واتساب
async function sendOTP(phone, code) {
  console.log(`📱 كود التحقق لـ ${phone}: ${code}`);
  // TODO: اربط هنا Firebase Phone Auth أو GreenAPI واتساب
  return true;
}

function normalizePhone(p) {
  return String(p || '').replace(/\D/g, ''); // بس أرقام
}

// طلب كود
app.post('/api/otp/send', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (phone.length < 10) return res.status(400).json({ error: 'رقم غير صحيح' });

    const existing = otpCodes.get(phone);
    if (existing && Date.now() - existing.lastSentAt < OTP_RESEND_WAIT) {
      const wait = Math.ceil((OTP_RESEND_WAIT - (Date.now() - existing.lastSentAt)) / 1000);
      return res.status(429).json({ error: `انتظر ${wait} ثانية قبل إعادة الإرسال`, waitSec: wait });
    }

    const code = genOTP();
    otpCodes.set(phone, { code, expiresAt: Date.now() + OTP_TTL, attempts: 0, lastSentAt: Date.now() });
    await sendOTP(phone, code);

    res.json({ ok: true, sent: true, ...(OTP_DEV_MODE ? { devCode: code } : {}) });
  } catch (e) {
    console.error('خطأ بإرسال الكود:', e.message);
    res.status(500).json({ error: 'ما كدرنا نرسل الكود' });
  }
});

// تأكيد الكود
app.post('/api/otp/verify', (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const code = String(req.body.code || '').trim();
    const rec = otpCodes.get(phone);

    if (!rec) return res.status(400).json({ error: 'اطلب كود جديد أول' });
    if (Date.now() > rec.expiresAt) {
      otpCodes.delete(phone);
      return res.status(400).json({ error: 'الكود انتهت صلاحيته، اطلب واحد جديد' });
    }
    if (rec.attempts >= OTP_MAX_ATTEMPTS) {
      otpCodes.delete(phone);
      return res.status(429).json({ error: 'محاولات كثيرة، اطلب كود جديد' });
    }
    if (rec.code !== code) {
      rec.attempts++;
      return res.status(400).json({ error: 'الكود غلط', attemptsLeft: OTP_MAX_ATTEMPTS - rec.attempts });
    }

    otpCodes.delete(phone);
    // توكن بسيط يثبت إنه الرقم متأكد (صالح ١٠ دقايق)
    const token = crypto.createHmac('sha256', ADMIN_KEY)
      .update(`${phone}:${Math.floor(Date.now() / (10*60*1000))}`).digest('hex').slice(0, 32);
    res.json({ ok: true, verified: true, token });
  } catch (e) {
    res.status(500).json({ error: 'خطأ' });
  }
});

// تنظيف الأكواد المنتهية كل ١٠ دقايق
setInterval(() => {
  const now = Date.now();
  for (const [phone, rec] of otpCodes) if (now > rec.expiresAt) otpCodes.delete(phone);
}, 10 * 60 * 1000);

// ============================================================
//  API — السائق
// ============================================================

// تسجيل السائق (مع الصور)
app.post('/api/driver/register', async (req, res) => {
  try {
    const { driverId, name, phone, car, photoCar, photoIdFront, photoIdBack, lat, lng } = req.body;
    if (!driverId || !name || !phone) return res.status(400).json({ error: 'الاسم والرقم مطلوبين' });

    const d = await db.upsertDriver({
      id: driverId, name, phone, car,
      photo_car: photoCar || null,
      photo_id_front: photoIdFront || null,
      photo_id_back: photoIdBack || null,
      last_lat: lat || null, last_lng: lng || null,
    });
    const access = await db.getDriverAccess(driverId);
    res.json({ ok: true, driver: { id: d.id, name: d.name, status: d.status }, access });
  } catch (e) {
    console.error('خطأ بالتسجيل:', e.message);
    res.status(500).json({ error: 'صار خطأ بالتسجيل' });
  }
});

// حالة وصول السائق (تجربة/اشتراك/محظور)
app.get('/api/driver/:id/access', async (req, res) => {
  try {
    const access = await db.getDriverAccess(req.params.id);
    res.json(access);
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

// كشف حساب السائق
app.get('/api/driver/:id/earnings', async (req, res) => {
  try {
    res.json(await db.getDriverEarnings(req.params.id));
  } catch (e) {
    console.error('خطأ بكشف الحساب:', e.message);
    res.status(500).json({ error: 'خطأ' });
  }
});

// ============================================================
//  API — الحجز
// ============================================================
app.post('/api/book', async (req, res) => {
  try {
    const { name, phone, pickup, destination, socketId, orderType, store, itemDesc } = req.body;
    if (!pickup || !pickup.lat) return res.status(400).json({ error: 'نقطة الانطلاق مطلوبة' });

    const type = orderType === 'delivery' ? 'delivery' : 'ride';
    const rideId = uid();
    let estKm = 0, estFare = 0;
    if (destination && destination.lat) {
      estKm = haversine(pickup.lat, pickup.lng, destination.lat, destination.lng);
      estFare = calcFare(estKm);
    }

    const ride = {
      id: rideId, type,
      customer: { name: name || 'زبون', phone: phone || '' },
      pickup: { lat: pickup.lat, lng: pickup.lng, label: pickup.label || '' },
      destination: destination && destination.lat
        ? { lat: destination.lat, lng: destination.lng, label: destination.label || '' } : null,
      store: type === 'delivery' && store ? { label: store.label || '', lat: store.lat, lng: store.lng } : null,
      itemDesc: type === 'delivery' ? (itemDesc || '') : '',
      estKm, estFare, status: 'searching', driverId: null,
      customerSocketId: socketId, createdAt: Date.now(),
    };

    // احفظ بالقاعدة + بالذاكرة (للتتبع اللحظي)
    await db.createRide(ride);
    if (phone) await db.upsertCustomer(phone, name || 'زبون');
    activeRides.set(rideId, ride);

    broadcast('driver', 'ride:new', {
      rideId, type: ride.type, pickup: ride.pickup, destination: ride.destination,
      store: ride.store, itemDesc: ride.itemDesc,
      estKm: Math.round(estKm*10)/10, estFare, customer: { name: ride.customer.name },
    });

    res.json({ rideId, driversNotified: onlineDrivers.size, estKm: Math.round(estKm*10)/10, estFare });
  } catch (e) {
    console.error('خطأ بالحجز:', e.message);
    res.status(500).json({ error: 'صار خطأ بالحجز' });
  }
});

app.post('/api/accept', async (req, res) => {
  try {
    const { rideId, driverId } = req.body;
    const ride = activeRides.get(rideId);
    if (!ride) return res.status(404).json({ error: 'الرحلة غير موجودة' });
    if (ride.status !== 'searching') return res.status(409).json({ error: 'الرحلة انحجزت', taken: true });

    // تأكد من صلاحية السائق
    const access = await db.getDriverAccess(driverId);
    if (!access.allowed) return res.status(403).json({ error: 'اشتراكك منتهي', blocked: true, access });

    const driver = onlineDrivers.get(driverId);
    if (!driver) return res.status(404).json({ error: 'السواق غير متصل' });

    ride.status = 'accepted';
    ride.driverId = driverId;
    await db.updateRideStatus(rideId, 'accepted', driverId);

    const dist = haversine(driver.lat, driver.lng, ride.pickup.lat, ride.pickup.lng);
    const etaMin = Math.max(1, Math.round((dist / 25) * 60));

    sendTo(ride.customerSocketId, 'ride:accepted', {
      driver: { name: driver.name, phone: driver.phone, car: driver.car, lat: driver.lat, lng: driver.lng },
      etaMin,
    });
    broadcast('driver', 'ride:taken', { rideId });

    res.json({
      ok: true, type: ride.type, pickup: ride.pickup, destination: ride.destination,
      store: ride.store, itemDesc: ride.itemDesc, customer: ride.customer,
      estKm: ride.estKm, estFare: ride.estFare, etaMin,
    });
  } catch (e) {
    console.error('خطأ بالقبول:', e.message);
    res.status(500).json({ error: 'خطأ' });
  }
});

app.post('/api/arrived', async (req, res) => {
  try {
    const ride = activeRides.get(req.body.rideId);
    if (!ride) return res.status(404).json({ error: 'غير موجودة' });
    ride.status = 'arrived';
    await db.updateRideStatus(ride.id, 'arrived');
    sendTo(ride.customerSocketId, 'ride:arrived', {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/complete', async (req, res) => {
  try {
    const ride = activeRides.get(req.body.rideId);
    if (!ride) return res.status(404).json({ error: 'غير موجودة' });
    ride.status = 'done';
    await db.updateRideStatus(ride.id, 'done');
    sendTo(ride.customerSocketId, 'ride:done', { fare: ride.estFare });
    activeRides.delete(ride.id);
    res.json({ ok: true, fare: ride.estFare });
  } catch (e) {
    console.error('خطأ بالإنهاء:', e.message);
    res.status(500).json({ error: 'خطأ' });
  }
});

app.post('/api/cancel', async (req, res) => {
  try {
    const ride = activeRides.get(req.body.rideId);
    if (!ride) return res.status(404).json({ error: 'غير موجودة' });
    ride.status = 'cancelled';
    await db.updateRideStatus(ride.id, 'cancelled');
    if (ride.driverId) {
      const d = onlineDrivers.get(ride.driverId);
      if (d) sendTo(d.socketId, 'ride:cancelled', { rideId: ride.id });
    }
    broadcast('driver', 'ride:taken', { rideId: ride.id });
    activeRides.delete(ride.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

// ============================================================
//  API — لوحة التحكم (تحتاج مفتاح)
// ============================================================
function checkAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'غير مصرح' });
  next();
}

app.get('/api/admin/drivers', checkAdmin, async (req, res) => {
  try {
    const drivers = await db.getAllDrivers();
    const withAccess = await Promise.all(drivers.map(async d => ({
      ...d,
      online: onlineDrivers.has(d.id),
      access: await db.getDriverAccess(d.id),
    })));
    res.json(withAccess);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/driver/:id/subscribe', checkAdmin, async (req, res) => {
  try {
    const days = parseInt(req.body.days, 10);
    if (!days || days < 1) return res.status(400).json({ error: 'عدد أيام غير صحيح' });
    const d = await db.setDriverSubscription(req.params.id, days);
    res.json({ ok: true, driver: d });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/driver/:id/status', checkAdmin, async (req, res) => {
  try {
    const d = await db.setDriverStatus(req.params.id, req.body.status);
    res.json({ ok: true, driver: d });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/rides', checkAdmin, async (req, res) => {
  try { res.json(await db.getAllRides(100)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/customers', checkAdmin, async (req, res) => {
  try { res.json(await db.getAllCustomers()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/stats', checkAdmin, async (req, res) => {
  try {
    const s = await db.getStats();
    res.json({ ...s, driversOnline: onlineDrivers.size, activeRides: activeRides.size });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
app.get('/api/stats', async (req, res) => {
  try {
    const s = await db.getStats();
    res.json({ driversOnline: onlineDrivers.size, activeRides: activeRides.size, ...s });
  } catch (e) { res.json({ driversOnline: onlineDrivers.size, activeRides: activeRides.size }); }
});

app.get('/api/ride/:id', (req, res) => {
  const ride = activeRides.get(req.params.id);
  if (!ride) return res.status(404).json({ error: 'غير موجودة' });
  res.json(ride);
});

// ============================================================
const PORT = process.env.PORT || 3000;

(async () => {
  await db.init();
  server.listen(PORT, () => {
    console.log(`🛺 جايك يشتغل على المنفذ ${PORT}`);
    console.log(db.HAS_DB ? '   التخزين: PostgreSQL (دائم)' : '   التخزين: الذاكرة (مؤقت)');
  });
})();

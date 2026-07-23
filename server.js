// ============================================================
//  جايك - السيرفر (مع قاعدة بيانات دائمة)
//  Jayak Server - PostgreSQL persistence
// ============================================================

require('dotenv').config();

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

// ============ مفتاح لوحة التحكم ============
const ADMIN_KEY = process.env.ADMIN_KEY || '1994';

// المسارات
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'home.html')));
app.get('/ride', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/driver', (req, res) => res.sendFile(path.join(__dirname, 'driver.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.use(express.static(path.join(__dirname)));

// ============================================================
//  الحالة اللحظية (بالذاكرة — طبيعي، هاي مؤقتة)
// ============================================================
const sockets = new Map();       // socketId -> ws
const onlineDrivers = new Map(); // driverId -> { socketId, lat, lng, name, phone, car }
const activeRides = new Map();   // rideId -> بيانات الرحلة النشطة

function uid() { return crypto.randomBytes(6).toString('hex'); }

async function calcFare(km) {
  const s = await db.getFareSettings();
  if (s.mode === 'fixed') return s.fixed_price;
  return Math.max(s.minimum, Math.round((s.base + km * s.per_km) / 250) * 250);
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

// هل الرقم مسجّل من قبل؟ (قبل إرسال الكود)
app.post('/api/driver/check-phone', async (req, res) => {
  try {
    const d = await db.getDriverByPhone(req.body.phone);
    res.json({ exists: !!d, name: d ? d.name : null });
  } catch (e) {
    console.error('خطأ بفحص الرقم:', e.message);
    res.status(500).json({ error: 'خطأ' });
  }
});

// تسجيل الدخول برقم + كود (الكود يتأكد بنقطة /api/otp/verify أول)
app.post('/api/driver/login', async (req, res) => {
  try {
    const { phone, code } = req.body;
    const clean = normalizePhone(phone);

    // تأكد من الكود
    const rec = otpCodes.get(clean);
    if (!rec) return res.status(400).json({ error: 'اطلب كود جديد أول' });
    if (Date.now() > rec.expiresAt) { otpCodes.delete(clean); return res.status(400).json({ error: 'الكود انتهت صلاحيته' }); }
    if (rec.attempts >= OTP_MAX_ATTEMPTS) { otpCodes.delete(clean); return res.status(429).json({ error: 'محاولات كثيرة، اطلب كود جديد' }); }
    if (rec.code !== String(code || '').trim()) {
      rec.attempts++;
      return res.status(400).json({ error: 'الكود غلط', attemptsLeft: OTP_MAX_ATTEMPTS - rec.attempts });
    }
    otpCodes.delete(clean);

    // دوّر على السائق
    const d = await db.getDriverByPhone(clean);
    if (!d) return res.status(404).json({ error: 'ماكو حساب بهذا الرقم', notFound: true });

    const access = await db.getDriverAccess(d.id);
    res.json({
      ok: true,
      driver: { id: d.id, name: d.name, phone: d.phone, car: d.car },
      access,
    });
  } catch (e) {
    console.error('خطأ بتسجيل الدخول:', e.message);
    res.status(500).json({ error: 'صار خطأ بتسجيل الدخول' });
  }
});

// تسجيل السائق (مع الصور)
app.post('/api/driver/register', async (req, res) => {
  try {
    const { driverId, name, phone, car, photoSelf, photoCar, photoIdFront, photoIdBack, lat, lng } = req.body;
    if (!driverId || !name || !phone) return res.status(400).json({ error: 'الاسم والرقم مطلوبين' });

    // امنع تسجيل رقم موجود بحساب ثاني
    const existing = await db.getDriverByPhone(phone);
    if (existing && existing.id !== driverId) {
      return res.status(409).json({
        error: 'هذا الرقم مسجّل من قبل. سجّل دخول بدل ما تسوي حساب جديد.',
        alreadyExists: true,
      });
    }

    const d = await db.upsertDriver({
      id: driverId, name, phone, car,
      photo_self: photoSelf || null,
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
//  API — الزبون (تسجيل ودخول)
// ============================================================

// هل الرقم مسجّل من قبل؟
app.post('/api/customer/check-phone', async (req, res) => {
  try {
    const c = await db.getCustomerByPhone(req.body.phone);
    res.json({ exists: !!c, name: c ? c.name : null });
  } catch (e) {
    console.error('خطأ بفحص رقم الزبون:', e.message);
    res.status(500).json({ error: 'خطأ' });
  }
});

// حساب جديد (بعد تأكيد الكود)
app.post('/api/customer/register', async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'الاسم والرقم مطلوبين' });

    // امنع التسجيل برقم موجود
    const existing = await db.getCustomerByPhone(phone);
    if (existing) {
      return res.status(409).json({
        error: 'هذا الرقم مسجّل من قبل. سجّل دخول بدل ما تسوي حساب جديد.',
        alreadyExists: true,
      });
    }

    const c = await db.upsertCustomer(phone, name);
    res.json({ ok: true, customer: { id: c.id, name: c.name, phone: c.phone, photo: c.photo } });
  } catch (e) {
    console.error('خطأ بتسجيل الزبون:', e.message);
    res.status(500).json({ error: 'صار خطأ بالتسجيل' });
  }
});

// تسجيل دخول برقم + كود
app.post('/api/customer/login', async (req, res) => {
  try {
    const { phone, code } = req.body;
    const clean = normalizePhone(phone);

    // تأكد من الكود
    const rec = otpCodes.get(clean);
    if (!rec) return res.status(400).json({ error: 'اطلب كود جديد أول' });
    if (Date.now() > rec.expiresAt) { otpCodes.delete(clean); return res.status(400).json({ error: 'الكود انتهت صلاحيته' }); }
    if (rec.attempts >= OTP_MAX_ATTEMPTS) { otpCodes.delete(clean); return res.status(429).json({ error: 'محاولات كثيرة، اطلب كود جديد' }); }
    if (rec.code !== String(code || '').trim()) {
      rec.attempts++;
      return res.status(400).json({ error: 'الكود غلط', attemptsLeft: OTP_MAX_ATTEMPTS - rec.attempts });
    }
    otpCodes.delete(clean);

    const c = await db.getCustomerByPhone(clean);
    if (!c) return res.status(404).json({ error: 'ماكو حساب بهذا الرقم', notFound: true });

    const trips = await db.getCustomerTripCount(clean);
    res.json({ ok: true, customer: { id: c.id, name: c.name, phone: c.phone, photo: c.photo }, trips });
  } catch (e) {
    console.error('خطأ بدخول الزبون:', e.message);
    res.status(500).json({ error: 'صار خطأ بتسجيل الدخول' });
  }
});

// سجل رحلات الزبون المنجزة
app.get('/api/customer/:phone/trips', async (req, res) => {
  try {
    const trips = await db.getCustomerTrips(req.params.phone);
    res.json({ trips });
  } catch (e) {
    console.error('خطأ بجلب رحلات الزبون:', e.message);
    res.status(500).json({ error: 'خطأ' });
  }
});

// تحديث اسم/صورة الزبون
app.post('/api/customer/:phone/profile', async (req, res) => {
  try {
    const { name, photo } = req.body;
    const c = await db.updateCustomerProfile(req.params.phone, { name, photo });
    if (!c) return res.status(404).json({ error: 'ماكو حساب بهذا الرقم' });
    res.json({ ok: true, customer: { id: c.id, name: c.name, phone: c.phone, photo: c.photo } });
  } catch (e) {
    console.error('خطأ بتحديث الحساب:', e.message);
    res.status(500).json({ error: 'خطأ' });
  }
});

// تغيير رقم الزبون (بعد تحقق OTP على الرقم الجديد بواسطة /api/otp/send و /api/otp/verify)
app.post('/api/customer/:phone/change-phone', async (req, res) => {
  try {
    const newPhone = normalizePhone(req.body.newPhone);
    if (newPhone.length < 10) return res.status(400).json({ error: 'رقم غير صحيح' });
    const existing = await db.getCustomerByPhone(newPhone);
    if (existing) return res.status(409).json({ error: 'هذا الرقم مستخدم من حساب ثاني' });
    const c = await db.changeCustomerPhone(req.params.phone, newPhone);
    if (!c) return res.status(404).json({ error: 'ماكو حساب بهذا الرقم' });
    res.json({ ok: true, customer: { id: c.id, name: c.name, phone: c.phone } });
  } catch (e) {
    console.error('خطأ بتغيير الرقم:', e.message);
    res.status(500).json({ error: 'خطأ' });
  }
});

// مكافآت الزبون (المتاحة الحين + رحلاته المتبقية للمكافأة الجاية)
app.get('/api/customer/:phone/rewards', async (req, res) => {
  try {
    const [pending, settings, tripCount] = await Promise.all([
      db.getPendingReward(req.params.phone),
      db.getRewardSettings(),
      db.getCustomerTripCount(req.params.phone),
    ]);
    res.json({
      enabled: settings.enabled,
      pending: settings.enabled && pending ? { type: pending.reward_type, value: pending.reward_value } : null,
      tripsDone: tripCount,
      tripsThreshold: settings.trips_threshold,
    });
  } catch (e) {
    console.error('خطأ بجلب مكافآت الزبون:', e.message);
    res.status(500).json({ error: 'خطأ' });
  }
});

// المواقع المفضلة للزبون
app.get('/api/customer/:phone/places', async (req, res) => {
  try {
    res.json({ places: await db.getSavedPlaces(req.params.phone) });
  } catch (e) {
    console.error('خطأ بجلب المواقع:', e.message);
    res.status(500).json({ error: 'خطأ' });
  }
});

app.post('/api/customer/:phone/places', async (req, res) => {
  try {
    const { name, lat, lng, address } = req.body;
    if (!name || lat == null || lng == null) return res.status(400).json({ error: 'بيانات ناقصة' });
    const place = await db.addSavedPlace(req.params.phone, name, lat, lng, address);
    res.json({ ok: true, place });
  } catch (e) {
    console.error('خطأ بحفظ الموقع:', e.message);
    res.status(500).json({ error: 'خطأ' });
  }
});

app.delete('/api/customer/:phone/places/:id', async (req, res) => {
  try {
    await db.deleteSavedPlace(req.params.id, req.params.phone);
    res.json({ ok: true });
  } catch (e) {
    console.error('خطأ بحذف الموقع:', e.message);
    res.status(500).json({ error: 'خطأ' });
  }
});

// ============================================================
//  API — الحجز
// ============================================================
app.post('/api/book', async (req, res) => {
  try {
    const { name, phone, pickup, destination, socketId, orderType, store, storeName, itemDesc } = req.body;
    if (!pickup || !pickup.lat) return res.status(400).json({ error: 'موقعك مطلوب' });

    const type = orderType === 'delivery' ? 'delivery' : 'ride';
    const rideId = uid();
    let estKm = 0, estFare = 0;
    // الرحلة العادية: أجرة تلقائية بالمسافة
    // التوصيل: ماكو سعر — السائق يعرض والزبون يوافق
    if (type === 'ride' && destination && destination.lat) {
      estKm = haversine(pickup.lat, pickup.lng, destination.lat, destination.lng);
      estFare = await calcFare(estKm);
    }

    // لو الزبون عنده مكافأة متاحة، تنطبق تلقائياً على الرحلة العادية (مو التوصيل، السعر فيه ما يتحدد إلا بعد عرض السائق)
    let customerPaid = estFare, reward = null;
    if (type === 'ride' && phone) {
      const rewardSettings = await db.getRewardSettings();
      if (rewardSettings.enabled) reward = await db.getPendingReward(phone);
      if (reward) {
        if (reward.reward_type === 'free_ride') customerPaid = 0;
        else if (reward.reward_type === 'percent') customerPaid = Math.max(0, Math.round(estFare * (1 - reward.reward_value / 100)));
        else if (reward.reward_type === 'amount') customerPaid = Math.max(0, estFare - reward.reward_value);
      }
    }

    const ride = {
      id: rideId, type,
      customer: { name: name || 'زبون', phone: phone || '' },
      pickup: { lat: pickup.lat, lng: pickup.lng, label: pickup.label || '' },
      destination: destination && destination.lat
        ? { lat: destination.lat, lng: destination.lng, label: destination.label || '' } : null,
      store: type === 'delivery' && store && store.lat ? { label: store.label || '', lat: store.lat, lng: store.lng } : null,
      storeName: type === 'delivery' ? (storeName || '') : '',
      itemDesc: type === 'delivery' ? (itemDesc || '') : '',
      estKm, estFare, customerPaid, rewardId: reward ? reward.id : null,
      status: 'searching', driverId: null,
      customerSocketId: socketId, createdAt: Date.now(),
    };

    // احفظ بالقاعدة + بالذاكرة (للتتبع اللحظي)
    await db.createRide(ride);
    if (phone) await db.upsertCustomer(phone, name || 'زبون');
    if (reward) await db.reserveRewardForRide(reward.id, rideId);
    activeRides.set(rideId, ride);

    broadcast('driver', 'ride:new', {
      rideId, type: ride.type, pickup: ride.pickup, destination: ride.destination,
      store: ride.store, storeName: ride.storeName, itemDesc: ride.itemDesc,
      estKm: Math.round(estKm*10)/10, estFare, customer: { name: ride.customer.name },
      rewardApplied: !!reward,
    });

    res.json({
      rideId, driversNotified: onlineDrivers.size, estKm: Math.round(estKm*10)/10, estFare,
      customerPaid, reward: reward ? { type: reward.reward_type, value: reward.reward_value } : null,
    });
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

    const access = await db.getDriverAccess(driverId);
    if (!access.allowed) return res.status(403).json({ error: 'اشتراكك منتهي', blocked: true, access });

    const driver = onlineDrivers.get(driverId);
    if (!driver) return res.status(404).json({ error: 'السائق غير متصل' });

    ride.status = 'accepted';
    ride.driverId = driverId;
    await db.updateRideStatus(rideId, 'accepted', driverId);

    const dist = haversine(driver.lat, driver.lng, ride.pickup.lat, ride.pickup.lng);
    const etaMin = Math.max(1, Math.round((dist / 25) * 60));

    // جيب صورة السائق الشخصية حتى الزبون يتعرف عليه
    const dRec = await db.getDriver(driverId);

    sendTo(ride.customerSocketId, 'ride:accepted', {
      driver: {
        name: driver.name, phone: driver.phone, car: driver.car,
        lat: driver.lat, lng: driver.lng,
        photo: dRec ? dRec.photo_self : null,
      },
      etaMin,
    });
    broadcast('driver', 'ride:taken', { rideId });

    res.json({
      ok: true, type: ride.type, pickup: ride.pickup, destination: ride.destination,
      store: ride.store, storeName: ride.storeName, itemDesc: ride.itemDesc, customer: ride.customer,
      estKm: ride.estKm, estFare: ride.estFare, etaMin,
    });
  } catch (e) {
    console.error('خطأ بالقبول:', e.message);
    res.status(500).json({ error: 'خطأ' });
  }
});

// ============================================================
//  عروض السعر (لطلبات التوصيل)
// ============================================================

// السائق يقدّم عرض سعر
app.post('/api/offer', async (req, res) => {
  try {
    const { rideId, driverId, price, note } = req.body;
    const ride = activeRides.get(rideId);
    if (!ride) return res.status(404).json({ error: 'الطلب غير موجود' });
    if (ride.type !== 'delivery') return res.status(400).json({ error: 'العروض بس لطلبات التوصيل' });
    if (ride.status !== 'searching') return res.status(409).json({ error: 'الطلب مأخوذ من سائق ثاني', taken: true });

    const p = parseInt(price, 10);
    if (!p || p < 250) return res.status(400).json({ error: 'اكتب سعر صحيح' });

    const access = await db.getDriverAccess(driverId);
    if (!access.allowed) return res.status(403).json({ error: 'اشتراكك منتهي', blocked: true, access });

    const driver = onlineDrivers.get(driverId);
    if (!driver) return res.status(404).json({ error: 'مو متصل' });

    // اقفل الطلب مؤقتاً على هذا السائق لحد ما الزبون يرد
    ride.status = 'offered';
    ride.driverId = driverId;
    ride.offerPrice = p;
    ride.offerNote = note || '';
    await db.setRideOffer(rideId, driverId, p, note);

    const dRec = await db.getDriver(driverId);
    const dist = haversine(driver.lat, driver.lng, ride.pickup.lat, ride.pickup.lng);
    const etaMin = Math.max(1, Math.round((dist / 25) * 60));

    // ابعث العرض للزبون
    sendTo(ride.customerSocketId, 'offer:new', {
      rideId,
      price: p,
      note: note || '',
      etaMin,
      driver: {
        name: driver.name, phone: driver.phone, car: driver.car,
        photo: dRec ? dRec.photo_self : null,
      },
    });

    // بلّغ باقي السواقين إنه الطلب مأخوذ مؤقتاً
    broadcast('driver', 'ride:taken', { rideId });

    res.json({ ok: true, waiting: true });
  } catch (e) {
    console.error('خطأ بالعرض:', e.message);
    res.status(500).json({ error: 'خطأ' });
  }
});

// الزبون يوافق على العرض
app.post('/api/offer/accept', async (req, res) => {
  try {
    const { rideId } = req.body;
    const ride = activeRides.get(rideId);
    if (!ride) return res.status(404).json({ error: 'الطلب غير موجود' });
    if (ride.status !== 'offered') return res.status(409).json({ error: 'ماكو عرض معلّق' });

    ride.status = 'accepted';
    ride.estFare = ride.offerPrice;
    await db.acceptRideOffer(rideId);

    const driver = onlineDrivers.get(ride.driverId);
    if (driver) {
      sendTo(driver.socketId, 'offer:accepted', {
        rideId,
        price: ride.offerPrice,
        customer: ride.customer,
        pickup: ride.pickup,
        storeName: ride.storeName,
        itemDesc: ride.itemDesc,
      });
    }
    res.json({ ok: true, fare: ride.offerPrice });
  } catch (e) {
    console.error('خطأ بقبول العرض:', e.message);
    res.status(500).json({ error: 'خطأ' });
  }
});

// الزبون يرفض العرض — الطلب يرجع للسواقين
app.post('/api/offer/reject', async (req, res) => {
  try {
    const { rideId } = req.body;
    const ride = activeRides.get(rideId);
    if (!ride) return res.status(404).json({ error: 'الطلب غير موجود' });

    const rejectedDriver = ride.driverId;
    ride.status = 'searching';
    ride.driverId = null;
    ride.offerPrice = null;
    ride.offerNote = '';
    await db.clearRideOffer(rideId);

    // بلّغ السائق إنه العرض انرفض
    if (rejectedDriver) {
      const d = onlineDrivers.get(rejectedDriver);
      if (d) sendTo(d.socketId, 'offer:rejected', { rideId });
    }

    // ارجع الطلب لكل السواقين من جديد
    broadcast('driver', 'ride:new', {
      rideId, type: ride.type, pickup: ride.pickup, destination: ride.destination,
      store: ride.store, storeName: ride.storeName, itemDesc: ride.itemDesc,
      estKm: 0, estFare: 0, customer: { name: ride.customer.name },
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('خطأ برفض العرض:', e.message);
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

    // لو الرحلة استخدمت مكافأة، سجّل المبلغ المستحق للسائق (الفرق بين الأجرة الحقيقية واللي دفعه الزبون)
    if (ride.rewardId) {
      const payout = (ride.estFare || 0) - (ride.customerPaid != null ? ride.customerPaid : ride.estFare);
      await db.markRewardUsedByRide(ride.id, ride.driverId, Math.max(0, payout));
    }
    // تحقق إذا الزبون وصل الحين لعدد الرحلات المطلوب لمكافأة جديدة
    if (ride.customer?.phone) await db.maybeGrantAutoReward(ride.customer.phone);

    sendTo(ride.customerSocketId, 'ride:done', { fare: ride.customerPaid != null ? ride.customerPaid : ride.estFare });
    activeRides.delete(ride.id);
    res.json({ ok: true, fare: ride.customerPaid != null ? ride.customerPaid : ride.estFare });
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
    await db.cancelRideWithReason(ride.id, (req.body.reason || '').trim());
    if (ride.rewardId) await db.releaseRewardByRide(ride.id);
    if (ride.driverId) {
      const d = onlineDrivers.get(ride.driverId);
      if (d) sendTo(d.socketId, 'ride:cancelled', { rideId: ride.id });
    }
    broadcast('driver', 'ride:taken', { rideId: ride.id });
    activeRides.delete(ride.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

// إعدادات الأجرة (عامة — يحتاجها تطبيق الزبون لعرض تقدير السعر قبل الحجز)
app.get('/api/fare-settings', async (req, res) => {
  try { res.json(await db.getFareSettings()); }
  catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

// روابط التواصل (عامة — يحتاجها تطبيق الزبون لعرض أزرار الدعم)
app.get('/api/contact-settings', async (req, res) => {
  try { res.json(await db.getContactSettings()); }
  catch (e) { res.status(500).json({ error: 'خطأ' }); }
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
      paidTotal: await db.getDriverPaidTotal(d.id),
      rating: await db.getDriverRatingSummary(d.id),
    })));
    res.json(withAccess);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/driver/:id/subscribe', checkAdmin, async (req, res) => {
  try {
    const days = parseInt(req.body.days, 10);
    const amount = parseInt(req.body.amount, 10) || 0;
    const note = req.body.note || '';
    if (!days || days < 1) return res.status(400).json({ error: 'عدد أيام غير صحيح' });
    if (amount < 0) return res.status(400).json({ error: 'المبلغ غير صحيح' });
    const d = await db.setDriverSubscription(req.params.id, days, amount, note);
    res.json({ ok: true, driver: d, amount });
  } catch (e) {
    console.error('خطأ بالتفعيل:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// سجل الاشتراكات المدفوعة + ربح المالك
app.get('/api/admin/subscriptions', checkAdmin, async (req, res) => {
  try {
    const [revenue, list] = await Promise.all([
      db.getSubscriptionRevenue(),
      db.getSubscriptions(100),
    ]);
    res.json({ revenue, list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/driver/:id/status', checkAdmin, async (req, res) => {
  try {
    const d = await db.setDriverStatus(req.params.id, req.body.status);
    res.json({ ok: true, driver: d });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// إيقاف اشتراك السائق فوراً
app.post('/api/admin/driver/:id/revoke', checkAdmin, async (req, res) => {
  try {
    const d = await db.revokeDriverSubscription(req.params.id);
    // لو متصل، اقطعه فوراً
    const online = onlineDrivers.get(req.params.id);
    if (online) {
      sendTo(online.socketId, 'driver:blocked', { reason: 'expired', allowed: false });
      onlineDrivers.delete(req.params.id);
    }
    res.json({ ok: true, driver: d });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// حذف سائق
app.delete('/api/admin/driver/:id', checkAdmin, async (req, res) => {
  try {
    const online = onlineDrivers.get(req.params.id);
    if (online) {
      sendTo(online.socketId, 'driver:blocked', { reason: 'deleted', allowed: false });
      onlineDrivers.delete(req.params.id);
    }
    await db.deleteDriver(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// السواق المتصلين لحظياً (للخريطة بلوحة التحكم)
app.get('/api/admin/live', checkAdmin, async (req, res) => {
  try {
    const list = [];
    for (const [id, d] of onlineDrivers) {
      const rec = await db.getDriver(id);
      const access = await db.getDriverAccess(id);
      // هل عنده رحلة نشطة؟
      let busy = null;
      for (const ride of activeRides.values()) {
        if (ride.driverId === id && ['accepted','arriving','arrived','offered'].includes(ride.status)) {
          busy = { rideId: ride.id, type: ride.type, status: ride.status, customer: ride.customer.name };
          break;
        }
      }
      list.push({
        id, name: d.name, phone: d.phone, car: d.car,
        lat: d.lat, lng: d.lng,
        photo: rec ? rec.photo_self : null,
        access, busy,
      });
    }
    res.json({ drivers: list, activeRides: activeRides.size });
  } catch (e) {
    console.error('خطأ بالخريطة اللحظية:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// تحديث إعدادات الأجرة
app.post('/api/admin/fare-settings', checkAdmin, async (req, res) => {
  try {
    const mode = req.body.mode;
    if (!['per_km', 'fixed'].includes(mode)) return res.status(400).json({ error: 'طريقة حساب غير معروفة' });
    const base = parseInt(req.body.base, 10) || 0;
    const perKm = parseInt(req.body.per_km, 10) || 0;
    const minimum = parseInt(req.body.minimum, 10) || 0;
    const fixedPrice = parseInt(req.body.fixed_price, 10) || 0;
    if (mode === 'per_km' && !perKm) return res.status(400).json({ error: 'اكتب سعر الكيلومتر' });
    if (mode === 'fixed' && !fixedPrice) return res.status(400).json({ error: 'اكتب السعر الثابت' });
    res.json(await db.setFareSettings({ mode, base, per_km: perKm, minimum, fixed_price: fixedPrice }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// تحديث روابط التواصل (واتساب/فيسبوك/انستا/تلكرام)
app.post('/api/admin/contact-settings', checkAdmin, async (req, res) => {
  try { res.json(await db.setContactSettings(req.body)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ملاحظات وشكاوى الزبائن على السواق
app.get('/api/admin/complaints', checkAdmin, async (req, res) => {
  try { res.json(await db.getComplaints(100)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/rides', checkAdmin, async (req, res) => {
  try { res.json(await db.getAllRides(100)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/customers', checkAdmin, async (req, res) => {
  try {
    const customers = await db.getAllCustomers();
    const withRewards = await Promise.all(customers.map(async c => ({
      ...c,
      tripsDone: await db.getCustomerTripCount(c.phone),
      pendingReward: await db.getPendingReward(c.phone),
    })));
    res.json(withRewards);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ إعدادات مكافأة الولاء ============
app.get('/api/admin/reward-settings', checkAdmin, async (req, res) => {
  try { res.json(await db.getRewardSettings()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/reward-settings', checkAdmin, async (req, res) => {
  try {
    const threshold = parseInt(req.body.threshold, 10);
    const type = req.body.type;
    const value = parseInt(req.body.value, 10) || 0;
    const enabled = req.body.enabled !== false;
    if (!threshold || threshold < 1) return res.status(400).json({ error: 'عدد رحلات غير صحيح' });
    if (!['free_ride', 'percent', 'amount'].includes(type)) return res.status(400).json({ error: 'نوع مكافأة غير معروف' });
    res.json(await db.setRewardSettings(threshold, type, value, enabled));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// منح مكافأة يدوية لزبون معيّن
app.post('/api/admin/customer/:phone/grant-reward', checkAdmin, async (req, res) => {
  try {
    const settings = await db.getRewardSettings();
    if (!settings.enabled) return res.status(400).json({ error: 'نظام المكافآت متوقف حالياً — فعّله أول من الإعدادات' });
    const type = req.body.type;
    const value = parseInt(req.body.value, 10) || 0;
    if (!['free_ride', 'percent', 'amount'].includes(type)) return res.status(400).json({ error: 'نوع مكافأة غير معروف' });
    const reward = await db.grantManualReward(req.params.phone, type, value);
    res.json({ ok: true, reward });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// منح مكافأة يدوية لكل الزبائن دفعة وحدة
app.post('/api/admin/customers/grant-reward-all', checkAdmin, async (req, res) => {
  try {
    const settings = await db.getRewardSettings();
    if (!settings.enabled) return res.status(400).json({ error: 'نظام المكافآت متوقف حالياً — فعّله أول من الإعدادات' });
    const type = req.body.type;
    const value = parseInt(req.body.value, 10) || 0;
    if (!['free_ride', 'percent', 'amount'].includes(type)) return res.status(400).json({ error: 'نوع مكافأة غير معروف' });
    const customers = await db.getAllCustomers();
    for (const c of customers) await db.grantManualReward(c.phone, type, value);
    res.json({ ok: true, count: customers.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// مستحقات السواق من المكافآت (الزبون ما دفع، لازم تدفع إنت للسواق)
app.get('/api/admin/reward-payouts', checkAdmin, async (req, res) => {
  try { res.json(await db.getDriverPayouts()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/reward-payouts/:id/settle', checkAdmin, async (req, res) => {
  try { res.json({ ok: true, reward: await db.settleDriverPayout(parseInt(req.params.id, 10)) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/stats', checkAdmin, async (req, res) => {
  try {
    const [s, subRev, pendingRewards, payouts] = await Promise.all([
      db.getStats(), db.getSubscriptionRevenue(), db.getPendingAutoRewardsCount(), db.getDriverPayouts(),
    ]);
    res.json({
      ...s,
      driversOnline: onlineDrivers.size,
      activeRides: activeRides.size,
      subRevenue: subRev,
      pendingRewards,
      payoutsOwed: payouts.reduce((sum, p) => sum + (p.driver_payout || 0), 0),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
app.get('/api/stats', async (req, res) => {
  try {
    const s = await db.getStats();
    res.json({ driversOnline: onlineDrivers.size, activeRides: activeRides.size, ...s });
  } catch (e) { res.json({ driversOnline: onlineDrivers.size, activeRides: activeRides.size }); }
});

// حالة الطلب — يستخدمها السائق كشبكة أمان لو انقطع الاتصال
app.get('/api/ride/:id/status', (req, res) => {
  const ride = activeRides.get(req.params.id);
  if (!ride) return res.status(404).json({ error: 'غير موجود' });
  res.json({
    rideId: ride.id,
    status: ride.status,
    driverId: ride.driverId,
    fare: ride.estFare || ride.offerPrice || 0,
    customer: ride.customer,
  });
});

app.get('/api/ride/:id', (req, res) => {
  const ride = activeRides.get(req.params.id);
  if (!ride) return res.status(404).json({ error: 'غير موجودة' });
  res.json(ride);
});

// تقييم الزبون للرحلة بعد ما تخلص
app.post('/api/ride/:id/rate', async (req, res) => {
  try {
    const rating = parseInt(req.body.rating, 10);
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'تقييم غير صحيح' });
    await db.rateRide(req.params.id, rating, (req.body.note || '').trim());
    res.json({ ok: true });
  } catch (e) {
    console.error('خطأ بالتقييم:', e.message);
    res.status(500).json({ error: 'خطأ' });
  }
});

// ============================================================
const PORT = process.env.PORT || 3000;

(async () => {
  await db.init();
  server.listen(PORT, () => {
    console.log(`🚗 جايك يشتغل على المنفذ ${PORT}`);
    console.log(db.HAS_DB ? '   التخزين: PostgreSQL (دائم)' : '   التخزين: الذاكرة (مؤقت)');
  });
})();

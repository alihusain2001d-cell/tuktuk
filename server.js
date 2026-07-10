// ============================================================
//  تكتك المسيب - سيرفر الحجز والتتبع اللحظي
//  Tuktuk Al-Musayyib - Booking & Live Tracking Server
// ============================================================

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());

// المسارات الرئيسية
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));
app.get('/ride', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/driver', (req, res) => res.sendFile(path.join(__dirname, 'public', 'driver.html')));

app.use(express.static(path.join(__dirname)));

// ============================================================
//  التخزين في الذاكرة (للنسخة التجريبية)
//  In-memory store - swap to PostgreSQL for production
// ============================================================
const drivers = new Map();   // driverId -> { id, name, phone, car, lat, lng, online, socketId }
const rides = new Map();     // rideId   -> { id, customer, pickup, status, driverId, ... }
const sockets = new Map();   // socketId -> ws connection

function uid() {
  return crypto.randomBytes(6).toString('hex');
}

function broadcast(role, type, data, filterFn) {
  for (const [sid, ws] of sockets) {
    if (ws.readyState !== 1) continue;
    if (ws._role !== role) continue;
    if (filterFn && !filterFn(ws)) continue;
    ws.send(JSON.stringify({ type, data }));
  }
}

function sendTo(socketId, type, data) {
  const ws = sockets.get(socketId);
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type, data }));
  }
}

// ============================================================
//  WebSocket - الاتصال اللحظي
// ============================================================
wss.on('connection', (ws) => {
  const socketId = uid();
  ws._id = socketId;
  ws._role = null;
  sockets.set(socketId, ws);

  // ابعث معرف الاتصال للعميل حتى يستخدمه بالحجز
  ws.send(JSON.stringify({ type: 'welcome', data: { socketId } }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, data } = msg;

    switch (type) {
      // السواق يسجل دخوله ويصير متاح
      case 'driver:online': {
        ws._role = 'driver';
        ws._driverId = data.driverId;
        const d = drivers.get(data.driverId) || {};
        drivers.set(data.driverId, {
          ...d,
          id: data.driverId,
          name: data.name,
          phone: data.phone,
          car: data.car,
          lat: data.lat,
          lng: data.lng,
          online: true,
          socketId,
        });
        ws.send(JSON.stringify({ type: 'driver:confirmed', data: { online: true } }));
        break;
      }

      // السواق يحدث موقعه (يوصل للزبون اللي راكب وياه)
      case 'driver:location': {
        const d = drivers.get(ws._driverId);
        if (d) {
          d.lat = data.lat;
          d.lng = data.lng;
        }
        // لو عنده رحلة نشطة، ابعث موقعه للزبون
        for (const ride of rides.values()) {
          if (ride.driverId === ws._driverId &&
              (ride.status === 'accepted' || ride.status === 'arriving')) {
            sendTo(ride.customerSocketId, 'driver:moved', {
              lat: data.lat, lng: data.lng,
            });
          }
        }
        break;
      }

      case 'driver:offline': {
        const d = drivers.get(ws._driverId);
        if (d) d.online = false;
        break;
      }

      // الزبون يفتح التطبيق
      case 'customer:hello': {
        ws._role = 'customer';
        break;
      }

      default: break;
    }
  });

  ws.on('close', () => {
    if (ws._role === 'driver' && ws._driverId) {
      const d = drivers.get(ws._driverId);
      if (d) d.online = false;
    }
    sockets.delete(socketId);
  });
});

// ============================================================
//  API - الحجز
// ============================================================

// الزبون يحجز تكتك
app.post('/api/book', (req, res) => {
  const { name, phone, lat, lng, note, socketId } = req.body;
  if (!lat || !lng) return res.status(400).json({ error: 'الموقع مطلوب' });

  const rideId = uid();
  const ride = {
    id: rideId,
    customer: { name: name || 'زبون', phone: phone || '' },
    pickup: { lat, lng, note: note || '' },
    status: 'searching',      // searching -> accepted -> arriving -> arrived -> done
    driverId: null,
    customerSocketId: socketId,
    createdAt: Date.now(),
  };
  rides.set(rideId, ride);

  // ابعث إشعار لكل السواقين المتاحين
  const onlineDrivers = [...drivers.values()].filter(d => d.online);
  broadcast('driver', 'ride:new', {
    rideId,
    pickup: ride.pickup,
    customer: { name: ride.customer.name },
  }, () => true);

  res.json({
    rideId,
    driversNotified: onlineDrivers.length,
  });
});

// السواق يوافق على الرحلة
app.post('/api/accept', (req, res) => {
  const { rideId, driverId } = req.body;
  const ride = rides.get(rideId);
  if (!ride) return res.status(404).json({ error: 'الرحلة غير موجودة' });
  if (ride.status !== 'searching') {
    return res.status(409).json({ error: 'الرحلة انحجزت من سواق ثاني', taken: true });
  }

  const driver = drivers.get(driverId);
  if (!driver) return res.status(404).json({ error: 'السواق غير موجود' });

  ride.status = 'accepted';
  ride.driverId = driverId;
  ride.acceptedAt = Date.now();

  // احسب وقت وصول تقريبي (تكتك ~25 كم/ساعة)
  const dist = haversine(driver.lat, driver.lng, ride.pickup.lat, ride.pickup.lng);
  const etaMin = Math.max(1, Math.round((dist / 25) * 60));

  // بلغ الزبون
  sendTo(ride.customerSocketId, 'ride:accepted', {
    driver: {
      name: driver.name,
      phone: driver.phone,
      car: driver.car,
      lat: driver.lat,
      lng: driver.lng,
    },
    etaMin,
  });

  // بلغ باقي السواقين إن الرحلة انحجزت
  broadcast('driver', 'ride:taken', { rideId }, () => true);

  res.json({
    ok: true,
    pickup: ride.pickup,
    customer: ride.customer,
    etaMin,
  });
});

// السواق يعلن الوصول
app.post('/api/arrived', (req, res) => {
  const { rideId } = req.body;
  const ride = rides.get(rideId);
  if (!ride) return res.status(404).json({ error: 'الرحلة غير موجودة' });
  ride.status = 'arrived';
  sendTo(ride.customerSocketId, 'ride:arrived', {});
  res.json({ ok: true });
});

// إنهاء الرحلة
app.post('/api/complete', (req, res) => {
  const { rideId } = req.body;
  const ride = rides.get(rideId);
  if (!ride) return res.status(404).json({ error: 'الرحلة غير موجودة' });
  ride.status = 'done';
  ride.doneAt = Date.now();
  sendTo(ride.customerSocketId, 'ride:done', {});
  res.json({ ok: true });
});

// إلغاء الرحلة (من الزبون)
app.post('/api/cancel', (req, res) => {
  const { rideId } = req.body;
  const ride = rides.get(rideId);
  if (!ride) return res.status(404).json({ error: 'الرحلة غير موجودة' });
  ride.status = 'cancelled';
  if (ride.driverId) {
    const driver = drivers.get(ride.driverId);
    if (driver && driver.socketId) {
      sendTo(driver.socketId, 'ride:cancelled', { rideId });
    }
  }
  broadcast('driver', 'ride:taken', { rideId }, () => true);
  res.json({ ok: true });
});

// حالة الرحلة (للاستعلام)
app.get('/api/ride/:id', (req, res) => {
  const ride = rides.get(req.params.id);
  if (!ride) return res.status(404).json({ error: 'غير موجودة' });
  res.json(ride);
});

// إحصائيات بسيطة
app.get('/api/stats', (req, res) => {
  res.json({
    driversOnline: [...drivers.values()].filter(d => d.online).length,
    driversTotal: drivers.size,
    activeRides: [...rides.values()].filter(r =>
      ['searching', 'accepted', 'arriving', 'arrived'].includes(r.status)).length,
    totalRides: rides.size,
  });
});

// ============================================================
//  حساب المسافة بين نقطتين (كم)
// ============================================================
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`تكتك المسيب يشتغل على المنفذ ${PORT}`);
});

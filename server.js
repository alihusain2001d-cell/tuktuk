// ============================================================
//  تكتك المسيب - سيرفر الحجز والتتبع اللحظي (نسخة متطورة)
//  Tuktuk Al-Musayyib - v2
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

// ============ إعدادات الأجرة (غيّرها زي ما تريد) ============
const FARE = {
  base: 1000,       // أجرة الأساس (دينار)
  perKm: 500,       // سعر الكيلومتر (دينار)
  minimum: 1500,    // أقل أجرة للرحلة
};

// المسارات الرئيسية (الملفات بالجذر)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'home.html')));
app.get('/ride', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/driver', (req, res) => res.sendFile(path.join(__dirname, 'driver.html')));
app.use(express.static(path.join(__dirname)));

// ============================================================
//  التخزين في الذاكرة (تجريبي)
// ============================================================
const drivers = new Map();
const rides = new Map();
const sockets = new Map();
const driverStats = new Map();

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

// ============================================================
//  WebSocket
// ============================================================
wss.on('connection', (ws) => {
  const socketId = uid();
  ws._id = socketId;
  ws._role = null;
  sockets.set(socketId, ws);
  ws.send(JSON.stringify({ type: 'welcome', data: { socketId } }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, data } = msg;

    switch (type) {
      case 'driver:online': {
        ws._role = 'driver';
        ws._driverId = data.driverId;
        const d = drivers.get(data.driverId) || {};
        drivers.set(data.driverId, {
          ...d, id: data.driverId, name: data.name, phone: data.phone,
          car: data.car, lat: data.lat, lng: data.lng, online: true, socketId,
        });
        if (!driverStats.has(data.driverId)) {
          driverStats.set(data.driverId, { trips: [], totalEarnings: 0, totalKm: 0 });
        }
        ws.send(JSON.stringify({ type: 'driver:confirmed', data: { online: true } }));
        break;
      }

      case 'driver:location': {
        const d = drivers.get(ws._driverId);
        if (d) { d.lat = data.lat; d.lng = data.lng; }
        for (const ride of rides.values()) {
          if (ride.driverId === ws._driverId &&
              (ride.status === 'accepted' || ride.status === 'arriving')) {
            sendTo(ride.customerSocketId, 'driver:moved', { lat: data.lat, lng: data.lng });
          }
        }
        break;
      }

      case 'driver:offline': {
        const d = drivers.get(ws._driverId);
        if (d) d.online = false;
        break;
      }

      case 'customer:hello': { ws._role = 'customer'; break; }
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
//  API
// ============================================================

// الزبون يحجز — مع نقطة انطلاق ووصول
app.post('/api/book', (req, res) => {
  const { name, phone, pickup, destination, socketId } = req.body;
  if (!pickup || !pickup.lat) return res.status(400).json({ error: 'نقطة الانطلاق مطلوبة' });

  const rideId = uid();
  let estKm = 0, estFare = 0;
  if (destination && destination.lat) {
    estKm = haversine(pickup.lat, pickup.lng, destination.lat, destination.lng);
    estFare = calcFare(estKm);
  }

  const ride = {
    id: rideId,
    customer: { name: name || 'زبون', phone: phone || '' },
    pickup: { lat: pickup.lat, lng: pickup.lng, label: pickup.label || '' },
    destination: destination && destination.lat
      ? { lat: destination.lat, lng: destination.lng, label: destination.label || '' }
      : null,
    estKm, estFare,
    status: 'searching',
    driverId: null,
    customerSocketId: socketId,
    createdAt: Date.now(),
  };
  rides.set(rideId, ride);

  const onlineDrivers = [...drivers.values()].filter(d => d.online);
  broadcast('driver', 'ride:new', {
    rideId,
    pickup: ride.pickup,
    destination: ride.destination,
    estKm: Math.round(estKm * 10) / 10,
    estFare,
    customer: { name: ride.customer.name },
  });

  res.json({ rideId, driversNotified: onlineDrivers.length, estKm: Math.round(estKm*10)/10, estFare });
});

// السواق يقبل
app.post('/api/accept', (req, res) => {
  const { rideId, driverId } = req.body;
  const ride = rides.get(rideId);
  if (!ride) return res.status(404).json({ error: 'الرحلة غير موجودة' });
  if (ride.status !== 'searching') return res.status(409).json({ error: 'الرحلة انحجزت', taken: true });

  const driver = drivers.get(driverId);
  if (!driver) return res.status(404).json({ error: 'السواق غير موجود' });

  ride.status = 'accepted';
  ride.driverId = driverId;
  ride.acceptedAt = Date.now();

  const dist = haversine(driver.lat, driver.lng, ride.pickup.lat, ride.pickup.lng);
  const etaMin = Math.max(1, Math.round((dist / 25) * 60));

  sendTo(ride.customerSocketId, 'ride:accepted', {
    driver: { name: driver.name, phone: driver.phone, car: driver.car, lat: driver.lat, lng: driver.lng },
    etaMin,
  });

  broadcast('driver', 'ride:taken', { rideId });

  res.json({
    ok: true, pickup: ride.pickup, destination: ride.destination,
    customer: ride.customer, estKm: ride.estKm, estFare: ride.estFare, etaMin,
  });
});

app.post('/api/arrived', (req, res) => {
  const { rideId } = req.body;
  const ride = rides.get(rideId);
  if (!ride) return res.status(404).json({ error: 'غير موجودة' });
  ride.status = 'arrived';
  sendTo(ride.customerSocketId, 'ride:arrived', {});
  res.json({ ok: true });
});

// إنهاء الرحلة — يسجل بكشف حساب السواق
app.post('/api/complete', (req, res) => {
  const { rideId } = req.body;
  const ride = rides.get(rideId);
  if (!ride) return res.status(404).json({ error: 'غير موجودة' });
  ride.status = 'done';
  ride.doneAt = Date.now();

  if (ride.driverId) {
    const stats = driverStats.get(ride.driverId) || { trips: [], totalEarnings: 0, totalKm: 0 };
    const km = ride.estKm || 0;
    const fare = ride.estFare || calcFare(km);
    stats.trips.push({
      rideId: ride.id,
      customer: ride.customer.name,
      km: Math.round(km * 10) / 10,
      fare,
      from: ride.pickup.label || '—',
      to: ride.destination ? (ride.destination.label || '—') : '—',
      at: ride.doneAt,
    });
    stats.totalEarnings += fare;
    stats.totalKm += km;
    driverStats.set(ride.driverId, stats);
  }

  sendTo(ride.customerSocketId, 'ride:done', { fare: ride.estFare });
  res.json({ ok: true, fare: ride.estFare });
});

app.post('/api/cancel', (req, res) => {
  const { rideId } = req.body;
  const ride = rides.get(rideId);
  if (!ride) return res.status(404).json({ error: 'غير موجودة' });
  ride.status = 'cancelled';
  if (ride.driverId) {
    const driver = drivers.get(ride.driverId);
    if (driver && driver.socketId) sendTo(driver.socketId, 'ride:cancelled', { rideId });
  }
  broadcast('driver', 'ride:taken', { rideId });
  res.json({ ok: true });
});

// كشف حساب السواق
app.get('/api/driver/:id/earnings', (req, res) => {
  const stats = driverStats.get(req.params.id) || { trips: [], totalEarnings: 0, totalKm: 0 };
  const today = new Date(); today.setHours(0,0,0,0);
  const todayTrips = stats.trips.filter(t => t.at >= today.getTime());
  const todayEarnings = todayTrips.reduce((s, t) => s + t.fare, 0);
  res.json({
    totalEarnings: stats.totalEarnings,
    totalKm: Math.round(stats.totalKm * 10) / 10,
    totalTrips: stats.trips.length,
    todayEarnings,
    todayTrips: todayTrips.length,
    trips: stats.trips.slice(-20).reverse(),
  });
});

app.get('/api/ride/:id', (req, res) => {
  const ride = rides.get(req.params.id);
  if (!ride) return res.status(404).json({ error: 'غير موجودة' });
  res.json(ride);
});

app.get('/api/stats', (req, res) => {
  res.json({
    driversOnline: [...drivers.values()].filter(d => d.online).length,
    driversTotal: drivers.size,
    activeRides: [...rides.values()].filter(r => ['searching','accepted','arriving','arrived'].includes(r.status)).length,
    totalRides: rides.size,
  });
});

// ============================================================
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`تكتك المسيب v2 يشتغل على المنفذ ${PORT}`));

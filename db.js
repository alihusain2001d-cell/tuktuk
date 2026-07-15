// ============================================================
//  جايك - طبقة قاعدة البيانات
//  تشتغل على PostgreSQL، ولو ماكو قاعدة تشتغل بالذاكرة تلقائياً
// ============================================================

const { Pool } = require('pg');

const HAS_DB = !!process.env.DATABASE_URL;
let pool = null;

// SSL مطلوب بس للاتصالات الخارجية (العامة).
// الاتصال الداخلي بـ Railway (railway.internal) والمحلي ما يحتاجون SSL.
function needsSSL(url) {
  if (!url) return false;
  if (url.includes('localhost') || url.includes('127.0.0.1')) return false;
  if (url.includes('.railway.internal')) return false;  // شبكة Railway الداخلية
  if (url.includes('sslmode=disable')) return false;
  return true;
}

if (HAS_DB) {
  const url = process.env.DATABASE_URL;
  pool = new Pool({
    connectionString: url,
    ssl: needsSSL(url) ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  pool.on('error', (err) => console.error('خطأ بقاعدة البيانات:', err.message));
}

// ============ تخزين احتياطي بالذاكرة ============
const mem = {
  drivers: new Map(),
  customers: new Map(),
  rides: new Map(),
};

// ============ إنشاء الجداول ============
async function init() {
  if (!HAS_DB) {
    console.log('⚠️  ماكو DATABASE_URL — نشتغل بالذاكرة (البيانات تنمسح عند إعادة النشر)');
    return false;
  }
  // تأكد من الاتصال أول
  try {
    const test = await pool.query('SELECT 1 AS ok');
    const host = (process.env.DATABASE_URL.match(/@([^:/]+)/) || [])[1] || '؟';
    console.log(`🔌 اتصلنا بقاعدة البيانات (${host}) — SSL: ${needsSSL(process.env.DATABASE_URL) ? 'مفعّل' : 'مطفي'}`);
  } catch (e) {
    console.error('❌ ما كدرنا نتصل بقاعدة البيانات:', e.message);
    console.error('   تأكد من DATABASE_URL بمتغيرات التطبيق');
    return false;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS drivers (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        phone         TEXT NOT NULL,
        car           TEXT,
        photo_car     TEXT,
        photo_id_front TEXT,
        photo_id_back TEXT,
        status        TEXT NOT NULL DEFAULT 'pending',
        trial_ends_at TIMESTAMPTZ,
        sub_ends_at   TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_lat      DOUBLE PRECISION,
        last_lng      DOUBLE PRECISION
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        phone      TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rides (
        id             TEXT PRIMARY KEY,
        type           TEXT NOT NULL DEFAULT 'ride',
        customer_name  TEXT,
        customer_phone TEXT,
        pickup_lat     DOUBLE PRECISION,
        pickup_lng     DOUBLE PRECISION,
        pickup_label   TEXT,
        dest_lat       DOUBLE PRECISION,
        dest_lng       DOUBLE PRECISION,
        dest_label     TEXT,
        store_lat      DOUBLE PRECISION,
        store_lng      DOUBLE PRECISION,
        store_label    TEXT,
        item_desc      TEXT,
        est_km         DOUBLE PRECISION DEFAULT 0,
        est_fare       INTEGER DEFAULT 0,
        status         TEXT NOT NULL DEFAULT 'searching',
        driver_id      TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        done_at        TIMESTAMPTZ
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_rides_driver ON rides(driver_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);`);
    console.log('✅ قاعدة البيانات جاهزة (PostgreSQL)');
    return true;
  } catch (e) {
    console.error('❌ فشل إنشاء الجداول:', e.message);
    return false;
  }
}

// ============ السواقين ============
async function upsertDriver(d) {
  if (!HAS_DB) {
    const existing = mem.drivers.get(d.id) || {};
    // أول تسجيل: نحسب فترة التجربة (يوم واحد)
    const created = existing.created_at || new Date();
    const trial = existing.trial_ends_at || new Date(created.getTime() + 24*60*60*1000);
    mem.drivers.set(d.id, { ...existing, ...d, created_at: created, trial_ends_at: trial,
      status: existing.status || 'pending' });
    return mem.drivers.get(d.id);
  }
  const res = await pool.query(`
    INSERT INTO drivers (id, name, phone, car, photo_car, photo_id_front, photo_id_back, trial_ends_at, last_lat, last_lng)
    VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() + INTERVAL '1 day', $8,$9)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      phone = EXCLUDED.phone,
      car = EXCLUDED.car,
      photo_car = COALESCE(EXCLUDED.photo_car, drivers.photo_car),
      photo_id_front = COALESCE(EXCLUDED.photo_id_front, drivers.photo_id_front),
      photo_id_back = COALESCE(EXCLUDED.photo_id_back, drivers.photo_id_back),
      last_lat = EXCLUDED.last_lat,
      last_lng = EXCLUDED.last_lng
    RETURNING *;
  `, [d.id, d.name, d.phone, d.car || null, d.photo_car || null, d.photo_id_front || null,
      d.photo_id_back || null, d.last_lat || null, d.last_lng || null]);
  return res.rows[0];
}

async function getDriver(id) {
  if (!HAS_DB) return mem.drivers.get(id) || null;
  const res = await pool.query('SELECT * FROM drivers WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function getAllDrivers() {
  if (!HAS_DB) return [...mem.drivers.values()];
  const res = await pool.query('SELECT * FROM drivers ORDER BY created_at DESC');
  return res.rows;
}

async function updateDriverLocation(id, lat, lng) {
  if (!HAS_DB) {
    const d = mem.drivers.get(id);
    if (d) { d.last_lat = lat; d.last_lng = lng; }
    return;
  }
  await pool.query('UPDATE drivers SET last_lat=$2, last_lng=$3 WHERE id=$1', [id, lat, lng]);
}

// حالة السواق: هل يقدر يشتغل؟
// pending = ينتظر التفعيل | active = مفعّل باشتراك | trial = بفترة التجربة | expired = انتهى
async function getDriverAccess(id) {
  const d = await getDriver(id);
  if (!d) return { allowed: false, reason: 'not_found' };

  const now = Date.now();
  const subEnds = d.sub_ends_at ? new Date(d.sub_ends_at).getTime() : 0;
  const trialEnds = d.trial_ends_at ? new Date(d.trial_ends_at).getTime() : 0;

  // اشتراك فعّال
  if (subEnds > now) {
    return { allowed: true, reason: 'subscribed', until: d.sub_ends_at,
             daysLeft: Math.ceil((subEnds - now) / 86400000) };
  }
  // فترة تجربة فعّالة
  if (trialEnds > now) {
    return { allowed: true, reason: 'trial', until: d.trial_ends_at,
             hoursLeft: Math.ceil((trialEnds - now) / 3600000) };
  }
  // انتهى كلشي
  return { allowed: false, reason: subEnds ? 'expired' : 'trial_ended' };
}

// المالك يفعّل اشتراك (من لوحة التحكم)
async function setDriverSubscription(id, days) {
  if (!HAS_DB) {
    const d = mem.drivers.get(id);
    if (d) { d.sub_ends_at = new Date(Date.now() + days*86400000); d.status = 'active'; }
    return d;
  }
  const res = await pool.query(`
    UPDATE drivers SET sub_ends_at = NOW() + ($2 || ' days')::INTERVAL, status='active'
    WHERE id=$1 RETURNING *;
  `, [id, String(days)]);
  return res.rows[0];
}

async function setDriverStatus(id, status) {
  if (!HAS_DB) {
    const d = mem.drivers.get(id);
    if (d) d.status = status;
    return d;
  }
  const res = await pool.query('UPDATE drivers SET status=$2 WHERE id=$1 RETURNING *', [id, status]);
  return res.rows[0];
}

// ============ الزبائن ============
async function upsertCustomer(phone, name) {
  if (!HAS_DB) { mem.customers.set(phone, { phone, name, created_at: new Date() }); return; }
  await pool.query(`
    INSERT INTO customers (phone, name) VALUES ($1,$2)
    ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name;
  `, [phone, name]);
}

async function getAllCustomers() {
  if (!HAS_DB) return [...mem.customers.values()];
  const res = await pool.query('SELECT * FROM customers ORDER BY created_at DESC');
  return res.rows;
}

// ============ الرحلات ============
async function createRide(r) {
  if (!HAS_DB) { mem.rides.set(r.id, { ...r, created_at: new Date() }); return r; }
  await pool.query(`
    INSERT INTO rides (id, type, customer_name, customer_phone, pickup_lat, pickup_lng, pickup_label,
      dest_lat, dest_lng, dest_label, store_lat, store_lng, store_label, item_desc, est_km, est_fare, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17);
  `, [r.id, r.type, r.customer.name, r.customer.phone,
      r.pickup.lat, r.pickup.lng, r.pickup.label,
      r.destination?.lat || null, r.destination?.lng || null, r.destination?.label || null,
      r.store?.lat || null, r.store?.lng || null, r.store?.label || null,
      r.itemDesc || null, r.estKm, r.estFare, r.status]);
  return r;
}

async function updateRideStatus(id, status, driverId) {
  if (!HAS_DB) {
    const r = mem.rides.get(id);
    if (r) { r.status = status; if (driverId) r.driverId = driverId; if (status==='done') r.done_at = new Date(); }
    return;
  }
  if (status === 'done') {
    await pool.query('UPDATE rides SET status=$2, done_at=NOW() WHERE id=$1', [id, status]);
  } else if (driverId) {
    await pool.query('UPDATE rides SET status=$2, driver_id=$3 WHERE id=$1', [id, status, driverId]);
  } else {
    await pool.query('UPDATE rides SET status=$2 WHERE id=$1', [id, status]);
  }
}

async function getAllRides(limit = 100) {
  if (!HAS_DB) return [...mem.rides.values()].reverse().slice(0, limit);
  const res = await pool.query('SELECT * FROM rides ORDER BY created_at DESC LIMIT $1', [limit]);
  return res.rows;
}

// كشف حساب السواق
async function getDriverEarnings(driverId) {
  if (!HAS_DB) {
    const trips = [...mem.rides.values()].filter(r => r.driverId === driverId && r.status === 'done');
    const total = trips.reduce((s,t) => s + (t.estFare||0), 0);
    const km = trips.reduce((s,t) => s + (t.estKm||0), 0);
    const today = new Date(); today.setHours(0,0,0,0);
    const todayTrips = trips.filter(t => t.done_at && t.done_at.getTime() >= today.getTime());
    return {
      totalEarnings: total, totalKm: Math.round(km*10)/10, totalTrips: trips.length,
      todayEarnings: todayTrips.reduce((s,t)=>s+(t.estFare||0),0), todayTrips: todayTrips.length,
      trips: trips.slice(-20).reverse().map(t => ({
        rideId: t.id, customer: t.customer.name, km: Math.round((t.estKm||0)*10)/10,
        fare: t.estFare||0, from: t.pickup.label||'—', to: t.destination?.label||'—',
        at: t.done_at ? t.done_at.getTime() : Date.now(), type: t.type,
      })),
    };
  }
  const totals = await pool.query(`
    SELECT COUNT(*)::int AS trips, COALESCE(SUM(est_fare),0)::int AS earnings,
           COALESCE(SUM(est_km),0) AS km
    FROM rides WHERE driver_id=$1 AND status='done';
  `, [driverId]);
  const todayRes = await pool.query(`
    SELECT COUNT(*)::int AS trips, COALESCE(SUM(est_fare),0)::int AS earnings
    FROM rides WHERE driver_id=$1 AND status='done' AND done_at >= CURRENT_DATE;
  `, [driverId]);
  const list = await pool.query(`
    SELECT id, type, customer_name, est_km, est_fare, pickup_label, dest_label, store_label, done_at
    FROM rides WHERE driver_id=$1 AND status='done' ORDER BY done_at DESC LIMIT 20;
  `, [driverId]);
  const t = totals.rows[0], td = todayRes.rows[0];
  return {
    totalEarnings: t.earnings, totalKm: Math.round(t.km*10)/10, totalTrips: t.trips,
    todayEarnings: td.earnings, todayTrips: td.trips,
    trips: list.rows.map(r => ({
      rideId: r.id, customer: r.customer_name, km: Math.round((r.est_km||0)*10)/10,
      fare: r.est_fare||0, from: r.type==='delivery' ? (r.store_label||'—') : (r.pickup_label||'—'),
      to: r.dest_label||'—', at: r.done_at ? new Date(r.done_at).getTime() : Date.now(), type: r.type,
    })),
  };
}

// إحصائيات عامة (للوحة التحكم لاحقاً)
async function getStats() {
  if (!HAS_DB) {
    const rides = [...mem.rides.values()];
    return {
      driversTotal: mem.drivers.size,
      customersTotal: mem.customers.size,
      totalRides: rides.length,
      doneRides: rides.filter(r=>r.status==='done').length,
      totalRevenue: rides.filter(r=>r.status==='done').reduce((s,r)=>s+(r.estFare||0),0),
    };
  }
  const res = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM drivers) AS drivers_total,
      (SELECT COUNT(*)::int FROM customers) AS customers_total,
      (SELECT COUNT(*)::int FROM rides) AS total_rides,
      (SELECT COUNT(*)::int FROM rides WHERE status='done') AS done_rides,
      (SELECT COALESCE(SUM(est_fare),0)::int FROM rides WHERE status='done') AS total_revenue;
  `);
  const r = res.rows[0];
  return {
    driversTotal: r.drivers_total, customersTotal: r.customers_total,
    totalRides: r.total_rides, doneRides: r.done_rides, totalRevenue: r.total_revenue,
  };
}

module.exports = {
  HAS_DB, init,
  upsertDriver, getDriver, getAllDrivers, updateDriverLocation,
  getDriverAccess, setDriverSubscription, setDriverStatus,
  upsertCustomer, getAllCustomers,
  createRide, updateRideStatus, getAllRides, getDriverEarnings, getStats,
};

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
    connectionTimeoutMillis: 20000,
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
        photo_self    TEXT,
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
    // ترقية: أضف العمود لو الجدول موجود من قبل
    await pool.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS photo_self TEXT;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        phone      TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    // ترقية: معرّف ثابت للزبون
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS id TEXT;`);
    await pool.query(`UPDATE customers SET id = 'cus_' || md5(phone) WHERE id IS NULL;`);
    // ترقية: صورة الزبون الشخصية
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS photo TEXT;`);
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
        store_name     TEXT,
        item_desc      TEXT,
        est_km         DOUBLE PRECISION DEFAULT 0,
        est_fare       INTEGER DEFAULT 0,
        offer_price    INTEGER,
        offer_note     TEXT,
        status         TEXT NOT NULL DEFAULT 'searching',
        driver_id      TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        done_at        TIMESTAMPTZ
      );
    `);
    // ترقية الأعمدة الجديدة
    await pool.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS store_name TEXT;`);
    await pool.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS offer_price INTEGER;`);
    await pool.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS offer_note TEXT;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_rides_driver ON rides(driver_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);`);

    // سجل الاشتراكات المدفوعة (ربح المالك)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id          SERIAL PRIMARY KEY,
        driver_id   TEXT NOT NULL,
        driver_name TEXT,
        days        INTEGER NOT NULL,
        amount      INTEGER NOT NULL DEFAULT 0,
        note        TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_subs_driver ON subscriptions(driver_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_subs_date ON subscriptions(created_at);`);

    // المواقع المفضلة للزبون
    await pool.query(`
      CREATE TABLE IF NOT EXISTS saved_places (
        id         SERIAL PRIMARY KEY,
        phone      TEXT NOT NULL,
        name       TEXT NOT NULL,
        lat        DOUBLE PRECISION NOT NULL,
        lng        DOUBLE PRECISION NOT NULL,
        address    TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_places_phone ON saved_places(phone);`);

    // إعدادات مكافأة الولاء (قاعدة عامة: بعد كم رحلة، ونوع المكافأة)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reward_settings (
        id              INTEGER PRIMARY KEY DEFAULT 1,
        trips_threshold INTEGER NOT NULL DEFAULT 10,
        reward_type     TEXT NOT NULL DEFAULT 'free_ride',
        reward_value    INTEGER NOT NULL DEFAULT 0,
        CHECK (id = 1)
      );
    `);
    await pool.query(`INSERT INTO reward_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);
    await pool.query(`ALTER TABLE reward_settings ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;`);

    // إعدادات الأجرة (حسب الكيلومتر أو سعر ثابت)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fare_settings (
        id          INTEGER PRIMARY KEY DEFAULT 1,
        mode        TEXT NOT NULL DEFAULT 'per_km',
        base        INTEGER NOT NULL DEFAULT 1000,
        per_km      INTEGER NOT NULL DEFAULT 500,
        minimum     INTEGER NOT NULL DEFAULT 1500,
        fixed_price INTEGER NOT NULL DEFAULT 2000,
        CHECK (id = 1)
      );
    `);
    await pool.query(`INSERT INTO fare_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);

    // مكافآت الزبائن (تلقائية أو يدوية) وربطها بمصاريف السائق
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customer_rewards (
        id              SERIAL PRIMARY KEY,
        phone           TEXT NOT NULL,
        reward_type     TEXT NOT NULL,
        reward_value    INTEGER NOT NULL DEFAULT 0,
        source          TEXT NOT NULL DEFAULT 'auto',
        status          TEXT NOT NULL DEFAULT 'pending',
        ride_id         TEXT,
        driver_id       TEXT,
        driver_payout   INTEGER,
        payout_settled  BOOLEAN NOT NULL DEFAULT false,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        used_at         TIMESTAMPTZ
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cr_phone ON customer_rewards(phone);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cr_status ON customer_rewards(status);`);

    // روابط التواصل (واتساب، فيسبوك، انستا، تلكرام) — يحددها الأدمن من لوحة التحكم
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contact_settings (
        id        INTEGER PRIMARY KEY DEFAULT 1,
        whatsapp  TEXT,
        facebook  TEXT,
        instagram TEXT,
        telegram  TEXT,
        CHECK (id = 1)
      );
    `);
    await pool.query(`INSERT INTO contact_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);

    // ترقية: عمود المبلغ اللي الزبون فعلاً دفعه (يختلف عن est_fare لو تطبقت مكافأة)
    await pool.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS customer_paid INTEGER;`);
    await pool.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS reward_id INTEGER;`);

    // ترقية: تقييم الزبون للرحلة بعد ما تخلص
    await pool.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS rating INTEGER;`);
    await pool.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS rating_note TEXT;`);

    // ترقية: سبب إلغاء الزبون للطلب
    await pool.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS cancel_reason TEXT;`);

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
    INSERT INTO drivers (id, name, phone, car, photo_self, photo_car, photo_id_front, photo_id_back, trial_ends_at, last_lat, last_lng)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW() + INTERVAL '1 day', $9,$10)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      phone = EXCLUDED.phone,
      car = EXCLUDED.car,
      photo_self = COALESCE(EXCLUDED.photo_self, drivers.photo_self),
      photo_car = COALESCE(EXCLUDED.photo_car, drivers.photo_car),
      photo_id_front = COALESCE(EXCLUDED.photo_id_front, drivers.photo_id_front),
      photo_id_back = COALESCE(EXCLUDED.photo_id_back, drivers.photo_id_back),
      last_lat = EXCLUDED.last_lat,
      last_lng = EXCLUDED.last_lng
    RETURNING *;
  `, [d.id, d.name, d.phone, d.car || null, d.photo_self || null, d.photo_car || null,
      d.photo_id_front || null, d.photo_id_back || null, d.last_lat || null, d.last_lng || null]);
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

// يدوّر على السائق برقم موبايله (لتسجيل الدخول)
async function getDriverByPhone(phone) {
  const clean = String(phone || '').replace(/\D/g, '');
  if (!clean) return null;
  if (!HAS_DB) {
    for (const d of mem.drivers.values()) {
      if (String(d.phone || '').replace(/\D/g, '') === clean) return d;
    }
    return null;
  }
  // نقارن بس الأرقام حتى ما تأثر المسافات أو الرموز
  const res = await pool.query(
    `SELECT * FROM drivers WHERE regexp_replace(phone, '\\D', '', 'g') = $1 LIMIT 1`,
    [clean]
  );
  return res.rows[0] || null;
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

// المالك يفعّل اشتراك ويسجّل المبلغ المقبوض
async function setDriverSubscription(id, days, amount = 0, note = '') {
  if (!HAS_DB) {
    const d = mem.drivers.get(id);
    if (d) { d.sub_ends_at = new Date(Date.now() + days*86400000); d.status = 'active'; }
    if (!mem.subs) mem.subs = [];
    mem.subs.push({ id: mem.subs.length+1, driver_id:id, driver_name: d?.name, days, amount: amount||0, note, created_at: new Date() });
    return d;
  }
  const res = await pool.query(`
    UPDATE drivers SET sub_ends_at = NOW() + ($2 || ' days')::INTERVAL, status='active'
    WHERE id=$1 RETURNING *;
  `, [id, String(days)]);
  const d = res.rows[0];
  // سجّل الدفعة
  await pool.query(
    `INSERT INTO subscriptions (driver_id, driver_name, days, amount, note) VALUES ($1,$2,$3,$4,$5)`,
    [id, d ? d.name : null, days, parseInt(amount,10) || 0, note || null]
  );
  return d;
}

// إجمالي ربح المالك من الاشتراكات
async function getSubscriptionRevenue() {
  if (!HAS_DB) {
    const subs = mem.subs || [];
    const today = new Date(); today.setHours(0,0,0,0);
    const month = new Date(); month.setDate(1); month.setHours(0,0,0,0);
    return {
      total: subs.reduce((s,x)=>s+(x.amount||0), 0),
      today: subs.filter(x=>x.created_at>=today).reduce((s,x)=>s+(x.amount||0), 0),
      month: subs.filter(x=>x.created_at>=month).reduce((s,x)=>s+(x.amount||0), 0),
      count: subs.length,
    };
  }
  const res = await pool.query(`
    SELECT
      COALESCE(SUM(amount),0)::int AS total,
      COALESCE(SUM(amount) FILTER (WHERE created_at >= CURRENT_DATE),0)::int AS today,
      COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('month', CURRENT_DATE)),0)::int AS month,
      COUNT(*)::int AS count
    FROM subscriptions;
  `);
  return res.rows[0];
}

// سجل الاشتراكات المدفوعة
async function getSubscriptions(limit = 100) {
  if (!HAS_DB) return (mem.subs || []).slice().reverse().slice(0, limit);
  const res = await pool.query(
    `SELECT * FROM subscriptions ORDER BY created_at DESC LIMIT $1`, [limit]
  );
  return res.rows;
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

// إيقاف الاشتراك وفترة التجربة فوراً
async function revokeDriverSubscription(id) {
  if (!HAS_DB) {
    const d = mem.drivers.get(id);
    if (d) { d.sub_ends_at = new Date(Date.now() - 1000); d.trial_ends_at = new Date(Date.now() - 1000); d.status = 'pending'; }
    return d;
  }
  const res = await pool.query(`
    UPDATE drivers SET sub_ends_at = NOW() - INTERVAL '1 second',
                       trial_ends_at = NOW() - INTERVAL '1 second',
                       status='pending'
    WHERE id=$1 RETURNING *;
  `, [id]);
  return res.rows[0];
}

// حذف سائق (مع رحلاته)
async function deleteDriver(id) {
  if (!HAS_DB) { mem.drivers.delete(id); return true; }
  await pool.query('UPDATE rides SET driver_id=NULL WHERE driver_id=$1', [id]);
  await pool.query('DELETE FROM drivers WHERE id=$1', [id]);
  return true;
}

// ============ الزبائن ============
function cleanPhone(p) { return String(p || '').replace(/\D/g, ''); }

async function upsertCustomer(phone, name) {
  const clean = cleanPhone(phone);
  if (!clean) return null;
  if (!HAS_DB) {
    const ex = mem.customers.get(clean) || {};
    const rec = { ...ex, id: ex.id || ('cus_' + clean), phone: clean, name, created_at: ex.created_at || new Date() };
    mem.customers.set(clean, rec);
    return rec;
  }
  const res = await pool.query(`
    INSERT INTO customers (phone, name, id) VALUES ($1,$2,$3)
    ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name
    RETURNING *;
  `, [clean, name, 'cus_' + clean]);
  return res.rows[0];
}

// يدوّر على الزبون برقمه (لتسجيل الدخول)
async function getCustomerByPhone(phone) {
  const clean = cleanPhone(phone);
  if (!clean) return null;
  if (!HAS_DB) return mem.customers.get(clean) || null;
  const res = await pool.query(
    `SELECT * FROM customers WHERE regexp_replace(phone, '\\D', '', 'g') = $1 LIMIT 1`,
    [clean]
  );
  return res.rows[0] || null;
}

// تحديث الاسم و/أو الصورة
async function updateCustomerProfile(phone, { name, photo } = {}) {
  const clean = cleanPhone(phone);
  if (!HAS_DB) {
    const rec = mem.customers.get(clean);
    if (!rec) return null;
    if (name) rec.name = name;
    if (photo !== undefined) rec.photo = photo;
    return rec;
  }
  const sets = [], vals = [clean];
  if (name) { vals.push(name); sets.push(`name=$${vals.length}`); }
  if (photo !== undefined) { vals.push(photo); sets.push(`photo=$${vals.length}`); }
  if (!sets.length) return getCustomerByPhone(phone);
  const res = await pool.query(`UPDATE customers SET ${sets.join(', ')} WHERE phone=$1 RETURNING *`, vals);
  return res.rows[0] || null;
}

// تغيير رقم الزبون (بعد التحقق بـ OTP) — لازم نحدّث كل الجداول اللي فيها رقمه القديم
async function changeCustomerPhone(oldPhone, newPhone) {
  const oldClean = cleanPhone(oldPhone), newClean = cleanPhone(newPhone);
  if (!HAS_DB) {
    const rec = mem.customers.get(oldClean);
    if (!rec) return null;
    rec.phone = newClean;
    mem.customers.delete(oldClean);
    mem.customers.set(newClean, rec);
    for (const r of mem.rides.values()) if (cleanPhone(r.customer?.phone) === oldClean) r.customer.phone = newClean;
    (mem.rewards || []).forEach(x => { if (x.phone === oldClean) x.phone = newClean; });
    (mem.places || []).forEach(x => { if (x.phone === oldClean) x.phone = newClean; });
    return rec;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE customers SET phone=$2 WHERE phone=$1', [oldClean, newClean]);
    await client.query('UPDATE rides SET customer_phone=$2 WHERE customer_phone=$1', [oldClean, newClean]);
    await client.query('UPDATE customer_rewards SET phone=$2 WHERE phone=$1', [oldClean, newClean]);
    await client.query('UPDATE saved_places SET phone=$2 WHERE phone=$1', [oldClean, newClean]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return getCustomerByPhone(newClean);
}

// عدد رحلات الزبون
async function getCustomerTripCount(phone) {
  const clean = cleanPhone(phone);
  if (!HAS_DB) {
    return [...mem.rides.values()].filter(r => cleanPhone(r.customer?.phone) === clean && r.status === 'done').length;
  }
  const res = await pool.query(
    `SELECT COUNT(*)::int AS n FROM rides WHERE regexp_replace(customer_phone, '\\D', '', 'g') = $1 AND status='done'`,
    [clean]
  );
  return res.rows[0].n;
}

// سجل رحلات الزبون المنجزة
async function getCustomerTrips(phone, limit = 30) {
  const clean = cleanPhone(phone);
  if (!HAS_DB) {
    return [...mem.rides.values()]
      .filter(r => cleanPhone(r.customer?.phone) === clean && r.status === 'done')
      .slice(-limit).reverse()
      .map(t => ({
        rideId: t.id, type: t.type,
        from: t.type === 'delivery' ? (t.storeName || t.store?.label || '—') : (t.pickup.label || '—'),
        to: t.destination?.label || '—',
        fare: t.estFare || 0, km: Math.round((t.estKm || 0) * 10) / 10,
        at: t.done_at ? t.done_at.getTime() : Date.now(),
      }));
  }
  const res = await pool.query(`
    SELECT id, type, pickup_label, dest_label, store_label, store_name, est_km, est_fare, done_at
    FROM rides WHERE regexp_replace(customer_phone, '\\D', '', 'g') = $1 AND status='done'
    ORDER BY done_at DESC LIMIT $2;
  `, [clean, limit]);
  return res.rows.map(r => ({
    rideId: r.id, type: r.type,
    from: r.type === 'delivery' ? (r.store_name || r.store_label || '—') : (r.pickup_label || '—'),
    to: r.dest_label || '—',
    fare: r.est_fare || 0, km: Math.round((r.est_km || 0) * 10) / 10,
    at: r.done_at ? new Date(r.done_at).getTime() : Date.now(),
  }));
}

// ============ المواقع المفضلة ============
async function addSavedPlace(phone, name, lat, lng, address) {
  const clean = cleanPhone(phone);
  if (!HAS_DB) {
    if (!mem.places) mem.places = [];
    const id = (mem.places.length ? Math.max(...mem.places.map(p => p.id)) : 0) + 1;
    const rec = { id, phone: clean, name, lat, lng, address: address || null, created_at: new Date() };
    mem.places.push(rec);
    return rec;
  }
  const res = await pool.query(
    `INSERT INTO saved_places (phone, name, lat, lng, address) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [clean, name, lat, lng, address || null]
  );
  return res.rows[0];
}

async function getSavedPlaces(phone) {
  const clean = cleanPhone(phone);
  if (!HAS_DB) return (mem.places || []).filter(p => p.phone === clean).slice().reverse();
  const res = await pool.query(
    `SELECT * FROM saved_places WHERE regexp_replace(phone, '\\D', '', 'g') = $1 ORDER BY created_at DESC`,
    [clean]
  );
  return res.rows;
}

async function deleteSavedPlace(id, phone) {
  const clean = cleanPhone(phone);
  if (!HAS_DB) {
    if (!mem.places) mem.places = [];
    mem.places = mem.places.filter(p => !(p.id === Number(id) && p.phone === clean));
    return true;
  }
  await pool.query(
    `DELETE FROM saved_places WHERE id=$1 AND regexp_replace(phone, '\\D', '', 'g') = $2`,
    [id, clean]
  );
  return true;
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
      dest_lat, dest_lng, dest_label, store_lat, store_lng, store_label, store_name, item_desc, est_km, est_fare, status, customer_paid, reward_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20);
  `, [r.id, r.type, r.customer.name, r.customer.phone,
      r.pickup.lat, r.pickup.lng, r.pickup.label,
      r.destination?.lat || null, r.destination?.lng || null, r.destination?.label || null,
      r.store?.lat || null, r.store?.lng || null, r.store?.label || null,
      r.storeName || null, r.itemDesc || null, r.estKm, r.estFare, r.status,
      r.customerPaid != null ? r.customerPaid : r.estFare, r.rewardId || null]);
  return r;
}

// السائق يقدم عرض سعر على طلب توصيل
async function setRideOffer(rideId, driverId, price, note) {
  if (!HAS_DB) {
    const r = mem.rides.get(rideId);
    if (r) { r.offer_price = price; r.offer_note = note; r.driverId = driverId; r.status = 'offered'; }
    return r;
  }
  const res = await pool.query(`
    UPDATE rides SET offer_price=$3, offer_note=$4, driver_id=$2, status='offered'
    WHERE id=$1 RETURNING *;
  `, [rideId, driverId, price, note || null]);
  return res.rows[0];
}

// الزبون يرفض العرض — يرجع الطلب للبحث
async function clearRideOffer(rideId) {
  if (!HAS_DB) {
    const r = mem.rides.get(rideId);
    if (r) { r.offer_price = null; r.offer_note = null; r.driverId = null; r.status = 'searching'; }
    return r;
  }
  const res = await pool.query(`
    UPDATE rides SET offer_price=NULL, offer_note=NULL, driver_id=NULL, status='searching'
    WHERE id=$1 RETURNING *;
  `, [rideId]);
  return res.rows[0];
}

// الزبون يوافق على العرض — الأجرة تصير سعر العرض
async function acceptRideOffer(rideId) {
  if (!HAS_DB) {
    const r = mem.rides.get(rideId);
    if (r) { r.estFare = r.offer_price; r.status = 'accepted'; }
    return r;
  }
  const res = await pool.query(`
    UPDATE rides SET est_fare = offer_price, status='accepted'
    WHERE id=$1 RETURNING *;
  `, [rideId]);
  return res.rows[0];
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

// إلغاء الرحلة مع تسجيل سبب الزبون
async function cancelRideWithReason(id, reason) {
  if (!HAS_DB) {
    const r = mem.rides.get(id);
    if (r) { r.status = 'cancelled'; r.cancelReason = reason || null; }
    return;
  }
  await pool.query('UPDATE rides SET status=$2, cancel_reason=$3 WHERE id=$1', [id, 'cancelled', reason || null]);
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
    SELECT id, type, customer_name, est_km, est_fare, pickup_label, dest_label, store_label, store_name, done_at
    FROM rides WHERE driver_id=$1 AND status='done' ORDER BY done_at DESC LIMIT 20;
  `, [driverId]);
  const t = totals.rows[0], td = todayRes.rows[0];
  return {
    totalEarnings: t.earnings, totalKm: Math.round(t.km*10)/10, totalTrips: t.trips,
    todayEarnings: td.earnings, todayTrips: td.trips,
    trips: list.rows.map(r => ({
      rideId: r.id, customer: r.customer_name, km: Math.round((r.est_km||0)*10)/10,
      fare: r.est_fare||0,
      from: r.type==='delivery' ? (r.store_name || r.store_label || '—') : (r.pickup_label||'—'),
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

// إجمالي اللي دفعه سائق معيّن
async function getDriverPaidTotal(driverId) {
  if (!HAS_DB) {
    return (mem.subs || []).filter(x=>x.driver_id===driverId).reduce((s,x)=>s+(x.amount||0), 0);
  }
  const res = await pool.query(
    `SELECT COALESCE(SUM(amount),0)::int AS total FROM subscriptions WHERE driver_id=$1`, [driverId]
  );
  return res.rows[0].total;
}

// ============ مكافآت الولاء ============
async function getRewardSettings() {
  if (!HAS_DB) {
    return mem.rewardSettings || (mem.rewardSettings = { trips_threshold: 10, reward_type: 'free_ride', reward_value: 0, enabled: true });
  }
  const res = await pool.query('SELECT * FROM reward_settings WHERE id=1');
  return res.rows[0];
}

async function setRewardSettings(threshold, type, value, enabled) {
  if (!HAS_DB) {
    mem.rewardSettings = { trips_threshold: threshold, reward_type: type, reward_value: value, enabled: !!enabled };
    return mem.rewardSettings;
  }
  const res = await pool.query(`
    UPDATE reward_settings SET trips_threshold=$1, reward_type=$2, reward_value=$3, enabled=$4 WHERE id=1 RETURNING *;
  `, [threshold, type, value, !!enabled]);
  return res.rows[0];
}

// المكافأة المتاحة حالياً للزبون (ما ارتبطت برحلة بعد)
async function getPendingReward(phone) {
  const clean = cleanPhone(phone);
  if (!HAS_DB) {
    const list = mem.rewards || [];
    return list.find(r => r.phone === clean && r.status === 'pending' && !r.ride_id) || null;
  }
  const res = await pool.query(
    `SELECT * FROM customer_rewards WHERE regexp_replace(phone, '\\D', '', 'g') = $1 AND status='pending' AND ride_id IS NULL ORDER BY created_at ASC LIMIT 1`,
    [clean]
  );
  return res.rows[0] || null;
}

// منح مكافأة يدوية من الأدمن
async function grantManualReward(phone, type, value) {
  const clean = cleanPhone(phone);
  if (!HAS_DB) {
    if (!mem.rewards) mem.rewards = [];
    const id = (mem.rewards.length ? Math.max(...mem.rewards.map(r => r.id)) : 0) + 1;
    const rec = { id, phone: clean, reward_type: type, reward_value: value, source: 'manual', status: 'pending', ride_id: null, created_at: new Date() };
    mem.rewards.push(rec);
    return rec;
  }
  const res = await pool.query(`
    INSERT INTO customer_rewards (phone, reward_type, reward_value, source) VALUES ($1,$2,$3,'manual') RETURNING *;
  `, [clean, type, value]);
  return res.rows[0];
}

// تتحقق بعد كل رحلة منجزة: هل الزبون وصل لأول مرة لعدد الرحلات المطلوب؟
async function maybeGrantAutoReward(phone) {
  const settings = await getRewardSettings();
  if (!settings.enabled) return null;
  const tripCount = await getCustomerTripCount(phone);
  if (tripCount < settings.trips_threshold) return null;

  const clean = cleanPhone(phone);
  if (!HAS_DB) {
    if (!mem.rewards) mem.rewards = [];
    const alreadyGranted = mem.rewards.some(r => r.phone === clean && r.source === 'auto');
    if (alreadyGranted) return null;
    const id = (mem.rewards.length ? Math.max(...mem.rewards.map(r => r.id)) : 0) + 1;
    const rec = { id, phone: clean, reward_type: settings.reward_type, reward_value: settings.reward_value, source: 'auto', status: 'pending', ride_id: null, created_at: new Date() };
    mem.rewards.push(rec);
    return rec;
  }
  const existing = await pool.query(
    `SELECT id FROM customer_rewards WHERE regexp_replace(phone, '\\D', '', 'g') = $1 AND source='auto' LIMIT 1`,
    [clean]
  );
  if (existing.rows.length) return null;
  const res = await pool.query(`
    INSERT INTO customer_rewards (phone, reward_type, reward_value, source) VALUES ($1,$2,$3,'auto') RETURNING *;
  `, [clean, settings.reward_type, settings.reward_value]);
  return res.rows[0];
}

// اربط المكافأة برحلة قيد التنفيذ (تمنع استخدامها مرتين لين الرحلة تخلص أو تنلغي)
async function reserveRewardForRide(rewardId, rideId) {
  if (!HAS_DB) {
    const r = (mem.rewards || []).find(x => x.id === rewardId);
    if (r) r.ride_id = rideId;
    return r;
  }
  await pool.query('UPDATE customer_rewards SET ride_id=$2 WHERE id=$1', [rewardId, rideId]);
}

// حرر المكافأة إذا الرحلة الملغاية كانت مرتبطة فيها
async function releaseRewardByRide(rideId) {
  if (!HAS_DB) {
    const r = (mem.rewards || []).find(x => x.ride_id === rideId && x.status === 'pending');
    if (r) r.ride_id = null;
    return;
  }
  await pool.query(`UPDATE customer_rewards SET ride_id=NULL WHERE ride_id=$1 AND status='pending'`, [rideId]);
}

// المكافأة صارت مستخدمة فعلاً (الرحلة خلصت) + سجل المبلغ المستحق للسائق
async function markRewardUsedByRide(rideId, driverId, driverPayout) {
  if (!HAS_DB) {
    const r = (mem.rewards || []).find(x => x.ride_id === rideId);
    if (r) { r.status = 'used'; r.driver_id = driverId; r.driver_payout = driverPayout; r.used_at = new Date(); }
    return r;
  }
  const res = await pool.query(`
    UPDATE customer_rewards SET status='used', driver_id=$2, driver_payout=$3, used_at=NOW()
    WHERE ride_id=$1 RETURNING *;
  `, [rideId, driverId, driverPayout]);
  return res.rows[0];
}

// عدد المكافآت التلقائية الجديدة (للتنبيه بلوحة التحكم)
async function getPendingAutoRewardsCount() {
  if (!HAS_DB) return (mem.rewards || []).filter(r => r.source === 'auto' && r.status === 'pending').length;
  const res = await pool.query(`SELECT COUNT(*)::int AS n FROM customer_rewards WHERE source='auto' AND status='pending'`);
  return res.rows[0].n;
}

// مستحقات السواق غير المدفوعة من المكافآت
async function getDriverPayouts() {
  if (!HAS_DB) {
    return (mem.rewards || []).filter(r => r.status === 'used' && !r.payout_settled).slice().reverse();
  }
  const res = await pool.query(`
    SELECT cr.*, d.name AS driver_name FROM customer_rewards cr
    LEFT JOIN drivers d ON d.id = cr.driver_id
    WHERE cr.status='used' AND cr.payout_settled=false
    ORDER BY cr.used_at DESC;
  `);
  return res.rows;
}

async function settleDriverPayout(rewardId) {
  if (!HAS_DB) {
    const r = (mem.rewards || []).find(x => x.id === rewardId);
    if (r) r.payout_settled = true;
    return r;
  }
  const res = await pool.query('UPDATE customer_rewards SET payout_settled=true WHERE id=$1 RETURNING *', [rewardId]);
  return res.rows[0];
}

// ============ تقييم الرحلات ============
async function rateRide(rideId, rating, note) {
  if (!HAS_DB) {
    const r = mem.rides.get(rideId);
    if (r) { r.rating = rating; r.ratingNote = note || null; }
    return r;
  }
  const res = await pool.query(
    `UPDATE rides SET rating=$2, rating_note=$3 WHERE id=$1 RETURNING *`,
    [rideId, rating, note || null]
  );
  return res.rows[0];
}

// متوسط تقييم السائق
async function getDriverRatingSummary(driverId) {
  if (!HAS_DB) {
    const rated = [...mem.rides.values()].filter(r => r.driverId === driverId && r.rating);
    const avg = rated.length ? rated.reduce((s, r) => s + r.rating, 0) / rated.length : null;
    return { avg: avg ? Math.round(avg * 10) / 10 : null, count: rated.length };
  }
  const res = await pool.query(
    `SELECT ROUND(AVG(rating)::numeric,1) AS avg, COUNT(rating)::int AS count FROM rides WHERE driver_id=$1 AND rating IS NOT NULL`,
    [driverId]
  );
  const r = res.rows[0];
  return { avg: r.avg ? parseFloat(r.avg) : null, count: r.count };
}

// ملاحظات وشكاوى الزبائن (لكل السواق، لمراجعة الأدمن)
async function getComplaints(limit = 50) {
  if (!HAS_DB) {
    return [...mem.rides.values()]
      .filter(r => r.ratingNote)
      .slice(-limit).reverse()
      .map(r => ({ rideId: r.id, driverId: r.driverId, driverName: null, customer: r.customer.name, rating: r.rating, note: r.ratingNote, at: r.done_at ? r.done_at.getTime() : Date.now() }));
  }
  const res = await pool.query(`
    SELECT rides.id AS ride_id, rides.driver_id, rides.customer_name, rides.rating, rides.rating_note, rides.done_at, drivers.name AS driver_name
    FROM rides LEFT JOIN drivers ON drivers.id = rides.driver_id
    WHERE rides.rating_note IS NOT NULL AND rides.rating_note != ''
    ORDER BY rides.done_at DESC LIMIT $1;
  `, [limit]);
  return res.rows;
}

// ============ إعدادات الأجرة ============
async function getFareSettings() {
  if (!HAS_DB) {
    return mem.fareSettings || (mem.fareSettings = { mode: 'per_km', base: 1000, per_km: 500, minimum: 1500, fixed_price: 2000 });
  }
  const res = await pool.query('SELECT * FROM fare_settings WHERE id=1');
  return res.rows[0];
}

async function setFareSettings({ mode, base, per_km, minimum, fixed_price }) {
  if (!HAS_DB) {
    mem.fareSettings = { mode, base, per_km, minimum, fixed_price };
    return mem.fareSettings;
  }
  const res = await pool.query(`
    UPDATE fare_settings SET mode=$1, base=$2, per_km=$3, minimum=$4, fixed_price=$5 WHERE id=1 RETURNING *;
  `, [mode, base, per_km, minimum, fixed_price]);
  return res.rows[0];
}

// ============ روابط التواصل ============
async function getContactSettings() {
  if (!HAS_DB) {
    return mem.contactSettings || (mem.contactSettings = { whatsapp: null, facebook: null, instagram: null, telegram: null });
  }
  const res = await pool.query('SELECT * FROM contact_settings WHERE id=1');
  return res.rows[0];
}

async function setContactSettings({ whatsapp, facebook, instagram, telegram }) {
  if (!HAS_DB) {
    mem.contactSettings = { whatsapp: whatsapp || null, facebook: facebook || null, instagram: instagram || null, telegram: telegram || null };
    return mem.contactSettings;
  }
  const res = await pool.query(`
    UPDATE contact_settings SET whatsapp=$1, facebook=$2, instagram=$3, telegram=$4 WHERE id=1 RETURNING *;
  `, [whatsapp || null, facebook || null, instagram || null, telegram || null]);
  return res.rows[0];
}

module.exports = {
  HAS_DB, init,
  upsertDriver, getDriver, getAllDrivers, getDriverByPhone, updateDriverLocation,
  getDriverAccess, setDriverSubscription, setDriverStatus, revokeDriverSubscription, deleteDriver,
  upsertCustomer, getAllCustomers, getCustomerByPhone, getCustomerTripCount, getCustomerTrips,
  addSavedPlace, getSavedPlaces, deleteSavedPlace,
  updateCustomerProfile, changeCustomerPhone,
  createRide, updateRideStatus, cancelRideWithReason, getAllRides, getDriverEarnings, getStats,
  setRideOffer, clearRideOffer, acceptRideOffer,
  getSubscriptionRevenue, getSubscriptions, getDriverPaidTotal,
  getRewardSettings, setRewardSettings, getPendingReward, grantManualReward,
  maybeGrantAutoReward, reserveRewardForRide, releaseRewardByRide,
  markRewardUsedByRide, getPendingAutoRewardsCount, getDriverPayouts, settleDriverPayout,
  rateRide, getDriverRatingSummary, getComplaints,
  getContactSettings, setContactSettings,
  getFareSettings, setFareSettings,
};

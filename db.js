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
    max: 20,
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
    // ترقية: حظر السائق من استخدام التطبيق
    await pool.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT false;`);
    await pool.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS ban_reason TEXT;`);
    // ترقية: موافقة الأدمن قبل ما السائق يدخل ويستلم طلبات
    await pool.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT false;`);
    // السواق القدماء اللي عندهم سجل تفعيل/تجربة من قبل هذا التحديث نعتبرهم موافق عليهم تلقائياً
    await pool.query(`UPDATE drivers SET approved=true WHERE approved=false AND (sub_ends_at IS NOT NULL OR trial_ends_at IS NOT NULL);`);
    // ترقية: اشتراك إشعارات المتصفح (Web Push) — يوصل الطلب للسائق حتى لو التطبيق مقفل بالخلفية
    await pool.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS push_subscription JSONB;`);
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
    // ترقية: حظر الزبون من استخدام التطبيق
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT false;`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS ban_reason TEXT;`);
    // ترقية: اشتراك إشعارات المتصفح (Web Push) — يبلغ الزبون بحالة رحلته حتى لو التطبيق مقفل بالخلفية
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS push_subscription JSONB;`);
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

    // سجل دفعات مستحقات المكافآت للسائق — كل عملية "دفعت" تسجّل هنا كدفعة وحدة (مو كل رحلة براسها)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS driver_payments (
        id          SERIAL PRIMARY KEY,
        driver_id   TEXT NOT NULL,
        amount      INTEGER NOT NULL,
        trips_count INTEGER NOT NULL DEFAULT 0,
        note        TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_driver_payments_driver ON driver_payments(driver_id);`);

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

    // ترقية: مين ألغى الرحلة — 'customer' أو 'driver_noshow' (السائق وصل والزبون ما حضر)
    // هاي تفرّق بين إلغاء الزبون العادي وإلغاء السائق بسبب عدم حضور الزبون، حتى ما يتحاسب السائق عليه
    await pool.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS cancelled_by TEXT;`);

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
    // أول تسجيل: ينتظر موافقة الأدمن — التجربة ما تبدأ إلا بعد الموافقة
    const created = existing.created_at || new Date();
    mem.drivers.set(d.id, { ...existing, ...d, created_at: created,
      trial_ends_at: existing.trial_ends_at || null, approved: existing.approved || false,
      status: existing.status || 'pending' });
    return mem.drivers.get(d.id);
  }
  const res = await pool.query(`
    INSERT INTO drivers (id, name, phone, car, photo_self, photo_car, photo_id_front, photo_id_back, last_lat, last_lng)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
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

// ============ إشعارات المتصفح (Web Push) — السواق ============
async function saveDriverPushSubscription(id, subscription) {
  if (!HAS_DB) { const d = mem.drivers.get(id); if (d) d.push_subscription = subscription; return; }
  await pool.query('UPDATE drivers SET push_subscription=$2 WHERE id=$1', [id, subscription]);
}
async function clearDriverPushSubscription(id) {
  if (!HAS_DB) { const d = mem.drivers.get(id); if (d) d.push_subscription = null; return; }
  await pool.query('UPDATE drivers SET push_subscription=NULL WHERE id=$1', [id]);
}
// كل السواق المسموحلهم يشتغلون وعندهم اشتراك إشعارات مسجّل — نرسلها بغض النظر عن حالة اتصال الـ WebSocket
async function getDriversForPush() {
  if (!HAS_DB) return [...mem.drivers.values()].filter(d => d.push_subscription && computeAccess(d).allowed);
  const res = await pool.query('SELECT * FROM drivers WHERE push_subscription IS NOT NULL');
  return res.rows.filter(d => computeAccess(d).allowed);
}

// حالة السواق: هل يقدر يشتغل؟ (دالة صافية — تحسب من صف السائق مباشرة، بدون استعلام إضافي)
// pending = ينتظر التفعيل | active = مفعّل باشتراك | trial = بفترة التجربة | expired = انتهى
function computeAccess(d) {
  if (!d) return { allowed: false, reason: 'not_found' };
  if (d.banned) return { allowed: false, reason: 'banned', banReason: d.ban_reason || null };
  if (!d.approved) return { allowed: false, reason: 'pending_review' };

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

async function getDriverAccess(id) {
  const d = await getDriver(id);
  return computeAccess(d);
}

// المالك يفعّل اشتراك ويسجّل المبلغ المقبوض
async function setDriverSubscription(id, days, amount = 0, note = '') {
  if (!HAS_DB) {
    const d = mem.drivers.get(id);
    if (d) { d.sub_ends_at = new Date(Date.now() + days*86400000); d.status = 'active'; d.approved = true; }
    if (!mem.subs) mem.subs = [];
    mem.subs.push({ id: mem.subs.length+1, driver_id:id, driver_name: d?.name, days, amount: amount||0, note, created_at: new Date() });
    return d;
  }
  const res = await pool.query(`
    UPDATE drivers SET sub_ends_at = NOW() + ($2 || ' days')::INTERVAL, status='active', approved=true
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
  if (!HAS_DB) {
    return (mem.subs || []).slice().reverse().slice(0, limit).map(s => {
      const d = mem.drivers.get(s.driver_id);
      return { ...s, driver_phone: d ? d.phone : null };
    });
  }
  const res = await pool.query(`
    SELECT subscriptions.*, drivers.phone AS driver_phone
    FROM subscriptions LEFT JOIN drivers ON drivers.id = subscriptions.driver_id
    ORDER BY subscriptions.created_at DESC LIMIT $1;
  `, [limit]);
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

// حظر/إلغاء حظر السائق من استخدام التطبيق
async function banDriver(id, reason) {
  if (!HAS_DB) {
    const d = mem.drivers.get(id);
    if (d) { d.banned = true; d.ban_reason = reason || null; }
    return d;
  }
  const res = await pool.query('UPDATE drivers SET banned=true, ban_reason=$2 WHERE id=$1 RETURNING *', [id, reason || null]);
  return res.rows[0] || null;
}

async function unbanDriver(id) {
  if (!HAS_DB) {
    const d = mem.drivers.get(id);
    if (d) { d.banned = false; d.ban_reason = null; }
    return d;
  }
  const res = await pool.query('UPDATE drivers SET banned=false, ban_reason=NULL WHERE id=$1 RETURNING *', [id]);
  return res.rows[0] || null;
}

// الأدمن يوافق على سائق جديد بعد مراجعة بياناته وصوره — تبدأ فترة التجربة من هذي اللحظة
async function approveDriver(id, trialDays = 1) {
  if (!HAS_DB) {
    const d = mem.drivers.get(id);
    if (d) { d.approved = true; d.trial_ends_at = new Date(Date.now() + trialDays*86400000); d.status = 'active'; }
    return d;
  }
  const res = await pool.query(`
    UPDATE drivers SET approved=true, trial_ends_at = NOW() + ($2 || ' days')::INTERVAL, status='active'
    WHERE id=$1 RETURNING *;
  `, [id, String(trialDays)]);
  return res.rows[0] || null;
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

// ============ إشعارات المتصفح (Web Push) — الزبون ============
async function saveCustomerPushSubscription(phone, subscription) {
  const clean = cleanPhone(phone);
  if (!clean) return;
  if (!HAS_DB) { const c = mem.customers.get(clean); if (c) c.push_subscription = subscription; return; }
  await pool.query('UPDATE customers SET push_subscription=$2 WHERE phone=$1', [clean, subscription]);
}
async function clearCustomerPushSubscription(phone) {
  const clean = cleanPhone(phone);
  if (!clean) return;
  if (!HAS_DB) { const c = mem.customers.get(clean); if (c) c.push_subscription = null; return; }
  await pool.query('UPDATE customers SET push_subscription=NULL WHERE phone=$1', [clean]);
}
async function getCustomerPushSubscription(phone) {
  const clean = cleanPhone(phone);
  if (!clean) return null;
  if (!HAS_DB) return mem.customers.get(clean)?.push_subscription || null;
  const res = await pool.query('SELECT push_subscription FROM customers WHERE phone=$1', [clean]);
  return res.rows[0]?.push_subscription || null;
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

// حظر/إلغاء حظر الزبون من استخدام التطبيق
async function banCustomer(phone, reason) {
  const clean = cleanPhone(phone);
  if (!HAS_DB) {
    const rec = mem.customers.get(clean);
    if (rec) { rec.banned = true; rec.ban_reason = reason || null; }
    return rec;
  }
  const res = await pool.query('UPDATE customers SET banned=true, ban_reason=$2 WHERE phone=$1 RETURNING *', [clean, reason || null]);
  return res.rows[0] || null;
}

async function unbanCustomer(phone) {
  const clean = cleanPhone(phone);
  if (!HAS_DB) {
    const rec = mem.customers.get(clean);
    if (rec) { rec.banned = false; rec.ban_reason = null; }
    return rec;
  }
  const res = await pool.query('UPDATE customers SET banned=false, ban_reason=NULL WHERE phone=$1 RETURNING *', [clean]);
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
      .map(t => {
        const d = t.driverId ? mem.drivers.get(t.driverId) : null;
        return {
          rideId: t.id, type: t.type,
          from: t.type === 'delivery' ? (t.storeName || t.store?.label || '—') : (t.pickup.label || '—'),
          to: t.destination?.label || '—',
          fare: t.estFare || 0, km: Math.round((t.estKm || 0) * 10) / 10,
          at: t.done_at ? t.done_at.getTime() : Date.now(),
          driverName: d ? d.name : null,
          pickup: t.pickup ? { lat: t.pickup.lat, lng: t.pickup.lng } : null,
          destination: t.destination ? { lat: t.destination.lat, lng: t.destination.lng } : null,
          store: t.store ? { lat: t.store.lat, lng: t.store.lng } : null,
        };
      });
  }
  const res = await pool.query(`
    SELECT rides.id, rides.type, rides.pickup_label, rides.dest_label, rides.store_label, rides.store_name,
           rides.est_km, rides.est_fare, rides.done_at,
           rides.pickup_lat, rides.pickup_lng, rides.dest_lat, rides.dest_lng, rides.store_lat, rides.store_lng,
           drivers.name AS driver_name
    FROM rides LEFT JOIN drivers ON drivers.id = rides.driver_id
    WHERE regexp_replace(rides.customer_phone, '\\D', '', 'g') = $1 AND rides.status='done'
    ORDER BY rides.done_at DESC LIMIT $2;
  `, [clean, limit]);
  return res.rows.map(r => ({
    rideId: r.id, type: r.type,
    from: r.type === 'delivery' ? (r.store_name || r.store_label || '—') : (r.pickup_label || '—'),
    to: r.dest_label || '—',
    fare: r.est_fare || 0, km: Math.round((r.est_km || 0) * 10) / 10,
    at: r.done_at ? new Date(r.done_at).getTime() : Date.now(),
    driverName: r.driver_name || null,
    pickup: r.pickup_lat != null ? { lat: r.pickup_lat, lng: r.pickup_lng } : null,
    destination: r.dest_lat != null ? { lat: r.dest_lat, lng: r.dest_lng } : null,
    store: r.store_lat != null ? { lat: r.store_lat, lng: r.store_lng } : null,
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
async function cancelRideWithReason(id, reason, cancelledBy = 'customer') {
  if (!HAS_DB) {
    const r = mem.rides.get(id);
    if (r) { r.status = 'cancelled'; r.cancelReason = reason || null; r.cancelledBy = cancelledBy; }
    return;
  }
  await pool.query('UPDATE rides SET status=$2, cancel_reason=$3, cancelled_by=$4 WHERE id=$1', [id, 'cancelled', reason || null, cancelledBy]);
}

async function getAllRides(limit = 100) {
  if (!HAS_DB) return [...mem.rides.values()].reverse().slice(0, limit);
  const res = await pool.query('SELECT * FROM rides ORDER BY created_at DESC LIMIT $1', [limit]);
  return res.rows;
}

// الرحلات النشطة (لسا ما خلصت ولا انلغت) — نستخدمها نرجّعها لذاكرة السيرفر بعد أي إعادة تشغيل
// (Railway يعيد تشغيل السيرفر مع كل نشر تحديث، وبدون هذا أي رحلة بنص الطريق تضيع من السواق والزبون)
async function getInProgressRides() {
  if (!HAS_DB) return [];
  const res = await pool.query(
    `SELECT * FROM rides WHERE status IN ('searching','offered','accepted','arrived','started') ORDER BY created_at ASC`
  );
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
      trips: trips.slice(-20).reverse().map(t => {
        const reward = t.rewardId ? (mem.rewards || []).find(r => r.id === t.rewardId) : null;
        return {
          rideId: t.id, customer: t.customer.name, km: Math.round((t.estKm||0)*10)/10,
          fare: t.estFare||0, from: t.pickup.label||'—', to: t.destination?.label||'—',
          at: t.done_at ? t.done_at.getTime() : Date.now(), type: t.type,
          rewardPayout: reward ? reward.driver_payout : null, rewardSettled: reward ? !!reward.payout_settled : false,
        };
      }),
    };
  }
  const [totals, todayRes, list] = await Promise.all([
    pool.query(`
      SELECT COUNT(*)::int AS trips, COALESCE(SUM(est_fare),0)::int AS earnings,
             COALESCE(SUM(est_km),0) AS km
      FROM rides WHERE driver_id=$1 AND status='done';
    `, [driverId]),
    pool.query(`
      SELECT COUNT(*)::int AS trips, COALESCE(SUM(est_fare),0)::int AS earnings
      FROM rides WHERE driver_id=$1 AND status='done' AND done_at >= CURRENT_DATE;
    `, [driverId]),
    pool.query(`
      SELECT r.id, r.type, r.customer_name, r.est_km, r.est_fare, r.pickup_label, r.dest_label,
             r.store_label, r.store_name, r.done_at, cr.driver_payout, cr.payout_settled
      FROM rides r
      LEFT JOIN customer_rewards cr ON cr.ride_id = r.id AND cr.status = 'used'
      WHERE r.driver_id=$1 AND r.status='done' ORDER BY r.done_at DESC LIMIT 20;
    `, [driverId]),
  ]);
  const t = totals.rows[0], td = todayRes.rows[0];
  return {
    totalEarnings: t.earnings, totalKm: Math.round(t.km*10)/10, totalTrips: t.trips,
    todayEarnings: td.earnings, todayTrips: td.trips,
    trips: list.rows.map(r => ({
      rideId: r.id, customer: r.customer_name, km: Math.round((r.est_km||0)*10)/10,
      fare: r.est_fare||0,
      from: r.type==='delivery' ? (r.store_name || r.store_label || '—') : (r.pickup_label||'—'),
      to: r.dest_label||'—', at: r.done_at ? new Date(r.done_at).getTime() : Date.now(), type: r.type,
      rewardPayout: r.driver_payout != null ? r.driver_payout : null, rewardSettled: !!r.payout_settled,
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

// كل رحلات سائق معيّن (أي حالة) — لملف السائق التفصيلي بلوحة التحكم
async function getDriverRides(driverId, limit = 100) {
  if (!HAS_DB) return [...mem.rides.values()].filter(r => r.driverId === driverId).slice(-limit).reverse();
  const res = await pool.query(
    `SELECT * FROM rides WHERE driver_id=$1 ORDER BY created_at DESC LIMIT $2`, [driverId, limit]
  );
  return res.rows;
}

// شكد مرة زبون ألغى طلب بعد ما هذا السائق وافق عليه (مؤشر مسؤولية)
// عدد الرحلات اللي ألغاها الزبون بعد ما وافق السائق — ما نحسب فيها إلغاء السائق بسبب عدم حضور الزبون (مو ذنب السائق)
async function getDriverCancelledOnCount(driverId) {
  if (!HAS_DB) return [...mem.rides.values()].filter(r => r.driverId === driverId && r.status === 'cancelled' && r.cancelledBy !== 'driver_noshow').length;
  const res = await pool.query(
    `SELECT COUNT(*)::int AS n FROM rides WHERE driver_id=$1 AND status='cancelled' AND (cancelled_by IS DISTINCT FROM 'driver_noshow')`, [driverId]
  );
  return res.rows[0].n;
}

// كل طلبات زبون معيّن (أي حالة) — لملف الزبون التفصيلي بلوحة التحكم
async function getCustomerRides(phone, limit = 100) {
  const clean = cleanPhone(phone);
  if (!HAS_DB) {
    return [...mem.rides.values()].filter(r => cleanPhone(r.customer?.phone) === clean).slice(-limit).reverse();
  }
  const res = await pool.query(
    `SELECT * FROM rides WHERE regexp_replace(customer_phone, '\\D', '', 'g') = $1 ORDER BY created_at DESC LIMIT $2`,
    [clean, limit]
  );
  return res.rows;
}

// شكد مرة الزبون ألغى طلب (على أي سائق)
async function getCustomerCancelCount(phone) {
  const clean = cleanPhone(phone);
  if (!HAS_DB) {
    return [...mem.rides.values()].filter(r => cleanPhone(r.customer?.phone) === clean && r.status === 'cancelled').length;
  }
  const res = await pool.query(
    `SELECT COUNT(*)::int AS n FROM rides WHERE regexp_replace(customer_phone, '\\D', '', 'g') = $1 AND status='cancelled'`,
    [clean]
  );
  return res.rows[0].n;
}

// عدد مرات "الزبون ما حضر" تحديداً — السائق وصل وألغى الرحلة لأن الزبون ما جاوب/ما نزل
// نستخدمها بلوحة التحكم حتى نميّز الزبون المتكرر بهذا السلوك عن زبون بس غيّر رأيه
async function getCustomerNoShowCount(phone) {
  const clean = cleanPhone(phone);
  if (!HAS_DB) {
    return [...mem.rides.values()].filter(r => cleanPhone(r.customer?.phone) === clean && r.status === 'cancelled' && r.cancelledBy === 'driver_noshow').length;
  }
  const res = await pool.query(
    `SELECT COUNT(*)::int AS n FROM rides WHERE regexp_replace(customer_phone, '\\D', '', 'g') = $1 AND status='cancelled' AND cancelled_by='driver_noshow'`,
    [clean]
  );
  return res.rows[0].n;
}

// إجمالي المدفوع لكل السواق دفعة وحدة (بدل استعلام منفصل لكل سائق — لقائمة لوحة التحكم)
async function getDriverPaidTotalsBulk() {
  if (!HAS_DB) {
    const map = {};
    (mem.subs || []).forEach(s => { map[s.driver_id] = (map[s.driver_id] || 0) + (s.amount || 0); });
    return map;
  }
  const res = await pool.query(`SELECT driver_id, COALESCE(SUM(amount),0)::int AS total FROM subscriptions GROUP BY driver_id`);
  const map = {};
  res.rows.forEach(r => { map[r.driver_id] = r.total; });
  return map;
}

// تقييم كل السواق دفعة وحدة
async function getDriverRatingSummariesBulk() {
  if (!HAS_DB) {
    const map = {};
    for (const r of mem.rides.values()) {
      if (!r.driverId || !r.rating) continue;
      if (!map[r.driverId]) map[r.driverId] = [];
      map[r.driverId].push(r.rating);
    }
    const out = {};
    for (const [id, ratings] of Object.entries(map)) {
      out[id] = { avg: Math.round((ratings.reduce((s,x)=>s+x,0) / ratings.length) * 10) / 10, count: ratings.length };
    }
    return out;
  }
  const res = await pool.query(`
    SELECT driver_id, ROUND(AVG(rating)::numeric,1) AS avg, COUNT(rating)::int AS count
    FROM rides WHERE driver_id IS NOT NULL AND rating IS NOT NULL GROUP BY driver_id
  `);
  const map = {};
  res.rows.forEach(r => { map[r.driver_id] = { avg: r.avg ? parseFloat(r.avg) : null, count: r.count }; });
  return map;
}

// عدد رحلات كل زبون المنجزة دفعة وحدة
async function getCustomerTripCountsBulk() {
  if (!HAS_DB) {
    const map = {};
    for (const r of mem.rides.values()) {
      if (r.status !== 'done') continue;
      const p = cleanPhone(r.customer?.phone);
      map[p] = (map[p] || 0) + 1;
    }
    return map;
  }
  const res = await pool.query(`
    SELECT regexp_replace(customer_phone, '\\D', '', 'g') AS phone, COUNT(*)::int AS n
    FROM rides WHERE status='done' GROUP BY 1
  `);
  const map = {};
  res.rows.forEach(r => { map[r.phone] = r.n; });
  return map;
}

// المكافأة المتاحة لكل الزبائن دفعة وحدة
async function getPendingRewardsBulk() {
  if (!HAS_DB) {
    const map = {};
    (mem.rewards || []).filter(r => r.status === 'pending' && !r.ride_id).forEach(r => { map[r.phone] = r; });
    return map;
  }
  const res = await pool.query(`
    SELECT DISTINCT ON (phone) * FROM customer_rewards
    WHERE status='pending' AND ride_id IS NULL
    ORDER BY phone, created_at ASC
  `);
  const map = {};
  res.rows.forEach(r => { map[cleanPhone(r.phone)] = r; });
  return map;
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
    return (mem.rewards || []).filter(r => r.status === 'used' && !r.payout_settled).slice().reverse().map(r => {
      const d = mem.drivers.get(r.driver_id);
      return { ...r, driver_phone: d ? d.phone : null };
    });
  }
  const res = await pool.query(`
    SELECT cr.*, d.name AS driver_name, d.phone AS driver_phone FROM customer_rewards cr
    LEFT JOIN drivers d ON d.id = cr.driver_id
    WHERE cr.status='used' AND cr.payout_settled=false
    ORDER BY cr.used_at DESC;
  `);
  return res.rows;
}

// كشف مستحقات المكافآت — ملخص لكل سائق (أو سائق وحد محدد) بفترة زمنية، حتى ما تصير هوسة لما يصير هواي سواق
async function getRewardStatement({ from, to, driverId } = {}) {
  const fromDate = from ? new Date(from) : new Date(0);
  const toDate = to ? new Date(new Date(to).getTime() + 86400000) : new Date(); // نضيف يوم حتى "إلى" يشمل يومها كامل

  if (!HAS_DB) {
    const rewards = (mem.rewards || []).filter(r =>
      r.status === 'used' && r.used_at >= fromDate && r.used_at < toDate &&
      (!driverId || r.driver_id === driverId)
    );
    const byDriver = new Map();
    for (const r of rewards) {
      const key = r.driver_id;
      const d = mem.drivers.get(key);
      if (!byDriver.has(key)) byDriver.set(key, { driverId: key, driverName: d ? d.name : 'سائق محذوف', tripsCount: 0, totalDue: 0, totalPaid: 0, totalUnpaid: 0 });
      const row = byDriver.get(key);
      row.tripsCount++; row.totalDue += r.driver_payout || 0;
      if (r.payout_settled) row.totalPaid += r.driver_payout || 0; else row.totalUnpaid += r.driver_payout || 0;
    }
    const rows = [...byDriver.values()].sort((a,b) => b.totalUnpaid - a.totalUnpaid);
    let trips = null;
    if (driverId) {
      trips = rewards.map(r => {
        const ride = mem.rides.get(r.ride_id);
        return {
          rewardId: r.id, rideId: r.ride_id, at: r.used_at.getTime(), payout: r.driver_payout || 0, settled: !!r.payout_settled,
          customer: ride?.customer?.name || '—',
          from: ride ? (ride.type==='delivery' ? (ride.storeName||ride.store?.label||'—') : (ride.pickup?.label||'—')) : '—',
          to: ride ? (ride.destination?.label || '—') : '—', type: ride?.type || 'ride',
        };
      }).sort((a,b) => b.at - a.at);
    }
    return { rows, trips };
  }

  const params = [fromDate, toDate];
  let driverClause = '';
  if (driverId) { params.push(driverId); driverClause = `AND cr.driver_id = $${params.length}`; }

  const summaryRes = await pool.query(`
    SELECT d.id AS driver_id, d.name AS driver_name,
           COUNT(cr.id)::int AS trips_count,
           COALESCE(SUM(cr.driver_payout),0)::int AS total_due,
           COALESCE(SUM(cr.driver_payout) FILTER (WHERE cr.payout_settled), 0)::int AS total_paid,
           COALESCE(SUM(cr.driver_payout) FILTER (WHERE NOT cr.payout_settled), 0)::int AS total_unpaid
    FROM customer_rewards cr
    JOIN drivers d ON d.id = cr.driver_id
    WHERE cr.status = 'used' AND cr.used_at >= $1 AND cr.used_at < $2 ${driverClause}
    GROUP BY d.id, d.name
    ORDER BY total_unpaid DESC, d.name;
  `, params);

  const rows = summaryRes.rows.map(r => ({
    driverId: r.driver_id, driverName: r.driver_name, tripsCount: r.trips_count,
    totalDue: r.total_due, totalPaid: r.total_paid, totalUnpaid: r.total_unpaid,
  }));

  let trips = null;
  if (driverId) {
    const tripsRes = await pool.query(`
      SELECT cr.id AS reward_id, cr.ride_id, cr.driver_payout, cr.payout_settled, cr.used_at,
             r.customer_name, r.pickup_label, r.dest_label, r.store_label, r.store_name, r.type
      FROM customer_rewards cr
      LEFT JOIN rides r ON r.id = cr.ride_id
      WHERE cr.status = 'used' AND cr.driver_id = $1 AND cr.used_at >= $2 AND cr.used_at < $3
      ORDER BY cr.used_at DESC;
    `, [driverId, fromDate, toDate]);
    trips = tripsRes.rows.map(r => ({
      rewardId: r.reward_id, rideId: r.ride_id, at: r.used_at ? new Date(r.used_at).getTime() : null,
      payout: r.driver_payout || 0, settled: !!r.payout_settled, customer: r.customer_name || '—',
      from: r.type === 'delivery' ? (r.store_name || r.store_label || '—') : (r.pickup_label || '—'),
      to: r.dest_label || '—', type: r.type,
    }));
  }
  return { rows, trips };
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

// يدفع للسائق كل المستحقات المعلّقة دفعة وحدة (بدل تسوية كل رحلة براسها) ويسجّلها كعملية دفع وحدة بالسجل
async function payDriverRewardsInFull(driverId, note) {
  if (!HAS_DB) {
    const unpaid = (mem.rewards || []).filter(r => r.driver_id === driverId && r.status === 'used' && !r.payout_settled);
    if (!unpaid.length) return null;
    const total = unpaid.reduce((s, r) => s + (r.driver_payout || 0), 0);
    unpaid.forEach(r => { r.payout_settled = true; });
    if (!mem.driverPayments) mem.driverPayments = [];
    const payment = { id: mem.driverPayments.length + 1, driver_id: driverId, amount: total, trips_count: unpaid.length, note: note || null, created_at: new Date() };
    mem.driverPayments.push(payment);
    return payment;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const unpaidRes = await client.query(
      `SELECT id, driver_payout FROM customer_rewards WHERE driver_id=$1 AND status='used' AND payout_settled=false`, [driverId]
    );
    if (!unpaidRes.rows.length) { await client.query('ROLLBACK'); return null; }
    const total = unpaidRes.rows.reduce((s, r) => s + (r.driver_payout || 0), 0);
    await client.query(`UPDATE customer_rewards SET payout_settled=true WHERE driver_id=$1 AND status='used' AND payout_settled=false`, [driverId]);
    const insertRes = await client.query(
      `INSERT INTO driver_payments (driver_id, amount, trips_count, note) VALUES ($1,$2,$3,$4) RETURNING *`,
      [driverId, total, unpaidRes.rows.length, note || null]
    );
    await client.query('COMMIT');
    return insertRes.rows[0];
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

// كشف حساب كامل لسائق وحد: تفعيلاته، رحلاته المجانية، ومدفوعاته — بفترة زمنية محددة
async function getDriverFullStatement({ driverId, from, to }) {
  const fromDate = from ? new Date(from) : new Date(0);
  const toDate = to ? new Date(new Date(to).getTime() + 86400000) : new Date();
  const driver = await getDriver(driverId);

  if (!HAS_DB) {
    const activations = (mem.subs || []).filter(s => s.driver_id === driverId && new Date(s.created_at) >= fromDate && new Date(s.created_at) < toDate).slice().reverse();
    const rewards = (mem.rewards || []).filter(r => r.driver_id === driverId && r.status === 'used' && r.used_at >= fromDate && r.used_at < toDate);
    const trips = rewards.map(r => {
      const ride = mem.rides.get(r.ride_id);
      return {
        rewardId: r.id, rideId: r.ride_id, at: r.used_at.getTime(), payout: r.driver_payout || 0, settled: !!r.payout_settled,
        customer: ride?.customer?.name || '—',
        from: ride ? (ride.type === 'delivery' ? (ride.storeName || ride.store?.label || '—') : (ride.pickup?.label || '—')) : '—',
        to: ride ? (ride.destination?.label || '—') : '—', type: ride?.type || 'ride',
      };
    }).sort((a, b) => b.at - a.at);
    const payments = (mem.driverPayments || []).filter(p => p.driver_id === driverId && p.created_at >= fromDate && p.created_at < toDate).slice().reverse();
    return {
      driver, activations, activationsCount: activations.length,
      activationsTotal: activations.reduce((s, a) => s + (a.amount || 0), 0),
      tripsCount: trips.length, totalDue: trips.reduce((s, t) => s + t.payout, 0),
      totalPaid: trips.filter(t => t.settled).reduce((s, t) => s + t.payout, 0),
      totalUnpaid: trips.filter(t => !t.settled).reduce((s, t) => s + t.payout, 0),
      trips, payments: payments.map(p => ({ ...p, at: p.created_at.getTime() })),
    };
  }

  const [activationsRes, tripsRes, paymentsRes] = await Promise.all([
    pool.query(`SELECT * FROM subscriptions WHERE driver_id=$1 AND created_at>=$2 AND created_at<$3 ORDER BY created_at DESC`, [driverId, fromDate, toDate]),
    pool.query(`
      SELECT cr.id AS reward_id, cr.ride_id, cr.driver_payout, cr.payout_settled, cr.used_at,
             r.customer_name, r.pickup_label, r.dest_label, r.store_label, r.store_name, r.type
      FROM customer_rewards cr LEFT JOIN rides r ON r.id = cr.ride_id
      WHERE cr.driver_id=$1 AND cr.status='used' AND cr.used_at>=$2 AND cr.used_at<$3
      ORDER BY cr.used_at DESC;
    `, [driverId, fromDate, toDate]),
    pool.query(`SELECT * FROM driver_payments WHERE driver_id=$1 AND created_at>=$2 AND created_at<$3 ORDER BY created_at DESC`, [driverId, fromDate, toDate]),
  ]);

  const trips = tripsRes.rows.map(r => ({
    rewardId: r.reward_id, rideId: r.ride_id, at: r.used_at ? new Date(r.used_at).getTime() : null,
    payout: r.driver_payout || 0, settled: !!r.payout_settled, customer: r.customer_name || '—',
    from: r.type === 'delivery' ? (r.store_name || r.store_label || '—') : (r.pickup_label || '—'),
    to: r.dest_label || '—', type: r.type,
  }));

  return {
    driver, activations: activationsRes.rows, activationsCount: activationsRes.rows.length,
    activationsTotal: activationsRes.rows.reduce((s, a) => s + (a.amount || 0), 0),
    tripsCount: trips.length, totalDue: trips.reduce((s, t) => s + t.payout, 0),
    totalPaid: trips.filter(t => t.settled).reduce((s, t) => s + t.payout, 0),
    totalUnpaid: trips.filter(t => !t.settled).reduce((s, t) => s + t.payout, 0),
    trips,
    payments: paymentsRes.rows.map(p => ({ ...p, at: p.created_at ? new Date(p.created_at).getTime() : null })),
  };
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
async function getComplaints(limit = 50, driverId = null) {
  if (!HAS_DB) {
    let list = [...mem.rides.values()].filter(r => r.ratingNote);
    if (driverId) list = list.filter(r => r.driverId === driverId);
    return list.slice(-limit).reverse().map(r => ({
      ride_id: r.id, driver_id: r.driverId, driver_name: null, customer_name: r.customer.name, customer_phone: r.customer.phone || null,
      rating: r.rating, rating_note: r.ratingNote, done_at: r.done_at || new Date(),
      type: r.type, pickup_label: r.pickup?.label || null, dest_label: r.destination?.label || null,
      store_label: r.store?.label || null, store_name: r.storeName || null, est_fare: r.estFare || 0,
    }));
  }
  const params = [limit];
  let where = `rides.rating_note IS NOT NULL AND rides.rating_note != ''`;
  if (driverId) { params.push(driverId); where += ` AND rides.driver_id = $${params.length}`; }
  const res = await pool.query(`
    SELECT rides.id AS ride_id, rides.driver_id, rides.customer_name, rides.customer_phone, rides.rating, rides.rating_note, rides.done_at,
           rides.type, rides.pickup_label, rides.dest_label, rides.store_label, rides.store_name, rides.est_fare,
           drivers.name AS driver_name
    FROM rides LEFT JOIN drivers ON drivers.id = rides.driver_id
    WHERE ${where}
    ORDER BY rides.done_at DESC LIMIT $1;
  `, params);
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
  banDriver, unbanDriver, approveDriver,
  upsertCustomer, getAllCustomers, getCustomerByPhone, getCustomerTripCount, getCustomerTrips,
  addSavedPlace, getSavedPlaces, deleteSavedPlace,
  updateCustomerProfile, changeCustomerPhone, getCustomerRides, getCustomerCancelCount, getCustomerNoShowCount,
  banCustomer, unbanCustomer,
  createRide, updateRideStatus, cancelRideWithReason, getAllRides, getInProgressRides, getDriverEarnings, getStats,
  setRideOffer, clearRideOffer, acceptRideOffer,
  getSubscriptionRevenue, getSubscriptions, getDriverPaidTotal, getDriverRides, getDriverCancelledOnCount,
  computeAccess, getDriverPaidTotalsBulk, getDriverRatingSummariesBulk, getCustomerTripCountsBulk, getPendingRewardsBulk,
  getRewardSettings, setRewardSettings, getPendingReward, grantManualReward,
  maybeGrantAutoReward, reserveRewardForRide, releaseRewardByRide,
  markRewardUsedByRide, getPendingAutoRewardsCount, getDriverPayouts, settleDriverPayout, getRewardStatement,
  payDriverRewardsInFull, getDriverFullStatement,
  rateRide, getDriverRatingSummary, getComplaints,
  getContactSettings, setContactSettings,
  getFareSettings, setFareSettings,
  saveDriverPushSubscription, clearDriverPushSubscription, getDriversForPush,
  saveCustomerPushSubscription, clearCustomerPushSubscription, getCustomerPushSubscription,
};

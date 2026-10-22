/* ═══════════════════════════════════════════════════════════════
   يسوي أيقونة الآيفون من شعار جايك

   أبل تطلب أيقونة ١٠٢٤×١٠٢٤ بلا شفافية، وشعارنا ١٠٨٠×١٠٨٠ وبيه
   شفافية. فنصغّره ونحط خلفية بلون العلامة بداله.

   مكتوب بلا مكتبات صور — نقرأ الـPNG ونكتبه بأنفسنا، حتى يشتغل
   على أي جهاز بلا تنصيب شي.

   التشغيل:  node make-icon.js
   ═══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const SRC = path.join(__dirname, '..', 'logo.png');
const OUT = path.join(__dirname, 'ios', 'App', 'App', 'Assets.xcassets',
  'AppIcon.appiconset', 'AppIcon-512@2x.png');
const SIZE = 1024;
const BG = [0xFF, 0xC8, 0x00];   // أصفر جايك — يملا مكان الشفافية

/* ---------- قراءة PNG ---------- */
function readPNG(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504E47) throw new Error('مو ملف PNG');

  let width, height, depth, colorType, idat = [], palette = null, trns = null;
  let pos = 8;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('الصورة متشابكة (interlaced) — مو مدعومة');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error('عمق الألوان ' + depth + ' — مو مدعوم، لازم ٨');

  const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const ch = CHANNELS[colorType];
  if (!ch) throw new Error('نوع ألوان غير معروف: ' + colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = Buffer.alloc(height * stride);

  // فكّ الفلاتر: كل سطر بالـPNG محفوظ كفرق عن اللي قبله
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
  }

  // نحوّل كل الأنواع لـRGBA حتى يصير التعامل واحد
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    let r, g, b, a = 255;
    if (colorType === 0) { r = g = b = out[i]; }
    else if (colorType === 2) { r = out[i * 3]; g = out[i * 3 + 1]; b = out[i * 3 + 2]; }
    else if (colorType === 3) {
      const idx = out[i];
      r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
      if (trns && idx < trns.length) a = trns[idx];
    }
    else if (colorType === 4) { r = g = b = out[i * 2]; a = out[i * 2 + 1]; }
    else { r = out[i * 4]; g = out[i * 4 + 1]; b = out[i * 4 + 2]; a = out[i * 4 + 3]; }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { width, height, rgba };
}

/* ---------- تصغير + إزالة الشفافية ---------- */
function resizeFlatten(src, size) {
  const out = Buffer.alloc(size * size * 3);
  const sx = src.width / size, sy = src.height / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // متوسط المربع المقابل بالصورة الأصلية — أنعم من أخذ بكسل واحد
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < src.height; yy++) {
        for (let xx = x0; xx < x1 && xx < src.width; xx++) {
          const i = (yy * src.width + xx) * 4;
          const al = src.rgba[i + 3] / 255;
          r += src.rgba[i] * al; g += src.rgba[i + 1] * al; b += src.rgba[i + 2] * al;
          a += al; n++;
        }
      }
      r /= n; g /= n; b /= n; a /= n;
      // ندمج فوق خلفية صلبة — ما يبقى أي شفافية
      const o = (y * size + x) * 3;
      out[o]     = Math.round(r + BG[0] * (1 - a));
      out[o + 1] = Math.round(g + BG[1] * (1 - a));
      out[o + 2] = Math.round(b + BG[2] * (1 - a));
    }
  }
  return out;
}

/* ---------- كتابة PNG بلا قناة شفافية ---------- */
function writePNG(rgb, size, file) {
  const stride = size * 3;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;   // فلتر "بلا" — أبسط وأوضح
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, data) => {
    const b = Buffer.alloc(8 + data.length + 4);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, 'ascii');
    data.copy(b, 8);
    b.writeUInt32BE(zlib.crc32
      ? zlib.crc32(Buffer.concat([Buffer.from(type, 'ascii'), data]))
      : crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;  // 2 = RGB بلا شفافية
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

// جدول CRC — للنسخ القديمة من Node اللي ماكو بيها zlib.crc32
let TABLE = null;
function crc32(buf) {
  if (!TABLE) {
    TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const src = readPNG(SRC);
console.log('الشعار:', src.width + '×' + src.height);
writePNG(resizeFlatten(src, SIZE), SIZE, OUT);
const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log('الأيقونة:', SIZE + '×' + SIZE, 'بلا شفافية —', kb + ' كيلوبايت');
console.log('انحفظت بـ:', path.relative(__dirname, OUT));

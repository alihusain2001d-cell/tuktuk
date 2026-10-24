/* ═══════════════════════════════════════════════════════════════
   يصغّر صور الشاشة لمقاس يقبله App Store

   آيفون Pro Max يصوّر ١٢٩٠×٢٧٩٦، وتبويب "medium display" بالكونسول
   يطلب ١١٧٩×٢٥٥٦. نسبة الأبعاد بين المقاسين متطابقة تقريباً (فرق
   ٠.٠١٪)، فالتصغير نظيف بلا قص ولا تشويه.

   مكتوب بلا مكتبات صور — نقرأ الـPNG ونكتبه بأنفسنا، حتى يشتغل
   على أي جهاز بلا تنصيب شي.

   التشغيل:   node resize-screens.js "مسار المجلد"
   الناتج:    مجلد "جاهزة-للرفع" جنب الصور الأصلية
   ═══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const OUT_W = 1179, OUT_H = 2556;

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
      if (data[12] !== 0) throw new Error('صورة متشابكة — مو مدعومة');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error('عمق ألوان ' + depth + ' — لازم ٨');

  const CH = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!CH) throw new Error('نوع ألوان غير معروف: ' + colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * CH;
  const out = Buffer.alloc(height * stride);

  // فكّ الفلاتر: كل سطر محفوظ كفرق عن اللي قبله
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= CH ? cur[i - CH] : 0;
      const b = prev[i];
      const c = i >= CH ? prev[i - CH] : 0;
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

  // نوحّدها RGB — صور الشاشة ما بيها شفافية، ولو بيها ندمجها على أبيض
  const rgb = Buffer.alloc(width * height * 3);
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
    const al = a / 255;
    rgb[i * 3]     = Math.round(r * al + 255 * (1 - al));
    rgb[i * 3 + 1] = Math.round(g * al + 255 * (1 - al));
    rgb[i * 3 + 2] = Math.round(b * al + 255 * (1 - al));
  }
  return { width, height, rgb };
}

/* ---------- تصغير بمتوسط المساحة ---------- */
function resize(src, W, H) {
  const out = Buffer.alloc(W * H * 3);
  const sx = src.width / W, sy = src.height / H;
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < src.height; yy++) {
        for (let xx = x0; xx < x1 && xx < src.width; xx++) {
          const i = (yy * src.width + xx) * 3;
          r += src.rgb[i]; g += src.rgb[i + 1]; b += src.rgb[i + 2]; n++;
        }
      }
      const o = (y * W + x) * 3;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n);
    }
  }
  return out;
}

/* ---------- كتابة PNG ---------- */
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

function writePNG(rgb, W, H, file) {
  const stride = W * 3;
  const raw = Buffer.alloc(H * (stride + 1));
  for (let y = 0; y < H; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, data) => {
    const b = Buffer.alloc(8 + data.length + 4);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, 'ascii');
    data.copy(b, 8);
    b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2;   // ٨ بت، RGB بلا شفافية
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

/* ---------- التشغيل ---------- */
const dir = process.argv[2];
if (!dir) { console.error('الاستعمال: node resize-screens.js "مسار المجلد"'); process.exit(1); }
const outDir = path.join(dir, 'جاهزة-للرفع');
fs.mkdirSync(outDir, { recursive: true });

const files = fs.readdirSync(dir).filter(f => /\.png$/i.test(f));
if (!files.length) { console.error('ماكو صور PNG بالمجلد'); process.exit(1); }

console.log(`المطلوب: ${OUT_W} × ${OUT_H}\n`);
let done = 0;
for (const f of files) {
  try {
    const src = readPNG(path.join(dir, f));
    if (src.width === OUT_W && src.height === OUT_H) {
      fs.copyFileSync(path.join(dir, f), path.join(outDir, f));
      console.log(`  ${f.padEnd(16)} ${src.width}×${src.height}  — بالمقاس أصلاً، نسخناها`);
      done++; continue;
    }
    // نتأكد إن النسبة متقاربة — وإلا التصغير يمطّ الصورة
    const skew = Math.abs((src.width / src.height) / (OUT_W / OUT_H) - 1);
    if (skew > 0.01) {
      console.log(`  ⚠️ ${f.padEnd(16)} ${src.width}×${src.height}  — نسبة مختلفة، راح تنمطّ. تخطيناها`);
      continue;
    }
    writePNG(resize(src, OUT_W, OUT_H), OUT_W, OUT_H, path.join(outDir, f));
    console.log(`  ✅ ${f.padEnd(16)} ${src.width}×${src.height}  →  ${OUT_W}×${OUT_H}`);
    done++;
  } catch (e) {
    console.log(`  ❌ ${f.padEnd(16)} ${e.message}`);
  }
}
console.log(`\nجاهزة ${done} صورة بـ:\n  ${outDir}`);

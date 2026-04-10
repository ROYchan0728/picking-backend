const express  = require('express');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');
const multer   = require('multer');
const XLSX     = require('xlsx');
const webpush  = require('web-push');
const pdfParse = require('pdf-parse');

const app      = express();
const PORT     = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE  = path.join(DATA_DIR, 'data.json');
const STOCK_FILE = path.join(DATA_DIR, 'stock.json');
const SUBS_FILE     = path.join(DATA_DIR, 'subscriptions.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// VAPID — set these as env vars in Railway/Docker
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || 'BFj1IfOTZtrF8PxkIX83cCKcO9nMlvet7CN1d_zs7_wUgTtJcg5C7B5kjdw5I70D0sFEgSSBOZ5rWoL4P39ouhA';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || 'JGuk33HorjFeew9zkvZk5Cmlp7utOOKs6Gihr3BbnRM';
const VAPID_EMAIL   = process.env.VAPID_EMAIL   || 'mailto:admin@picking-app.com';

webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);

// CORS
const allowedOrigins = process.env.FRONTEND_URL
  ? [process.env.FRONTEND_URL]
  : ['http://localhost:5500', 'http://127.0.0.1:5500', 'http://localhost:3001'];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(o => origin.startsWith(o))) return callback(null, true);
    callback(new Error('CORS blocked: ' + origin));
  },
  credentials: true
}));
app.use(express.json());

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── DATA HELPERS ────────────────────────────────────────
function readData() {
  if (!fs.existsSync(DATA_FILE)) return { orders: [], reports: [] };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { orders: [], reports: [] }; }
}
function writeData(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }

function readStock() {
  if (!fs.existsSync(STOCK_FILE)) return { items: [], updatedAt: null };
  try { return JSON.parse(fs.readFileSync(STOCK_FILE, 'utf8')); }
  catch { return { items: [], updatedAt: null }; }
}

function readSubs() {
  if (!fs.existsSync(SUBS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); }
  catch { return []; }
}
function writeSubs(subs) { fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2)); }

function readSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) return { stockReminderTime: '08:45', stockReminderEnabled: true, timezone: 'Asia/Singapore' };
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return { stockReminderTime: '08:45', stockReminderEnabled: true, timezone: 'Asia/Singapore' }; }
}
function writeSettings(s) { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2)); }

// ─── SSE ─────────────────────────────────────────────────
const clients = new Set();
function broadcast(event, payload) {
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(payload) + '\n\n';
  clients.forEach(res => { try { res.write(msg); } catch {} });
}

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.flushHeaders();
  clients.add(res);
  const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => { clients.delete(res); clearInterval(ka); });
});

// ─── WEB PUSH ─────────────────────────────────────────────
app.get('/api/push/vapid-public', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC });
});

app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  const subs = readSubs();
  const exists = subs.findIndex(s => s.endpoint === sub.endpoint);
  if (exists >= 0) subs[exists] = sub; else subs.push(sub);
  writeSubs(subs);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'No endpoint' });
  const subs = readSubs().filter(s => s.endpoint !== endpoint);
  writeSubs(subs);
  res.json({ ok: true });
});

async function pushToAll(payload) {
  const subs = readSubs();
  if (!subs.length) return;
  const msg = JSON.stringify(payload);
  const dead = [];
  await Promise.all(subs.map(async sub => {
    try {
      await webpush.sendNotification(sub, msg);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) dead.push(sub.endpoint);
    }
  }));
  if (dead.length) {
    writeSubs(subs.filter(s => !dead.includes(s.endpoint)));
  }
}

// ─── ORDERS ──────────────────────────────────────────────
app.get('/api/orders', (req, res) => res.json(readData().orders));

const upload = multer({ storage: multer.memoryStorage() });
app.post('/api/orders/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const orderId = req.file.originalname.replace(/\.[^.]+$/, '');
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    if (rows.length < 2) return res.status(400).json({ error: 'No data rows' });
    const header = rows[0].map(h => String(h || '').toLowerCase());
    const col = name => header.findIndex(h => h.includes(name));
    const cNum  = col('number');
    const cDesc = col('desc');
    const cQty  = col('qty');
    const cUser = header.findIndex(h => h.includes('vendorm') || h.includes('user'));
    const cUom  = header.findIndex(h => h.includes('uom'));
    const items = []; let autoNum = 1; let id = 1;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const desc    = cDesc >= 0 ? row[cDesc] : null;
      const qty     = cQty  >= 0 ? row[cQty]  : null;
      const num     = cNum  >= 0 ? row[cNum]   : null;
      const descStr = desc ? String(desc).trim() : '';
      const qtyNum  = qty  ? parseFloat(qty) : 0;
      if (!descStr || qtyNum <= 0) continue;
      items.push({
        id:          id++,
        numbering:   num ? String(num).trim() : ('#' + (autoNum++)),
        description: descStr,
        qty:         qtyNum,
        user:        cUser >= 0 && row[cUser] ? String(row[cUser]).trim() : '',
        uom:         cUom  >= 0 && row[cUom]  ? String(row[cUom]).trim()  : '',
        status:      'pending'
      });
    }
    if (!items.length) return res.status(400).json({ error: 'No valid rows found' });
    const data  = readData();
    const order = { id: orderId, filename: req.file.originalname, loadedAt: new Date().toLocaleDateString('zh-CN'), items };
    const idx   = data.orders.findIndex(o => o.id === orderId);
    const isNew = idx < 0;
    if (idx >= 0) data.orders[idx] = order; else data.orders.unshift(order);
    writeData(data);
    broadcast('orders_updated', data.orders);
    // Push notification for new orders
    if (isNew) {
      pushToAll({
        title: '新订单：' + orderId,
        body:  items.length + ' 个品项待拣货',
        orderId
      });
    }
    res.json({ ok: true, order, isNew });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/orders/:id', (req, res) => {
  const data = readData();
  data.orders = data.orders.filter(o => o.id !== req.params.id);
  writeData(data); broadcast('orders_updated', data.orders);
  res.json({ ok: true });
});

// ─── ITEMS ───────────────────────────────────────────────
app.patch('/api/orders/:orderId/items/:itemId', (req, res) => {
  const data  = readData();
  const order = data.orders.find(o => o.id === req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const item  = order.items.find(i => i.id === parseInt(req.params.itemId));
  if (!item)  return res.status(404).json({ error: 'Item not found' });
  const { status, subName } = req.body;
  item.status = status;
  if (subName !== undefined) item.subName = subName; else delete item.subName;
  writeData(data); broadcast('item_updated', { orderId: order.id, item });
  res.json({ ok: true, item });
});

// ─── REPORTS ─────────────────────────────────────────────
app.get('/api/reports', (req, res) => res.json(readData().reports));

app.post('/api/reports', (req, res) => {
  const { orderId } = req.body;
  const data  = readData();
  const order = data.orders.find(o => o.id === orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const report = { orderId, finishedAt: new Date().toLocaleString('zh-CN'), items: JSON.parse(JSON.stringify(order.items)) };
  data.reports.unshift(report); writeData(data);
  broadcast('report_created', report);
  res.json({ ok: true, report });
});

// ─── STOCK ───────────────────────────────────────────────
app.get('/api/stock', (req, res) => res.json(readStock()));

app.post('/api/stock/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    if (rows.length < 2) return res.status(400).json({ error: 'No data rows' });
    const header  = rows[0].map(h => String(h || '').trim());
    const ci      = name => header.findIndex(h => h.includes(name));
    const cCode   = ci('商品代码'), cUom = ci('基本UOM'), cName = ci('名称');
    const cGroup  = ci('商品组别'), cCat = ci('商品类别');
    const cCtrl   = ci('库存控制'), cActive = ci('活跃'), cQty = ci('剩余总量');
    const items = [];
    for (let i = 1; i < rows.length; i++) {
      const row    = rows[i];
      const ctrl   = cCtrl   >= 0 ? String(row[cCtrl]   || '').trim() : '';
      const active = cActive >= 0 ? String(row[cActive] || '').trim() : '';
      if (ctrl === 'Unchecked' || active === 'Unchecked') continue;
      const name = cName >= 0 ? String(row[cName] || '').trim() : '';
      if (!name) continue;
      let qty = 0;
      try { qty = cQty >= 0 && row[cQty] != null ? parseFloat(row[cQty]) : 0; } catch {}
      items.push({
        code:     cCode  >= 0 && row[cCode]  ? String(row[cCode]).trim()  : '',
        uom:      cUom   >= 0 && row[cUom]   ? String(row[cUom]).trim()   : '',
        name,
        group:    cGroup >= 0 && row[cGroup] ? String(row[cGroup]).trim() : '其他组别',
        category: cCat   >= 0 && row[cCat]   ? String(row[cCat]).trim()   : '其他类别',
        qty
      });
    }
    if (!items.length) return res.status(400).json({ error: 'No valid stock rows' });
    const stock = { items, updatedAt: new Date().toLocaleString('zh-CN'), filename: req.file.originalname };
    fs.writeFileSync(STOCK_FILE, JSON.stringify(stock, null, 2));
    broadcast('stock_updated', stock);
    res.json({ ok: true, count: items.length, updatedAt: stock.updatedAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── HEALTH ──────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ─── SETTINGS API ─────────────────────────────────────────
app.get('/api/settings', (req, res) => res.json(readSettings()));

app.post('/api/settings', (req, res) => {
  const current = readSettings();
  const updated = Object.assign(current, req.body);
  writeSettings(updated);
  res.json({ ok: true, settings: updated });
});

// ─── STOCK REMINDER SCHEDULER ────────────────────────────
let lastReminderDate = null;

function checkStockReminder() {
  const settings = readSettings();
  if (!settings.stockReminderEnabled) return;

  const tz = settings.timezone || 'Asia/Singapore';
  const now = new Date();

  // Get current time in target timezone
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit', minute: '2-digit',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour12: false
  }).formatToParts(now);

  const p = {};
  parts.forEach(({ type, value }) => { p[type] = value; });
  const currentTime = `${p.hour}:${p.minute}`;
  const currentDate = `${p.year}-${p.month}-${p.day}`;

  if (currentTime === settings.stockReminderTime && lastReminderDate !== currentDate) {
    lastReminderDate = currentDate;
    console.log(`[Reminder] Sending stock reminder at ${currentTime} (${tz})`);
    pushToAll({
      title: '📊 库存更新提醒',
      body: '请记得上传今日最新库存 Excel',
      type: 'stock_reminder'
    });
  }
}

// Check every minute
setInterval(checkStockReminder, 60 * 1000);

app.listen(PORT, () => console.log('Backend running on port ' + PORT));

// ─── VENDOR PO API ───────────────────────────────────────
const PO_FILE = path.join(DATA_DIR, 'vendor_pos.json');

function readPOs() {
  if (!fs.existsSync(PO_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(PO_FILE, 'utf8')); }
  catch { return []; }
}
function writePOs(pos) { fs.writeFileSync(PO_FILE, JSON.stringify(pos, null, 2)); }

app.get('/api/vendor-pos', (req, res) => res.json(readPOs()));

// Upload PDF — extract text via multipart, store metadata
function isCompanyName(str) {
  return /\b(LTD|PTE|CO\.|SDN|CORP|INC|BHD|SHIPPING|MARINE|HARDWARE|SUPPLY|TRADING|ENTERPRISE|INDUSTRIES|SERVICES|GROUP|HARDWARE)\b/i.test(str);
}

function parsePOText(text) {
  const get = (pattern) => {
    const m = text.match(pattern);
    return m ? m[1].trim() : '';
  };

  const flat  = text.replace(/\r/g, '').replace(/\n+/g, ' ');
  const lines = text.split('\n');

  // PO number
  const po = flat.match(/PURCHASE\s+ORDER[\s\S]*?No\.?\s*:?\s*(PO-\d+)/i)?.[1]?.trim() || '';

  // Vessel: line immediately after "S/N"
  let vessel = '';
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].trim() === 'S/N') { vessel = lines[i + 1].trim(); break; }
  }
  if (!vessel) {
    const raw = get(/Vessel\s*Name\s*:\s*(.+)/i);
    vessel = raw.replace(/\s*(Purchaser|Page|Date|TEL|FAX|Attn|Item|S\/N)[\s\S]*$/i, '').replace(/\s+/g,' ').trim();
  }

  // Vendor: find "Your Ref No." line, extract company name from same line or nearby
  let vendor = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/Your Ref No\.?/i.test(line)) {
      // Format A: "Your Ref No.VENDOR NAME" on same line
      const inline = line.replace(/^.*Your Ref No\.?\s*/i, '').trim();
      if (inline && isCompanyName(inline)) { vendor = inline; break; }
      // Format B/C: scan next few lines for a company name
      for (let j = i + 1; j <= i + 5 && j < lines.length; j++) {
        const c = lines[j].trim();
        if (c && isCompanyName(c)) { vendor = c; break; }
      }
      if (vendor) break;
      // Last resort: first non-empty, non-address line after "Your Ref No."
      for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
        const c = lines[j].trim();
        if (c && !/^[\d\s,]+$/.test(c) &&
            !/^(SINGAPORE|Date|Delivery|Vessel|Purchaser|Page|TEL|FAX|Attn|\d)/i.test(c) &&
            c.length > 3) { vendor = c; break; }
      }
      break;
    }
  }

  const delivery  = get(/Delivery\s*Date\s*:\s*(.+)/i);
  const purchaser = get(/Purchaser\s*:\s*(.+)/i);
  const subtotal  = get(/Sub\s*Total\s+S\$\s*([\d,\.]+)/i);
  const gst       = get(/GST\s*\d+%\s*S\$\s*([\d,\.]+)/i);
  const total     = get(/Total\s*Amount\s*S\$\s*([\d,\.]+)/i);

  return {
    po, vessel, vendor, delivery, purchaser,
    subtotal: parseFloat((subtotal||'0').replace(',',''))||0,
    gst:      parseFloat((gst     ||'0').replace(',',''))||0,
    total:    parseFloat((total   ||'0').replace(',',''))||0,
  };
}

app.post('/api/vendor-pos/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const pos       = readPOs();
    const results   = [];
    const errors    = [];
    const pdfBase64 = req.file.buffer.toString('base64');

    const parsed   = await pdfParse(req.file.buffer);
    const fullText = parsed.text || '';
    const allLines = fullText.split('\n');

    // Split into per-PO blocks — each page starts with "Item" in pdf-parse output
    const itemLineIndices = [];
    allLines.forEach((line, i) => { if (line.trim() === 'Item') itemLineIndices.push(i); });
    let blocks = itemLineIndices.length > 1
      ? itemLineIndices.map((start, i) => {
          const end = i + 1 < itemLineIndices.length ? itemLineIndices[i + 1] : allLines.length;
          return allLines.slice(start, end).join('\n');
        })
      : [fullText];

    if (!blocks.length) return res.status(400).json({ error: 'Cannot find any PO in PDF' });

    const existingPOs     = pos.map(p => p.po);
    const existingVessels = [...new Set(pos.map(p => p.vessel))];
    const existingVendors = [...new Set(pos.map(p => p.vendor))];
    const seenVessels = new Set();
    const seenVendors = new Set();

    for (let bi = 0; bi < blocks.length; bi++) {
      const info = parsePOText(blocks[bi]);
      if (!info.po)     { errors.push({ block: bi + 1, error: 'Cannot find PO number' }); continue; }
      if (!info.vessel) { errors.push({ block: bi + 1, po: info.po, error: 'Cannot find Vessel Name' }); continue; }
      if (!info.vendor) { errors.push({ block: bi + 1, po: info.po, error: 'Cannot find vendor name' }); continue; }

      const entry = {
        po: info.po, vessel: info.vessel, vendor: info.vendor,
        delivery: info.delivery, purchaser: info.purchaser,
        subtotal: info.subtotal, gst: info.gst, total: info.total,
        items: [], uploadedAt: new Date().toLocaleString('zh-CN'),
        pdf: pdfBase64, pageIndex: bi
      };

      const isNewPO     = !existingPOs.includes(entry.po);
      const isNewVessel = !existingVessels.includes(entry.vessel) && !seenVessels.has(entry.vessel);
      const isNewVendor = !existingVendors.includes(entry.vendor) && !seenVendors.has(entry.vendor);
      seenVessels.add(entry.vessel);
      seenVendors.add(entry.vendor);

      const idx = pos.findIndex(p => p.po === entry.po);
      if (idx >= 0) pos[idx] = entry; else pos.unshift(entry);
      existingPOs.push(entry.po);
      results.push({ po: entry.po, vessel: entry.vessel, vendor: entry.vendor, isNewPO, isNewVessel, isNewVendor });
    }

    writePOs(pos);
    broadcast('vendor_pos_updated', readPOs().map(p => ({ ...p, pdf: undefined })));

    if (results.length > 0) {
      const newV = results.find(r => r.isNewVessel);
      const newD = results.find(r => r.isNewVendor);
      let title, body;
      if (newV)              { title = `🚢 新船：${newV.vessel}`; body = `${results.length} 份供货商 PO 已上传`; }
      else if (newD)         { title = `🏭 新供货商：${newD.vendor}`; body = `船名 ${newD.vessel}`; }
      else if (results.length > 1) { title = `📄 ${results.length} 份新 PO`; body = results[0].vessel; }
      else                   { title = `📄 新 PO：${results[0].po}`; body = `${results[0].vessel} · ${results[0].vendor}`; }
      pushToAll({ title, body, type: 'vendor_po' });
    }

    res.json({ ok: true, count: results.length, results, errors });
  } catch (err) {
    res.status(500).json({ error: 'PDF parse failed: ' + err.message });
  }
});


app.delete('/api/vendor-pos/:po', (req, res) => {
  const pos = readPOs().filter(p => p.po !== req.params.po);
  writePOs(pos);
  broadcast('vendor_pos_updated', pos.map(p => ({ ...p, pdf: undefined })));
  res.json({ ok: true });
});


app.get('/api/vendor-pos/:po/pdf', (req, res) => {
  const pos = readPOs();
  const entry = pos.find(p => p.po === req.params.po);
  if (!entry || !entry.pdf) return res.status(404).json({ error: 'PDF not found' });
  const buf = Buffer.from(entry.pdf, 'base64');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${entry.po}.pdf"`);
  res.send(buf);
});

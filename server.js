const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

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

function readData() {
  if (!fs.existsSync(DATA_FILE)) return { orders: [], reports: [] };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { orders: [], reports: [] }; }
}
function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

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

app.get('/api/orders', (req, res) => res.json(readData().orders));

const upload = multer({ storage: multer.memoryStorage() });
app.post('/api/orders/upload', upload.single('file'), (req, res) => {
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
    const cUser = header.findIndex(h => h.includes('user') || h.includes('vendor'));
    const cUom  = col('uom');

    const items = [];
    let autoNum = 1;
    let id = 1;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const num  = cNum  >= 0 ? row[cNum]  : null;
      const desc = cDesc >= 0 ? row[cDesc] : null;
      const qty  = cQty  >= 0 ? row[cQty]  : null;
      // Only desc + qty are required; numbering is optional
      if (!desc || !qty) continue;
      items.push({
        id:          id++,
        numbering:   num ? String(num) : ('#' + (autoNum++)),
        description: String(desc),
        qty:         Number(qty),
        user:        cUser >= 0 && row[cUser] ? String(row[cUser]) : '',
        uom:         cUom  >= 0 && row[cUom]  ? String(row[cUom])  : '',
        status:      'pending'
      });
    }

    if (!items.length) return res.status(400).json({ error: 'No valid rows found' });

    const data = readData();
    const order = {
      id: orderId,
      filename: req.file.originalname,
      loadedAt: new Date().toLocaleDateString('zh-CN'),
      items
    };
    const idx = data.orders.findIndex(o => o.id === orderId);
    if (idx >= 0) data.orders[idx] = order; else data.orders.unshift(order);
    writeData(data);
    broadcast('orders_updated', data.orders);
    res.json({ ok: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/orders/:id', (req, res) => {
  const data = readData();
  data.orders = data.orders.filter(o => o.id !== req.params.id);
  writeData(data);
  broadcast('orders_updated', data.orders);
  res.json({ ok: true });
});

app.patch('/api/orders/:orderId/items/:itemId', (req, res) => {
  const data = readData();
  const order = data.orders.find(o => o.id === req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const item = order.items.find(i => i.id === parseInt(req.params.itemId));
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const { status, subName } = req.body;
  item.status = status;
  if (subName !== undefined) item.subName = subName; else delete item.subName;
  writeData(data);
  broadcast('item_updated', { orderId: order.id, item });
  res.json({ ok: true, item });
});

app.get('/api/reports', (req, res) => res.json(readData().reports));

app.post('/api/reports', (req, res) => {
  const { orderId } = req.body;
  const data = readData();
  const order = data.orders.find(o => o.id === orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const report = {
    orderId,
    finishedAt: new Date().toLocaleString('zh-CN'),
    items: JSON.parse(JSON.stringify(order.items))
  };
  data.reports.unshift(report);
  writeData(data);
  broadcast('report_created', report);
  res.json({ ok: true, report });
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, () => console.log('Backend running on port ' + PORT));

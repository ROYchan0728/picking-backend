const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const XLSX     = require('xlsx');
const webpush  = require('web-push');
const pdfParse = require('pdf-parse');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── DATABASE ────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('supabase')
    ? { rejectUnauthorized: false } : false
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}

async function initDB() {
  await query(`CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, data JSONB NOT NULL, loaded_at TIMESTAMPTZ DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS reports (
    id SERIAL PRIMARY KEY, order_id TEXT NOT NULL, data JSONB NOT NULL, finished_at TIMESTAMPTZ DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS stock_meta (
    id INTEGER PRIMARY KEY DEFAULT 1,
    filename TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS stock_items (
    id SERIAL PRIMARY KEY,
    code TEXT UNIQUE,
    name TEXT NOT NULL,
    uom TEXT,
    item_group TEXT,
    category TEXT,
    qty NUMERIC DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  // Add unique constraint if upgrading from old schema
  await query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'stock_items_code_key'
      ) THEN
        ALTER TABLE stock_items ADD CONSTRAINT stock_items_code_key UNIQUE (code);
      END IF;
    END $$
  `).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS idx_stock_items_group ON stock_items(item_group)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_stock_items_code  ON stock_items(code)`);
  await query(`CREATE TABLE IF NOT EXISTS vendor_pos (
    po TEXT PRIMARY KEY, vessel TEXT NOT NULL, vendor TEXT NOT NULL, data JSONB NOT NULL, uploaded_at TIMESTAMPTZ DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS subscriptions (
    endpoint TEXT PRIMARY KEY, data JSONB NOT NULL)`);
  await query(`CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY DEFAULT 1, data JSONB NOT NULL)`);
  console.log('Database tables ready');
}

// ─── VAPID ───────────────────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || 'BFj1IfOTZtrF8PxkIX83cCKcO9nMlvet7CN1d_zs7_wUgTtJcg5C7B5kjdw5I70D0sFEgSSBOZ5rWoL4P39ouhA';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || 'JGuk33HorjFeew9zkvZk5Cmlp7utOOKs6Gihr3BbnRM';
webpush.setVapidDetails('mailto:admin@picking-app.com', VAPID_PUBLIC, VAPID_PRIVATE);

// ─── CORS ────────────────────────────────────────────────
const allowedOrigins = process.env.FRONTEND_URL
  ? [process.env.FRONTEND_URL]
  : ['http://localhost:5500', 'http://127.0.0.1:5500', 'http://localhost:3001'];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.some(o => origin.startsWith(o))) return cb(null, true);
    cb(new Error('CORS blocked: ' + origin));
  },
  credentials: true
}));
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

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

// ─── PUSH ─────────────────────────────────────────────────
async function pushToAll(payload) {
  const { rows } = await query('SELECT data FROM subscriptions');
  if (!rows.length) return;
  const msg = JSON.stringify(payload);
  const dead = [];
  await Promise.all(rows.map(async row => {
    try { await webpush.sendNotification(row.data, msg); }
    catch (err) { if (err.statusCode === 404 || err.statusCode === 410) dead.push(row.data.endpoint); }
  }));
  for (const ep of dead) await query('DELETE FROM subscriptions WHERE endpoint=$1', [ep]);
}

app.get('/api/push/vapid-public', (req, res) => res.json({ publicKey: VAPID_PUBLIC }));

app.post('/api/push/subscribe', async (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  await query('INSERT INTO subscriptions(endpoint,data) VALUES($1,$2) ON CONFLICT(endpoint) DO UPDATE SET data=$2',
    [sub.endpoint, JSON.stringify(sub)]);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', async (req, res) => {
  await query('DELETE FROM subscriptions WHERE endpoint=$1', [req.body.endpoint]);
  res.json({ ok: true });
});

// ─── ORDERS ──────────────────────────────────────────────
app.get('/api/orders', async (req, res) => {
  const { rows } = await query('SELECT data FROM orders ORDER BY loaded_at DESC');
  res.json(rows.map(r => r.data));
});

app.post('/api/orders/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const orderId = req.file.originalname.replace(/\.[^.]+$/, '');
  try {
    const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    if (rows.length < 2) return res.status(400).json({ error: 'No data rows' });

    const header = rows[0].map(h => String(h || '').toLowerCase());
    const col = name => header.findIndex(h => h.includes(name));
    const cNum=col('number'), cDesc=col('desc'), cQty=col('qty');
    const cUser=header.findIndex(h=>h.includes('vendorm')||h.includes('user'));
    const cUom=header.findIndex(h=>h.includes('uom'));

    const items = []; let autoNum=1, id=1;
    for (let i=1; i<rows.length; i++) {
      const row=rows[i];
      const descStr=cDesc>=0&&row[cDesc]?String(row[cDesc]).trim():'';
      const qtyNum=cQty>=0&&row[cQty]?parseFloat(row[cQty]):0;
      if (!descStr||qtyNum<=0) continue;
      items.push({ id:id++, numbering:cNum>=0&&row[cNum]?String(row[cNum]).trim():('#'+(autoNum++)),
        description:descStr, qty:qtyNum,
        user:cUser>=0&&row[cUser]?String(row[cUser]).trim():'',
        uom:cUom>=0&&row[cUom]?String(row[cUom]).trim():'', status:'pending' });
    }
    if (!items.length) return res.status(400).json({ error: 'No valid rows found' });

    const existing = await query('SELECT id FROM orders WHERE id=$1', [orderId]);
    const isNew = existing.rowCount === 0;
    const order = { id:orderId, filename:req.file.originalname, loadedAt:new Date().toLocaleDateString('zh-CN'), items };
    await query('INSERT INTO orders(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=$2, loaded_at=NOW()',
      [orderId, JSON.stringify(order)]);

    const { rows: all } = await query('SELECT data FROM orders ORDER BY loaded_at DESC');
    broadcast('orders_updated', all.map(r=>r.data));
    if (isNew) pushToAll({ title:'新订单：'+orderId, body:items.length+' 个品项待拣货', orderId });
    res.json({ ok:true, order, isNew });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

app.delete('/api/orders/:id', async (req, res) => {
  await query('DELETE FROM orders WHERE id=$1', [req.params.id]);
  const { rows } = await query('SELECT data FROM orders ORDER BY loaded_at DESC');
  broadcast('orders_updated', rows.map(r=>r.data));
  res.json({ ok:true });
});

// ─── ITEMS ───────────────────────────────────────────────
app.patch('/api/orders/:orderId/items/:itemId', async (req, res) => {
  const { rows } = await query('SELECT data FROM orders WHERE id=$1', [req.params.orderId]);
  if (!rows.length) return res.status(404).json({ error:'Order not found' });
  const order = rows[0].data;
  const item  = order.items.find(i => i.id === parseInt(req.params.itemId));
  if (!item) return res.status(404).json({ error:'Item not found' });
  item.status = req.body.status;
  if (req.body.subName !== undefined) item.subName = req.body.subName; else delete item.subName;
  await query('UPDATE orders SET data=$2 WHERE id=$1', [order.id, JSON.stringify(order)]);
  broadcast('item_updated', { orderId:order.id, item });
  res.json({ ok:true, item });
});

// ─── REPORTS ─────────────────────────────────────────────
app.get('/api/reports', async (req, res) => {
  const { rows } = await query('SELECT data FROM reports ORDER BY finished_at DESC');
  res.json(rows.map(r=>r.data));
});

app.post('/api/reports', async (req, res) => {
  const { orderId } = req.body;
  const { rows } = await query('SELECT data FROM orders WHERE id=$1', [orderId]);
  if (!rows.length) return res.status(404).json({ error:'Order not found' });
  const report = { orderId, finishedAt:new Date().toLocaleString('zh-CN'), items:JSON.parse(JSON.stringify(rows[0].data.items)) };
  await query('INSERT INTO reports(order_id,data) VALUES($1,$2)', [orderId, JSON.stringify(report)]);
  broadcast('report_created', report);
  res.json({ ok:true, report });
});

// ─── STOCK ───────────────────────────────────────────────
app.get('/api/stock', async (req, res) => {
  const [metaRes, itemsRes] = await Promise.all([
    query('SELECT filename, updated_at FROM stock_meta WHERE id=1'),
    query('SELECT code, name, uom, item_group AS "group", category, qty FROM stock_items ORDER BY item_group, name')
  ]);
  const meta = metaRes.rows[0] || {};
  res.json({
    items: itemsRes.rows.map(r => ({ ...r, qty: parseFloat(r.qty) })),
    updatedAt: meta.updated_at ? new Date(meta.updated_at).toLocaleString('zh-CN') : null,
    filename:  meta.filename || null
  });
});

app.post('/api/stock/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error:'No file' });
  try {
    const wb=XLSX.read(req.file.buffer,{type:'buffer'}), ws=wb.Sheets[wb.SheetNames[0]];
    const rows=XLSX.utils.sheet_to_json(ws,{header:1});
    if (rows.length<2) return res.status(400).json({ error:'No data rows' });

    const header=rows[0].map(h=>String(h||'').trim());
    const ci=name=>header.findIndex(h=>h.includes(name));
    const cCode=ci('商品代码'),cUom=ci('基本UOM'),cName=ci('名称');
    const cGroup=ci('商品组别'),cCat=ci('商品类别');
    const cCtrl=ci('库存控制'),cActive=ci('活跃'),cQty=ci('剩余总量');

    const items=[];
    for (let i=1;i<rows.length;i++) {
      const row=rows[i];
      const ctrl  =cCtrl  >=0?String(row[cCtrl]  ||'').trim():'';
      const active=cActive>=0?String(row[cActive]||'').trim():'';
      if (ctrl==='Unchecked'||active==='Unchecked') continue;
      const name=cName>=0?String(row[cName]||'').trim():'';
      if (!name) continue;
      let qty=0; try{qty=cQty>=0&&row[cQty]!=null?parseFloat(row[cQty]):0;}catch{}
      items.push({
        code:    cCode >=0&&row[cCode] ?String(row[cCode]).trim() :'',
        uom:     cUom  >=0&&row[cUom]  ?String(row[cUom]).trim()  :'',
        name,
        group:   cGroup>=0&&row[cGroup]?String(row[cGroup]).trim():'其他组别',
        category:cCat  >=0&&row[cCat]  ?String(row[cCat]).trim()  :'其他类别',
        qty
      });
    }
    if (!items.length) return res.status(400).json({ error:'No valid stock rows' });

    // Full sync: upsert items in Excel, delete items not in Excel
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Upsert all items from Excel
      const codes = items.map(i => i.code);
      for (const item of items) {
        await client.query(
          `INSERT INTO stock_items(code, name, uom, item_group, category, qty)
           VALUES($1, $2, $3, $4, $5, $6)
           ON CONFLICT(code) DO UPDATE SET
             name       = EXCLUDED.name,
             uom        = EXCLUDED.uom,
             item_group = EXCLUDED.item_group,
             category   = EXCLUDED.category,
             qty        = EXCLUDED.qty,
             updated_at = NOW()`,
          [item.code, item.name, item.uom, item.group, item.category, item.qty]
        );
      }

      // 2. Delete items that are no longer in Excel
      const deleted = await client.query(
        `DELETE FROM stock_items WHERE code != '' AND code NOT IN (
           SELECT unnest($1::text[])
         )`,
        [codes]
      );

      await client.query(
        'INSERT INTO stock_meta(id,filename,updated_at) VALUES(1,$1,NOW()) ON CONFLICT(id) DO UPDATE SET filename=$1, updated_at=NOW()',
        [req.file.originalname]
      );
      await client.query('COMMIT');
      console.log(`Stock sync: ${items.length} upserted, ${deleted.rowCount} deleted`);
    } catch(err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }

    // Build response for SSE broadcast (same shape as before)
    const updatedAt = new Date().toLocaleString('zh-CN');
    const stock = { items, updatedAt, filename: req.file.originalname };
    broadcast('stock_updated', stock);
    res.json({ ok:true, count:items.length, updatedAt });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ─── SETTINGS ─────────────────────────────────────────────
const DEF_SETTINGS = { stockReminderTime:'08:45', stockReminderEnabled:true, timezone:'Asia/Singapore' };

app.get('/api/settings', async (req, res) => {
  const { rows } = await query('SELECT data FROM settings WHERE id=1');
  res.json(rows.length ? rows[0].data : DEF_SETTINGS);
});

app.post('/api/settings', async (req, res) => {
  const { rows } = await query('SELECT data FROM settings WHERE id=1');
  const updated = Object.assign(rows.length ? rows[0].data : {...DEF_SETTINGS}, req.body);
  await query('INSERT INTO settings(id,data) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET data=$1', [JSON.stringify(updated)]);
  res.json({ ok:true, settings:updated });
});

let lastReminderDate = null;
async function checkStockReminder() {
  try {
    const { rows } = await query('SELECT data FROM settings WHERE id=1');
    const s = rows.length ? rows[0].data : DEF_SETTINGS;
    if (!s.stockReminderEnabled) return;
    const tz=s.timezone||'Asia/Singapore', now=new Date();
    const parts=new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',year:'numeric',month:'2-digit',day:'2-digit',hour12:false}).formatToParts(now);
    const p={}; parts.forEach(({type,value})=>{p[type]=value;});
    const currentTime=`${p.hour}:${p.minute}`, currentDate=`${p.year}-${p.month}-${p.day}`;
    if (currentTime===s.stockReminderTime && lastReminderDate!==currentDate) {
      lastReminderDate=currentDate;
      pushToAll({ title:'📊 库存更新提醒', body:'请记得上传今日最新库存 Excel', type:'stock_reminder' });
    }
  } catch {}
}
setInterval(checkStockReminder, 60000);

// ─── VENDOR PO ───────────────────────────────────────────
function isCompanyName(str) {
  return /\b(LTD|PTE|CO\.|SDN|CORP|INC|BHD|SHIPPING|MARINE|HARDWARE|SUPPLY|TRADING|ENTERPRISE|INDUSTRIES|SERVICES|GROUP)\b/i.test(str);
}

function parsePOText(text) {
  const get = p => { const m=text.match(p); return m?m[1].trim():''; };
  const flat=text.replace(/\r/g,'').replace(/\n+/g,' ');
  const lines=text.split('\n');
  const po=flat.match(/PURCHASE\s+ORDER[\s\S]*?No\.?\s*:?\s*(PO-\d+)/i)?.[1]?.trim()||'';
  let vessel='';
  for (let i=0;i<lines.length-1;i++) { if(lines[i].trim()==='S/N'){vessel=lines[i+1].trim();break;} }
  if (!vessel) { const raw=get(/Vessel\s*Name\s*:\s*(.+)/i); vessel=raw.replace(/\s*(Purchaser|Page|Date|TEL|FAX|Attn|Item|S\/N)[\s\S]*$/i,'').replace(/\s+/g,' ').trim(); }
  let vendor='';
  for (let i=0;i<lines.length;i++) {
    const line=lines[i].trim();
    if (/Your Ref No\.?/i.test(line)) {
      const inline=line.replace(/^.*Your Ref No\.?\s*/i,'').trim();
      if (inline&&isCompanyName(inline)){vendor=inline;break;}
      for (let j=i+1;j<=i+5&&j<lines.length;j++){const c=lines[j].trim();if(c&&isCompanyName(c)){vendor=c;break;}}
      if (vendor) break;
      for (let j=i+1;j<=i+3&&j<lines.length;j++){const c=lines[j].trim();if(c&&!/^[\d\s,]+$/.test(c)&&!/^(SINGAPORE|Date|Delivery|Vessel|Purchaser|Page|TEL|FAX|Attn|\d)/i.test(c)&&c.length>3){vendor=c;break;}}
      break;
    }
  }
  let delivery=get(/Delivery\s*Date\s*:\s*(\d[\d\/]+)/i);
  if (!delivery){const dm=text.match(/(\d{2}\/\d{2}\/\d{4})\s*Delivery/i);if(dm)delivery=dm[1];}
  let purchaser=get(/Purchaser\s*:\s*([A-Z][A-Z ]+)/i);
  if (!purchaser){const pm=text.match(/([A-Z][A-Z ]+)Purchaser/);if(pm)purchaser=pm[1].trim();}
  const subtotal=get(/Sub\s*Total\s+S\$\s*([\d,\.]+)/i);
  const gst=get(/GST\s*\d+%\s*S\$\s*([\d,\.]+)/i);
  const total=get(/Total\s*Amount\s*S\$\s*([\d,\.]+)/i);
  return { po, vessel, vendor, delivery, purchaser,
    subtotal:parseFloat((subtotal||'0').replace(',',''))||0,
    gst:parseFloat((gst||'0').replace(',',''))||0,
    total:parseFloat((total||'0').replace(',',''))||0 };
}

app.get('/api/vendor-pos', async (req, res) => {
  const { rows } = await query('SELECT data FROM vendor_pos ORDER BY uploaded_at DESC');
  res.json(rows.map(r=>({...r.data, pdf:undefined})));
});

app.post('/api/vendor-pos/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error:'No file' });
  try {
    const pdfBase64=req.file.buffer.toString('base64');
    const parsed=await pdfParse(req.file.buffer);
    const allLines=(parsed.text||'').split('\n');
    const itemIdx=[];
    allLines.forEach((l,i)=>{if(l.trim()==='Item')itemIdx.push(i);});
    const blocks=itemIdx.length>1
      ?itemIdx.map((s,i)=>{const e=i+1<itemIdx.length?itemIdx[i+1]:allLines.length;return allLines.slice(s,e).join('\n');})
      :[parsed.text||''];

    const results=[], errors=[];
    const { rows:existing } = await query('SELECT po,vessel,vendor FROM vendor_pos');
    const existingPOs=existing.map(r=>r.po);
    const existingVessels=[...new Set(existing.map(r=>r.vessel))];
    const existingVendors=[...new Set(existing.map(r=>r.vendor))];
    const seenV=new Set(), seenD=new Set();

    for (let bi=0;bi<blocks.length;bi++) {
      const info=parsePOText(blocks[bi]);
      if (!info.po){errors.push({block:bi+1,error:'Cannot find PO number'});continue;}
      if (!info.vessel){errors.push({block:bi+1,po:info.po,error:'Cannot find Vessel Name'});continue;}
      if (!info.vendor){errors.push({block:bi+1,po:info.po,error:'Cannot find vendor name'});continue;}
      const entry={...info, items:[], uploadedAt:new Date().toLocaleString('zh-CN'), pdf:pdfBase64, pageIndex:bi};
      await query('INSERT INTO vendor_pos(po,vessel,vendor,data) VALUES($1,$2,$3,$4) ON CONFLICT(po) DO UPDATE SET vessel=$2,vendor=$3,data=$4,uploaded_at=NOW()',
        [entry.po, entry.vessel, entry.vendor, JSON.stringify(entry)]);
      const isNewPO=!existingPOs.includes(entry.po);
      const isNewVessel=!existingVessels.includes(entry.vessel)&&!seenV.has(entry.vessel);
      const isNewVendor=!existingVendors.includes(entry.vendor)&&!seenD.has(entry.vendor);
      seenV.add(entry.vessel); seenD.add(entry.vendor); existingPOs.push(entry.po);
      results.push({po:entry.po,vessel:entry.vessel,vendor:entry.vendor,isNewPO,isNewVessel,isNewVendor});
    }

    const { rows:allPOs } = await query('SELECT data FROM vendor_pos ORDER BY uploaded_at DESC');
    broadcast('vendor_pos_updated', allPOs.map(r=>({...r.data,pdf:undefined})));

    if (results.length>0) {
      const newV=results.find(r=>r.isNewVessel), newD=results.find(r=>r.isNewVendor);
      let title, body;
      if (newV){title=`🚢 新船：${newV.vessel}`;body=`${results.length} 份供货商 PO 已上传`;}
      else if (newD){title=`🏭 新供货商：${newD.vendor}`;body=`船名 ${newD.vessel}`;}
      else if (results.length>1){title=`📄 ${results.length} 份新 PO`;body=results[0].vessel;}
      else{title=`📄 新 PO：${results[0].po}`;body=`${results[0].vessel} · ${results[0].vendor}`;}
      pushToAll({title,body,type:'vendor_po'});
    }
    res.json({ok:true,count:results.length,results,errors});
  } catch(err){res.status(500).json({error:'PDF parse failed: '+err.message});}
});

app.delete('/api/vendor-pos/:po', async (req, res) => {
  await query('DELETE FROM vendor_pos WHERE po=$1', [req.params.po]);
  const { rows } = await query('SELECT data FROM vendor_pos ORDER BY uploaded_at DESC');
  broadcast('vendor_pos_updated', rows.map(r=>({...r.data,pdf:undefined})));
  res.json({ok:true});
});

app.get('/api/vendor-pos/:po/pdf', async (req, res) => {
  const { rows } = await query('SELECT data FROM vendor_pos WHERE po=$1', [req.params.po]);
  if (!rows.length||!rows[0].data.pdf) return res.status(404).json({error:'PDF not found'});
  const buf=Buffer.from(rows[0].data.pdf,'base64');
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`inline; filename="${req.params.po}.pdf"`);
  res.send(buf);
});

// ─── HEALTH ──────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok:true, time:new Date().toISOString() }));

// ─── START ───────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log('Backend running on port ' + PORT));
}).catch(err => {
  console.error('DB init failed:', err.message);
  process.exit(1);
});

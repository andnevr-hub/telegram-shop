require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ── TELEGRAM BOT ──
const bot = new TelegramBot(process.env.BOT_TOKEN || 'placeholder', { polling: false });

// ── DATABASE ──
const db = new sqlite3.Database('./shop.db', (err) => {
  if (err) console.error('DB error:', err);
  else console.log('✅ Database connected');
});

// Промісифікація для зручності
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// Ініціалізація таблиць
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price INTEGER NOT NULL,
    stock INTEGER DEFAULT 0,
    description TEXT,
    specs TEXT DEFAULT '[]',
    photo TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_num TEXT UNIQUE NOT NULL,
    customer_name TEXT,
    customer_phone TEXT,
    delivery_type TEXT,
    delivery_city TEXT,
    delivery_branch TEXT,
    payment_type TEXT,
    items TEXT NOT NULL,
    total INTEGER NOT NULL,
    status TEXT DEFAULT 'new',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Демо-товари якщо БД порожня
  db.get('SELECT COUNT(*) as c FROM products', (err, row) => {
    if (!err && row.c === 0) {
      db.run(`INSERT INTO products (name,category,price,stock,description,specs) VALUES (?,?,?,?,?,?)`,
        ['ATK F1 V2 PAW3950','mice',2900,1,
         'Топова бездротова ігрова миша з флагманським сенсором PAW3950.',
         JSON.stringify([["Сенсор","PAW3950"],["Polling Rate","8000 Hz"],["Вага","~39 г"]])]);
      db.run(`INSERT INTO products (name,category,price,stock,description,specs) VALUES (?,?,?,?,?,?)`,
        ['Aimstar Justice Kilimok','pads',1150,3,
         'Преміальний ігровий килимок для FPS ігор.',
         JSON.stringify([["Розмір","450×400 мм"],["Товщина","4 мм"]])]);
    }
  });
});

// ── FILE UPLOAD ──
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `product_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Тільки зображення!'));
  }
});

// ── MIDDLEWARE ──
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));
app.use(express.static('public'));

// ── ADMIN AUTH ──
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token === process.env.ADMIN_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ────────────────────────────────────────────
//  PUBLIC API
// ────────────────────────────────────────────

app.get('/api/products', async (req, res) => {
  try {
    const products = await dbAll('SELECT * FROM products ORDER BY created_at DESC');
    res.json(products.map(p => ({ ...p, specs: JSON.parse(p.specs || '[]') })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders', async (req, res) => {
  const { name, phone, delivery, city, branch, payment, items, total } = req.body;
  if (!name || !phone || !items || !total) {
    return res.status(400).json({ error: 'Не всі поля заповнені' });
  }
  const orderNum = 'CS-' + Date.now().toString().slice(-6);
  try {
    await dbRun(
      `INSERT INTO orders (order_num,customer_name,customer_phone,delivery_type,delivery_city,delivery_branch,payment_type,items,total)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [orderNum, name, phone, delivery, city||'', branch||'', payment, JSON.stringify(items), total]
    );

    // Telegram повідомлення
    const itemsList = items.map(i => `• ${i.name} ×${i.qty} = ${(i.price*i.qty).toLocaleString()} ₴`).join('\n');
    const deliveryText = delivery === 'np' ? `📦 Nova Poshta\n🏙 ${city}, ${branch}` : '🏠 Самовивіз (Київ)';
    const paymentText = payment === 'card' ? '💳 Карта (передоплата)' : '📬 Накладений платіж';
    const msg = `🛒 *НОВЕ ЗАМОВЛЕННЯ ${orderNum}*\n\n👤 *Клієнт:* ${name}\n📞 *Телефон:* ${phone}\n\n*Товари:*\n${itemsList}\n\n*Сума:* ${Number(total).toLocaleString()} ₴\n\n*Доставка:* ${deliveryText}\n*Оплата:* ${paymentText}`;

    if (process.env.ADMIN_CHAT_ID && process.env.BOT_TOKEN !== 'placeholder') {
      bot.sendMessage(process.env.ADMIN_CHAT_ID, msg, { parse_mode: 'Markdown' })
        .catch(err => console.error('Telegram error:', err.message));
    }

    res.json({ success: true, orderNum });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ────────────────────────────────────────────
//  ADMIN API
// ────────────────────────────────────────────

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    res.json({ success: true, token: process.env.ADMIN_PASSWORD });
  } else {
    res.status(401).json({ error: 'Невірний пароль' });
  }
});

app.get('/api/admin/orders', adminAuth, async (req, res) => {
  try {
    const orders = await dbAll('SELECT * FROM orders ORDER BY created_at DESC');
    res.json(orders.map(o => ({ ...o, items: JSON.parse(o.items) })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/orders/:id', adminAuth, async (req, res) => {
  const { status } = req.body;
  await dbRun('UPDATE orders SET status=? WHERE id=?', [status, req.params.id]);
  res.json({ success: true });
});

app.post('/api/admin/products', adminAuth, upload.single('photo'), async (req, res) => {
  const { name, category, price, stock, description, specs } = req.body;
  const photo = req.file ? `/uploads/${req.file.filename}` : null;
  try {
    const result = await dbRun(
      `INSERT INTO products (name,category,price,stock,description,specs,photo) VALUES (?,?,?,?,?,?,?)`,
      [name, category, parseInt(price), parseInt(stock), description, specs||'[]', photo]
    );
    res.json({ success: true, id: result.lastID });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/products/:id', adminAuth, upload.single('photo'), async (req, res) => {
  const { name, category, price, stock, description, specs } = req.body;
  try {
    const product = await dbGet('SELECT * FROM products WHERE id=?', [req.params.id]);
    if (!product) return res.status(404).json({ error: 'Не знайдено' });
    const photo = req.file ? `/uploads/${req.file.filename}` : product.photo;
    await dbRun(
      `UPDATE products SET name=?,category=?,price=?,stock=?,description=?,specs=?,photo=? WHERE id=?`,
      [name, category, parseInt(price), parseInt(stock), description, specs||'[]', photo, req.params.id]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/products/:id', adminAuth, async (req, res) => {
  try {
    const product = await dbGet('SELECT * FROM products WHERE id=?', [req.params.id]);
    if (product?.photo) {
      const filePath = '.' + product.photo;
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    await dbRun('DELETE FROM products WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/products/:id/stock', adminAuth, async (req, res) => {
  const { stock } = req.body;
  await dbRun('UPDATE products SET stock=? WHERE id=?', [parseInt(stock), req.params.id]);
  res.json({ success: true });
});

// ── FALLBACK ──
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

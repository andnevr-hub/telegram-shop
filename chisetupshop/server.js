require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ── TELEGRAM BOT ──
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });

// ── DATABASE ──
const db = new Database('./shop.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price INTEGER NOT NULL,
    stock INTEGER DEFAULT 0,
    description TEXT,
    specs TEXT DEFAULT '[]',
    photo TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orders (
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
  );
`);

// Додаємо демо-товари якщо БД порожня
const count = db.prepare('SELECT COUNT(*) as c FROM products').get();
if (count.c === 0) {
  const insert = db.prepare(`
    INSERT INTO products (name, category, price, stock, description, specs, photo)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('ATK F1 V2 PAW3950', 'mice', 2900, 1,
    'Топова бездротова ігрова миша з флагманським сенсором PAW3950.',
    JSON.stringify([["Сенсор","PAW3950"],["Polling Rate","8000 Hz"],["Вага","~39 г"]]),
    null
  );
  insert.run('Aimstar Justice Kilimok', 'pads', 1150, 3,
    'Преміальний ігровий килимок для FPS ігор.',
    JSON.stringify([["Розмір","450×400 мм"],["Товщина","4 мм"]]),
    null
  );
}

// ── FILE UPLOAD ──
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
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

// ── ADMIN AUTH MIDDLEWARE ──
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token === process.env.ADMIN_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ────────────────────────────────────────────
//  PUBLIC API (для міні-апп)
// ────────────────────────────────────────────

// Отримати всі товари
app.get('/api/products', (req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY created_at DESC').all();
  res.json(products.map(p => ({
    ...p,
    specs: JSON.parse(p.specs || '[]')
  })));
});

// Оформити замовлення
app.post('/api/orders', (req, res) => {
  const { name, phone, delivery, city, branch, payment, items, total } = req.body;

  if (!name || !phone || !items || !total) {
    return res.status(400).json({ error: 'Не всі поля заповнені' });
  }

  const orderNum = 'CS-' + Date.now().toString().slice(-6);

  db.prepare(`
    INSERT INTO orders (order_num, customer_name, customer_phone, delivery_type, delivery_city, delivery_branch, payment_type, items, total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(orderNum, name, phone, delivery, city || '', branch || '', payment, JSON.stringify(items), total);

  // Відправляємо сповіщення в Telegram
  const itemsList = items.map(i => `• ${i.name} ×${i.qty} = ${(i.price * i.qty).toLocaleString()} ₴`).join('\n');
  const deliveryText = delivery === 'np'
    ? `📦 Nova Poshta\n🏙 ${city}, ${branch}`
    : '🏠 Самовивіз (Київ)';
  const paymentText = payment === 'card' ? '💳 Карта (передоплата)' : '📬 Накладений платіж';

  const msg = `🛒 *НОВЕ ЗАМОВЛЕННЯ ${orderNum}*\n\n` +
    `👤 *Клієнт:* ${name}\n` +
    `📞 *Телефон:* ${phone}\n\n` +
    `*Товари:*\n${itemsList}\n\n` +
    `*Сума:* ${total.toLocaleString()} ₴\n\n` +
    `*Доставка:* ${deliveryText}\n` +
    `*Оплата:* ${paymentText}`;

  bot.sendMessage(process.env.ADMIN_CHAT_ID, msg, { parse_mode: 'Markdown' })
    .catch(err => console.error('Telegram error:', err.message));

  res.json({ success: true, orderNum });
});

// ────────────────────────────────────────────
//  ADMIN API (захищені маршрути)
// ────────────────────────────────────────────

// Перевірка логіну
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    res.json({ success: true, token: process.env.ADMIN_PASSWORD });
  } else {
    res.status(401).json({ error: 'Невірний пароль' });
  }
});

// Отримати всі замовлення
app.get('/api/admin/orders', adminAuth, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  res.json(orders.map(o => ({ ...o, items: JSON.parse(o.items) })));
});

// Змінити статус замовлення
app.patch('/api/admin/orders/:id', adminAuth, (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ success: true });
});

// Додати товар
app.post('/api/admin/products', adminAuth, upload.single('photo'), (req, res) => {
  const { name, category, price, stock, description, specs } = req.body;
  const photo = req.file ? `/uploads/${req.file.filename}` : null;
  const result = db.prepare(`
    INSERT INTO products (name, category, price, stock, description, specs, photo)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, category, parseInt(price), parseInt(stock), description, specs || '[]', photo);
  res.json({ success: true, id: result.lastInsertRowid });
});

// Оновити товар
app.put('/api/admin/products/:id', adminAuth, upload.single('photo'), (req, res) => {
  const { name, category, price, stock, description, specs } = req.body;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Не знайдено' });

  const photo = req.file ? `/uploads/${req.file.filename}` : product.photo;

  db.prepare(`
    UPDATE products SET name=?, category=?, price=?, stock=?, description=?, specs=?, photo=?
    WHERE id=?
  `).run(name, category, parseInt(price), parseInt(stock), description, specs || '[]', photo, req.params.id);

  res.json({ success: true });
});

// Видалити товар
app.delete('/api/admin/products/:id', adminAuth, (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (product?.photo) {
    const filePath = '.' + product.photo;
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Змінити наявність товару швидко
app.patch('/api/admin/products/:id/stock', adminAuth, (req, res) => {
  const { stock } = req.body;
  db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(parseInt(stock), req.params.id);
  res.json({ success: true });
});

// ── FALLBACK ──
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

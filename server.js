require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── TELEGRAM BOT ──
const bot = new TelegramBot(process.env.BOT_TOKEN || 'placeholder', { polling: false });

// ── SUPABASE ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const PHOTOS_BUCKET = 'product-photos';

// ── FILE UPLOAD (в пам'ять, потім відправляємо в Supabase Storage) ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Тільки зображення!'));
  }
});

async function uploadPhoto(file) {
  if (!file) return null;
  const ext = path.extname(file.originalname) || '.jpg';
  const fileName = `product_${Date.now()}${ext}`;
  const { error } = await supabase.storage
    .from(PHOTOS_BUCKET)
    .upload(fileName, file.buffer, { contentType: file.mimetype });
  if (error) { console.error('Upload error:', error); return null; }
  const { data } = supabase.storage.from(PHOTOS_BUCKET).getPublicUrl(fileName);
  return data.publicUrl;
}

async function deletePhoto(photoUrl) {
  if (!photoUrl) return;
  const fileName = photoUrl.split('/').pop();
  await supabase.storage.from(PHOTOS_BUCKET).remove([fileName]).catch(() => {});
}

// ── MIDDLEWARE ──
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data.map(p => ({ ...p, specs: p.specs || [] })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders', async (req, res) => {
  const { name, phone, delivery, region, city, branch, payment, items, total, telegramId } = req.body;
  if (!name || !phone || !items || !total) {
    return res.status(400).json({ error: 'Не всі поля заповнені' });
  }
  const orderNum = 'CS-' + Date.now().toString().slice(-6);
  try {
    const { error } = await supabase.from('orders').insert({
      order_num: orderNum,
      customer_name: name,
      customer_phone: phone,
      telegram_user_id: telegramId ? String(telegramId) : null,
      delivery_type: delivery,
      delivery_region: region || '',
      delivery_city: city || '',
      delivery_branch: branch || '',
      payment_type: payment,
      items: items,
      total: total,
      status: 'new'
    });
    if (error) throw error;

    // Telegram повідомлення
    const itemsList = items.map(i => `• ${i.name} ×${i.qty} = ${(i.price*i.qty).toLocaleString()} ₴`).join('\n');
    const deliveryText = delivery === 'np' ? `📦 Nova Poshta\n🏙 ${region ? region + ', ' : ''}${city}, ${branch}` : '🏠 Самовивіз (Київ)';
    const paymentText = payment === 'card' ? '💳 Карта (передоплата)' : '📬 Накладений платіж';
    const msg = `🛒 *НОВЕ ЗАМОВЛЕННЯ ${orderNum}*\n\n👤 *Клієнт:* ${name}\n📞 *Телефон:* ${phone}\n\n*Товари:*\n${itemsList}\n\n*Сума:* ${Number(total).toLocaleString()} ₴\n\n*Доставка:* ${deliveryText}\n*Оплата:* ${paymentText}`;

    if (process.env.ADMIN_CHAT_ID && process.env.BOT_TOKEN !== 'placeholder') {
      bot.sendMessage(process.env.ADMIN_CHAT_ID, msg, { parse_mode: 'Markdown' })
        .catch(err => console.error('Telegram error:', err.message));
    }

    res.json({ success: true, orderNum });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders', async (req, res) => {
  const telegramId = req.query.telegramId;
  if (!telegramId) return res.json([]);
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('telegram_user_id', String(telegramId))
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
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
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/orders/:id', adminAuth, async (req, res) => {
  const { status } = req.body;
  try {
    const { error } = await supabase.from('orders').update({ status }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/products', adminAuth, upload.single('photo'), async (req, res) => {
  const { name, category, price, stock, description, specs } = req.body;
  try {
    const photoUrl = await uploadPhoto(req.file);
    const { data, error } = await supabase.from('products').insert({
      name, category,
      price: parseInt(price),
      stock: parseInt(stock),
      description,
      specs: JSON.parse(specs || '[]'),
      photo: photoUrl
    }).select().single();
    if (error) throw error;
    res.json({ success: true, id: data.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/products/:id', adminAuth, upload.single('photo'), async (req, res) => {
  const { name, category, price, stock, description, specs } = req.body;
  try {
    const { data: product } = await supabase.from('products').select('*').eq('id', req.params.id).single();
    if (!product) return res.status(404).json({ error: 'Не знайдено' });

    let photoUrl = product.photo;
    if (req.file) {
      await deletePhoto(product.photo);
      photoUrl = await uploadPhoto(req.file);
    }

    const { error } = await supabase.from('products').update({
      name, category,
      price: parseInt(price),
      stock: parseInt(stock),
      description,
      specs: JSON.parse(specs || '[]'),
      photo: photoUrl
    }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/products/:id', adminAuth, async (req, res) => {
  try {
    const { data: product } = await supabase.from('products').select('*').eq('id', req.params.id).single();
    if (product?.photo) await deletePhoto(product.photo);
    const { error } = await supabase.from('products').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/products/:id/stock', adminAuth, async (req, res) => {
  const { stock } = req.body;
  try {
    const { error } = await supabase.from('products').update({ stock: parseInt(stock) }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FALLBACK ──
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

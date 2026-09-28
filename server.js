require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

// Текст від користувачів вставляємо в повідомлення бота як HTML — екрануємо спецсимволи.
// Раніше був Markdown: ім'я на кшталт «Anna_K» ламало розмітку, і Telegram мовчки не надсилав замовлення адміну.
const escHtml = (v) => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const uah = (n) => Number(n).toLocaleString('uk-UA') + ' ₴';

const app = express();
const PORT = process.env.PORT || 3000;

// ── ЗАХИСТ ВІД ПАДІНЬ ──
// Будь-яка неперехоплена помилка в Node 18+ вбиває процес → Render перезапускає його → 503 у пінгера.
// Логуємо й живемо далі (для веб-сервера з незалежними запитами це безпечніше, ніж падати).
process.on('unhandledRejection', (err) => console.error('⚠️ unhandledRejection:', err?.message || err));
process.on('uncaughtException', (err) => console.error('⚠️ uncaughtException:', err?.stack || err));
app.set('trust proxy', 1); // Render стоїть за проксі — щоб бачити справжній IP для ліміту запитів
app.disable('x-powered-by');

// ── TELEGRAM BOT ──
const hasRealToken = process.env.BOT_TOKEN && process.env.BOT_TOKEN !== 'placeholder';
const bot = new TelegramBot(process.env.BOT_TOKEN || 'placeholder', { polling: hasRealToken });
const APP_URL = process.env.APP_URL || '';

if (hasRealToken) {
  bot.deleteWebHook().catch(() => {});

  // Під час деплою старий і новий сервер кілька секунд опитують Telegram разом → 409 Conflict.
  // Це не аварія, але без обробника лог засмічується. Пишемо не частіше разу на хвилину.
  let lastPollLog = 0;
  bot.on('polling_error', (err) => {
    if (Date.now() - lastPollLog > 60000) { lastPollLog = Date.now(); console.warn('Telegram polling:', err.code || '', err.message); }
  });
  bot.on('error', (err) => console.error('Telegram bot error:', err.message));

  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const firstName = msg.from?.first_name || 'друже';

    const welcomeText =
      `Привіт, ${escHtml(firstName)}! 👋\n\n` +
      `Це <b>YØAKE°</b> — 3D-друковані лампи ручної роботи.\n\n` +
      `Що тут можна зробити:\n` +
      `🛒 Обрати лампу з каталогу\n` +
      `📦 Оформити замовлення з доставкою Nova Poshta або самовивозом\n` +
      `💡 Кожна лампа друкується під замовлення\n` +
      `📋 Стежити за статусом замовлення в розділі «Профіль»\n\n` +
      `Натискай кнопку нижче, щоб відкрити магазин 👇`;

    bot.sendMessage(chatId, welcomeText, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '💡 Переглянути лампи', web_app: { url: APP_URL } }
        ]]
      }
    }).catch(err => console.error('Telegram /start error:', err.message));
  });
}

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
  const fileName = `product_${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`;
  const { error } = await supabase.storage
    .from(PHOTOS_BUCKET)
    .upload(fileName, file.buffer, { contentType: file.mimetype });
  if (error) { console.error('Upload error:', error); return null; }
  const { data } = supabase.storage.from(PHOTOS_BUCKET).getPublicUrl(fileName);
  return data.publicUrl;
}

async function uploadPhotos(files) {
  if (!files || !files.length) return [];
  const urls = await Promise.all(files.map(f => uploadPhoto(f)));
  return urls.filter(Boolean);
}

async function deletePhoto(photoUrl) {
  if (!photoUrl) return;
  const fileName = photoUrl.split('/').pop();
  await supabase.storage.from(PHOTOS_BUCKET).remove([fileName]).catch(() => {});
}

async function deletePhotos(photoUrls) {
  if (!photoUrls || !photoUrls.length) return;
  const fileNames = photoUrls.filter(Boolean).map(u => u.split('/').pop());
  if (fileNames.length) await supabase.storage.from(PHOTOS_BUCKET).remove(fileNames).catch(() => {});
}

// ── MIDDLEWARE ──
app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(express.static('public', { index: false }));

// ── ЛІМІТ ЗАПИТІВ (без зайвих бібліотек) ──
// Захищає від перебору пароля адмінки і від спаму фейковими замовленнями.
function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) { h = { count: 0, reset: now + windowMs }; hits.set(key, h); }
    if (++h.count > max) {
      res.set('Retry-After', Math.ceil((h.reset - now) / 1000));
      return res.status(429).json({ error: message });
    }
    next();
  };
}
const orderLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10,  message: 'Забагато замовлень поспіль. Спробуйте за кілька хвилин.' });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Забагато спроб входу. Зачекайте 15 хвилин.' });
const apiLimiter   = rateLimit({ windowMs: 60 * 1000,      max: 120, message: 'Забагато запитів. Спробуйте за хвилину.' });
app.use('/api/', apiLimiter);

// ── ADMIN AUTH ──
// Токен сесії — підпис від пароля, а не сам пароль: навіть якщо токен украдуть, пароль лишиться невідомим
function adminSessionToken() {
  return crypto.createHmac('sha256', String(process.env.ADMIN_PASSWORD || ''))
    .update('yoake-admin-session').digest('hex');
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (process.env.ADMIN_PASSWORD && token && safeEqual(token, adminSessionToken())) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── ПЕРЕВІРКА ПІДПИСУ TELEGRAM ──
// Mini App отримує від Telegram рядок initData, підписаний токеном бота.
// Лише перевіривши підпис, можна довіряти id користувача — інакше будь-хто підставить чужий id.
function verifyInitData(initData) {
  if (!initData || !hasRealToken) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
    const sign = (p) => crypto.createHmac('sha256', secret)
      .update([...p.entries()].sort(([a],[b]) => (a < b ? -1 : 1)).map(([k,v]) => `${k}=${v}`).join('\n'))
      .digest('hex');
    // Нові версії Telegram додають поле signature — перевіряємо обидва варіанти рядка
    const withoutSig = new URLSearchParams(params); withoutSig.delete('signature');
    if (!safeEqual(sign(params), hash) && !safeEqual(sign(withoutSig), hash)) return null;
    const age = Date.now() / 1000 - Number(params.get('auth_date') || 0);
    if (!(age < 7 * 24 * 3600)) return null;
    return JSON.parse(params.get('user') || 'null');
  } catch { return null; }
}
const tgUserFrom = (req) => verifyInitData(req.headers['x-telegram-init-data']);

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
    res.json(data.map(p => ({
      ...p,
      specs: p.specs || [],
      photos: p.photos || (p.photo ? [p.photo] : []),
      colors: p.colors || []
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders', orderLimiter, async (req, res) => {
  const { name, phone, delivery, region, city, branch, payment, items } = req.body || {};
  const bad = (msg) => res.status(400).json({ error: msg });
  const str = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;

  if (!str(name, 80)) return bad("Вкажіть ім'я");
  const digits = String(phone || '').replace(/\D/g, '');
  if (!/^0\d{9}$/.test(digits) && !/^380\d{9}$/.test(digits)) return bad('Невірний номер телефону');
  if (!['np', 'pickup'].includes(delivery)) return bad('Оберіть доставку');
  if (delivery === 'np' && !(str(region, 120) && str(city, 120) && str(branch, 120))) return bad('Вкажіть адресу доставки');
  if (!['deposit', 'fop'].includes(payment)) return bad('Оберіть оплату');
  if (!Array.isArray(items) || !items.length || items.length > 30) return bad('Кошик порожній');
  if (!items.every(i => i && typeof i === 'object' && Number.isInteger(Number(i.id)) && Number(i.id) > 0)) return bad('Кошик пошкоджено — оновіть сторінку');

  try {
    // Ціни й наявність беремо з бази, а не з браузера — інакше ціну можна підмінити в запиті
    const ids = [...new Set(items.map(i => Number(i.id)))];
    const { data: prods, error: pErr } = await supabase.from('products').select('id,name,price,stock,colors').in('id', ids);
    if (pErr) throw pErr;
    const clean = [];
    for (const it of items) {
      const p = prods.find(x => x.id === Number(it.id));
      if (!p) return bad('Товар більше не продається — оновіть кошик');
      const qty = parseInt(it.qty);
      if (!(qty >= 1 && qty <= 10)) return bad('Невірна кількість');
      const colors = Array.isArray(p.colors) ? p.colors : [];
      // Назва кольору: нове поле color, або хвіст назви зі старої версії застосунку
      const colorName = (typeof it.color === 'string' && it.color) || (String(it.name || '').includes(' · ') ? String(it.name).split(' · ').pop() : null);
      const color = colorName ? colors.find(c => c.name === colorName) : null;
      if (colorName && !color) return bad('Такого кольору вже немає — оновіть кошик');
      if (!color && colors.length) return bad('Не вказано колір — оновіть кошик');
      const available = color
        ? (color.in_stock !== undefined ? !!color.in_stock : (color.stock ?? 0) > 0)
        : (p.stock ?? 0) > 0;
      if (!available) return res.status(409).json({ error: `Немає в наявності: ${p.name}${color ? ' · ' + color.name : ''}` });
      clean.push({ id: p.id, name: p.name + (color ? ` · ${color.name}` : ''), color: color ? color.name : null, price: p.price, qty });
    }
    const total = clean.reduce((sum, i) => sum + i.price * i.qty, 0);
    const tgUser = tgUserFrom(req);
    const orderNum = 'YK-' + Date.now().toString().slice(-6);

    const { error } = await supabase.from('orders').insert({
      order_num: orderNum,
      customer_name: name.trim(),
      customer_phone: String(phone).trim(),
      telegram_user_id: tgUser ? String(tgUser.id) : null,
      delivery_type: delivery,
      delivery_region: delivery === 'np' ? region.trim() : '',
      delivery_city: delivery === 'np' ? city.trim() : '',
      delivery_branch: delivery === 'np' ? branch.trim() : '',
      payment_type: payment,
      items: clean,
      total,
      status: 'new'
    });
    if (error) throw error;

    const itemsList = clean.map(i => `• ${escHtml(i.name)} ×${i.qty} = ${uah(i.price * i.qty)}`).join('\n');
    const deliveryText = delivery === 'np'
      ? `📦 Нова Пошта\n🏙 ${escHtml(region)}, ${escHtml(city)}, ${escHtml(branch)}`
      : '🏠 Самовивіз';
    const paymentText = payment === 'deposit' ? '💳 Передоплата 100 грн (доплата при отриманні)' : '🏦 Повна оплата на рахунок ФОП';
    const msg = `🛒 <b>НОВЕ ЗАМОВЛЕННЯ ${orderNum}</b>\n\n👤 <b>Клієнт:</b> ${escHtml(name)}\n📞 <b>Телефон:</b> ${escHtml(String(phone))}` +
      (tgUser?.username ? `\n✈️ <b>Telegram:</b> @${escHtml(tgUser.username)}` : '') +
      `\n\n<b>Товари:</b>\n${itemsList}\n\n<b>Сума:</b> ${uah(total)}\n\n<b>Доставка:</b> ${deliveryText}\n<b>Оплата:</b> ${paymentText}`;

    if (process.env.ADMIN_CHAT_ID && hasRealToken) {
      bot.sendMessage(process.env.ADMIN_CHAT_ID, msg, { parse_mode: 'HTML' })
        .catch(err => console.error('Telegram error:', err.message));
    }
    res.json({ success: true, orderNum, total });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders', async (req, res) => {
  // Раніше id брався з адреси запиту — будь-хто міг переглянути чужі імена, телефони й адреси
  const tgUser = tgUserFrom(req);
  if (!tgUser) return res.json([]);
  const telegramId = tgUser.id;
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

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const { password } = req.body || {};
  if (process.env.ADMIN_PASSWORD && typeof password === 'string' && safeEqual(password, process.env.ADMIN_PASSWORD)) {
    res.json({ success: true, token: adminSessionToken() });
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

// Тексти сповіщень клієнту при зміні статусу замовлення
const STATUS_MESSAGES = {
  new:       (n) => `📥 <b>Замовлення ${n}</b>\n\nМи прийняли твоє замовлення. Скоро підтвердимо деталі.`,
  confirmed: (n) => `✅ <b>Замовлення ${n} підтверджено</b>\n\nБеремо в роботу. Повідомимо, коли лампа піде на друк.`,
  printing:  (n) => `🖨 <b>Замовлення ${n} друкується</b>\n\nТвоя лампа зараз на принтері. Це займе кілька днів.`,
  shipped:   (n) => `📦 <b>Замовлення ${n} відправлено</b>\n\nПосилка вже в дорозі. ТТН надішлемо окремо.`,
  done:      (n) => `🎉 <b>Замовлення ${n} отримано</b>\n\nДякуємо за покупку! Будемо раді фото лампи у тебе вдома.`,
  cancelled: (n) => `❌ <b>Замовлення ${n} скасовано</b>\n\nЯкщо це помилка — напиши нам, розберемось.`
};

app.patch('/api/admin/orders/:id', adminAuth, async (req, res) => {
  const { status } = req.body || {};
  if (!STATUS_MESSAGES[status]) return res.status(400).json({ error: 'Невідомий статус' });
  try {
    const { data, error } = await supabase
      .from('orders')
      .update({ status })
      .eq('id', req.params.id)
      .select('order_num, telegram_user_id')
      .single();
    if (error) throw error;

    // Сповіщаємо клієнта в Telegram, якщо він оформляв замовлення через Mini App
    if (hasRealToken && data?.telegram_user_id && STATUS_MESSAGES[status]) {
      bot.sendMessage(data.telegram_user_id, STATUS_MESSAGES[status](data.order_num), { parse_mode: 'HTML' })
        .catch(err => console.error('Notify error:', err.message));
    }

    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/orders/:id', adminAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('orders').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Завантаження одного фото (для конкретного кольору) — повертає готовий URL
app.post('/api/admin/upload-photo', adminAuth, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не передано' });
    const urls = await uploadPhotos([req.file]);
    res.json({ url: urls[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/products', adminAuth, upload.array('photos', 4), async (req, res) => {
  const { name, category, price, stock, description, specs, colors } = req.body;
  try {
    const photoUrls = await uploadPhotos(req.files);
    const { data, error } = await supabase.from('products').insert({
      name, category,
      price: parseInt(price),
      stock: parseInt(stock),
      description,
      specs: JSON.parse(specs || '[]'),
      photo: photoUrls[0] || null,
      photos: photoUrls,
      colors: colors ? JSON.parse(colors) : []
    }).select().single();
    if (error) throw error;
    res.json({ success: true, id: data.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/products/:id', adminAuth, upload.array('photos', 4), async (req, res) => {
  const { name, category, price, stock, description, specs, keepPhotos, colors } = req.body;
  try {
    const { data: product } = await supabase.from('products').select('*').eq('id', req.params.id).single();
    if (!product) return res.status(404).json({ error: 'Не знайдено' });

    const existingPhotos = product.photos || (product.photo ? [product.photo] : []);
    // keepPhotos: JSON-масив URL які треба залишити (з тих що вже були)
    let keptPhotos = existingPhotos;
    if (typeof keepPhotos === 'string') {
      try { keptPhotos = JSON.parse(keepPhotos); } catch(_) { keptPhotos = existingPhotos; }
    }
    const removedPhotos = existingPhotos.filter(p => !keptPhotos.includes(p));
    if (removedPhotos.length) await deletePhotos(removedPhotos);

    const newPhotoUrls = await uploadPhotos(req.files);
    const finalPhotos = [...keptPhotos, ...newPhotoUrls].slice(0, 4);

    const { error } = await supabase.from('products').update({
      name, category,
      price: parseInt(price),
      stock: parseInt(stock),
      description,
      specs: JSON.parse(specs || '[]'),
      photo: finalPhotos[0] || null,
      photos: finalPhotos,
      colors: colors ? JSON.parse(colors) : []
    }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/products/:id', adminAuth, async (req, res) => {
  try {
    const { data: product } = await supabase.from('products').select('*').eq('id', req.params.id).single();
    const photosToDelete = product?.photos || (product?.photo ? [product.photo] : []);
    if (photosToDelete.length) await deletePhotos(photosToDelete);
    const { error } = await supabase.from('products').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/products/:id/stock', adminAuth, async (req, res) => {
  const stock = parseInt((req.body || {}).stock);
  if (!Number.isInteger(stock) || stock < 0) return res.status(400).json({ error: 'Невірна кількість' });
  try {
    const { error } = await supabase.from('products').update({ stock }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FALLBACK ──
// Легкий ендпоінт для пінгера (cron-job.org) — тримає сервіс у притомному стані.
// Віддає два байти замість цілої сторінки, щоб не перевищувати ліміт логів пінгера.
// Раз на добу пінг ще й торкається бази: безкоштовний Supabase ставить проєкт на паузу після 7 днів без запитів.
let lastDbTouch = 0;
app.get('/ping', (req, res) => {
  res.set('Cache-Control', 'no-store').type('text/plain').send('ok');
  if (Date.now() - lastDbTouch > 24 * 3600 * 1000) {
    lastDbTouch = Date.now();
    supabase.from('products').select('id').limit(1).then(({ error }) => { if (error) console.warn('DB keep-alive:', error.message); }, () => {});
  }
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── ОБРОБНИК ПОМИЛОК ──
// Ловить зламаний JSON, завеликі фото, не-картинки — і відповідає зрозуміло, а не HTML-сторінкою помилки.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Фото завелике — максимум 5 МБ' : 'Помилка завантаження фото';
    return res.status(400).json({ error: msg });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некоректні дані запиту' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Запит завеликий' });
  if (err.message === 'Тільки зображення!') return res.status(400).json({ error: err.message });
  console.error('Server error:', err.stack || err);
  res.status(500).json({ error: 'Помилка сервера' });
});

const server = app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
server.keepAliveTimeout = 65000; // довше за таймаут проксі Render — менше випадкових 502
server.headersTimeout = 66000;

// Render при деплої шле SIGTERM: зупиняємо опитування бота, щоб новий сервер не ловив 409 Conflict
function shutdown(sig) {
  console.log(`${sig}: зупиняюсь…`);
  const stopBot = hasRealToken ? bot.stopPolling({ cancel: true }).catch(() => {}) : Promise.resolve();
  stopBot.finally(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

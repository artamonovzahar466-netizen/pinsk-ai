
"use strict";

const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const OpenAI = require("openai");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;
const MODEL = process.env.OPENAI_MODEL || "gemini-3.5-flash-lite";
const OWNER_EMAIL = "artamonovzahar466@gmail.com".toLowerCase();

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : __dirname;

fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "pinsk.db");
const OLD_DB_PATH = path.join(__dirname, "pinsk.db");

if (
  DB_PATH !== OLD_DB_PATH &&
  !fs.existsSync(DB_PATH) &&
  fs.existsSync(OLD_DB_PATH)
) {
  fs.copyFileSync(OLD_DB_PATH, DB_PATH);

  for (const suffix of ["-wal", "-shm"]) {
    const oldFile = OLD_DB_PATH + suffix;
    const newFile = DB_PATH + suffix;

    if (fs.existsSync(oldFile)) {
      fs.copyFileSync(oldFile, newFile);
    }
  }

  console.log("Pinsk: старая база перенесена.");
}

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const LIMITS = {
  FREE: {
    messages: 100,
    images: 5,
    files: 5
  },
  PRO: {
    messages: Infinity,
    images: Infinity,
    files: Infinity
  },
  OWNER: {
    messages: Infinity,
    images: Infinity,
    files: Infinity
  }
};

const PLAN_FEATURES = {
  FREE: [
    "До 100 сообщений в день",
    "До 5 изображений в день",
    "До 5 файлов в день",
    "История чатов",
    "Базовые возможности Pinsk AI"
  ],
  PRO: [
    "Безлимитные сообщения",
    "Безлимитная генерация изображений (при подключённой модели)",
    "Безлимитная обработка файлов",
    "Проекты и библиотека",
    "Глубокое рассуждение",
    "Голосовое общение",
    "Расширенные инструменты"
  ],
  OWNER: [
    "Все возможности Pinsk PRO",
    "Безлимитное использование",
    "Админ-панель",
    "Управление пользователями",
    "Статистика платформы",
    "Полный доступ владельца"
  ]
};

app.set("trust proxy", 1);

app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json({ limit: "25mb" }));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'FREE',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS daily_usage (
    user_id TEXT NOT NULL,
    usage_date TEXT NOT NULL,
    messages INTEGER NOT NULL DEFAULT 0,
    images INTEGER NOT NULL DEFAULT 0,
    files INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, usage_date)
  );
`);

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`)
    .all()
    .some(item => item.name === column);
}

if (!hasColumn("conversations", "user_id")) {
  db.exec("ALTER TABLE conversations ADD COLUMN user_id TEXT");
}

if (!hasColumn("memories", "user_id")) {
  db.exec("ALTER TABLE memories ADD COLUMN user_id TEXT");
}

if (!hasColumn("users", "is_blocked")) {
  db.exec(`
    ALTER TABLE users
    ADD COLUMN is_blocked INTEGER NOT NULL DEFAULT 0
  `);
}

// Назначение владельца по подтверждённому email.
// Существующий аккаунт сохраняется.
db.prepare(`
  UPDATE users
  SET role = 'OWNER'
  WHERE lower(email) = ?
`).run(OWNER_EMAIL);

function usageDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Oral",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function makePasswordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + passwordHash(password, salt);
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") return false;

  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;

  const actual = Buffer.from(passwordHash(password, salt), "hex");
  const expected = Buffer.from(hash, "hex");

  return actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected);
}

function cookieToken(req) {
  const cookies = (req.headers.cookie || "").split(";");
  const item = cookies.find(part =>
    part.trim().startsWith("pinsk_session=")
  );

  if (!item) return null;

  try {
    return decodeURIComponent(
      item.trim().slice("pinsk_session=".length)
    );
  } catch {
    return null;
  }
}

function isHttpsRequest(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();

  return req.secure ||
    proto === "https" ||
    process.env.NODE_ENV === "production";
}

function setSessionCookie(res, token, req) {
  const secure = isHttpsRequest(req) ? "; Secure" : "";

  res.setHeader(
    "Set-Cookie",
    `pinsk_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`
  );
}

function clearSessionCookie(res, req) {
  const secure = isHttpsRequest(req) ? "; Secure" : "";

  res.setHeader(
    "Set-Cookie",
    `pinsk_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`
  );
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    plan: user.role
  };
}

function auth(req, res, next) {
  try {
    const token = cookieToken(req);

    if (!token) {
      return res.status(401).json({
        error: "Войди в аккаунт Pinsk."
      });
    }

    const session = db.prepare(`
      SELECT user_id
      FROM sessions
      WHERE token_hash = ? AND expires_at > ?
    `).get(hashToken(token), Date.now());

    if (!session) {
      clearSessionCookie(res, req);
      return res.status(401).json({
        error: "Сессия истекла. Войди в аккаунт."
      });
    }

    const user = db.prepare(`
      SELECT id, name, email, role, created_at, is_blocked
      FROM users
      WHERE id = ?
    `).get(session.user_id);

    if (!user) {
      clearSessionCookie(res, req);
      return res.status(401).json({
        error: "Аккаунт не найден."
      });
    }

    if (user.email.toLowerCase() === OWNER_EMAIL && user.role !== "OWNER") {
      db.prepare("UPDATE users SET role = 'OWNER' WHERE id = ?")
        .run(user.id);
      user.role = "OWNER";
    }

    if (user.is_blocked) {
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
      clearSessionCookie(res, req);

      return res.status(403).json({
        error: "Аккаунт заблокирован администратором."
      });
    }

    req.user = user;
    next();

  } catch (error) {
    console.error("Auth error:", error);
    res.status(500).json({
      error: "Ошибка проверки авторизации."
    });
  }
}

function requireOwner(req, res, next) {
  if (req.user?.role !== "OWNER") {
    return res.status(403).json({
      error: "Доступ разрешён только владельцу Pinsk."
    });
  }

  next();
}

function issueSession(user, res, req) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;

  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (?, ?, ?)
  `).run(hashToken(token), user.id, expiresAt);

  setSessionCookie(res, token, req);
}

// РЕГИСТРАЦИЯ

app.post("/api/auth/register", (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (name.length < 2 || name.length > 50) {
      return res.status(400).json({
        error: "Имя должно содержать от 2 до 50 символов."
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Введи правильный email." });
    }

    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({
        error: "Пароль должен содержать от 8 до 128 символов."
      });
    }

    const existing = db.prepare(
      "SELECT id FROM users WHERE email = ?"
    ).get(email);

    if (existing) {
      return res.status(409).json({
        error: "Аккаунт уже существует. Используй вход."
      });
    }

    const id = crypto.randomUUID();
    const role = email === OWNER_EMAIL ? "OWNER" : "FREE";

    db.prepare(`
      INSERT INTO users (id, name, email, password_hash, role)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, name, email, makePasswordHash(password), role);

    const user = db.prepare(`
      SELECT id, name, email, role, created_at
      FROM users WHERE id = ?
    `).get(id);

    issueSession(user, res, req);

    res.json({
      success: true,
      user: publicUser(user)
    });

  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ error: "Не удалось создать аккаунт." });
  }
});

// ВХОД

app.post("/api/auth/login", (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const user = db.prepare(
      "SELECT * FROM users WHERE email = ?"
    ).get(email);

    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({
        error: "Неверный email или пароль."
      });
    }

    if (user.is_blocked) {
      return res.status(403).json({
        error: "Аккаунт заблокирован администратором."
      });
    }

    if (email === OWNER_EMAIL && user.role !== "OWNER") {
      db.prepare("UPDATE users SET role = 'OWNER' WHERE id = ?")
        .run(user.id);
      user.role = "OWNER";
    }

    issueSession(user, res, req);

    res.setHeader("Cache-Control", "no-store");

    res.json({
      success: true,
      user: publicUser(user)
    });

  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Ошибка входа." });
  }
});

// ТЕКУЩИЙ ПОЛЬЗОВАТЕЛЬ

app.get("/api/auth/me", auth, (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  // Повторно читаем актуальную роль непосредственно из базы.
  const user = db.prepare(`
    SELECT id, name, email, role, created_at, is_blocked
    FROM users WHERE id = ?
  `).get(req.user.id);

  if (!user) {
    return res.status(401).json({ error: "Аккаунт не найден." });
  }

  res.json({ user: publicUser(user) });
});

// ВЫХОД

app.post("/api/auth/logout", (req, res) => {
  const token = cookieToken(req);

  if (token) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?")
      .run(hashToken(token));
  }

  clearSessionCookie(res, req);
  res.json({ success: true });
});

db.prepare("DELETE FROM sessions WHERE expires_at <= ?")
  .run(Date.now());

// АДМИН: СТАТИСТИКА

app.get("/api/admin/stats", auth, requireOwner, (req, res) => {
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN role = 'FREE' THEN 1 ELSE 0 END) AS free,
      SUM(CASE WHEN role = 'PRO' THEN 1 ELSE 0 END) AS pro,
      SUM(CASE WHEN role = 'OWNER' THEN 1 ELSE 0 END) AS owners,
      SUM(CASE WHEN is_blocked = 1 THEN 1 ELSE 0 END) AS blocked
    FROM users
  `).get();

  res.json(stats);
});

// АДМИН: ПОЛЬЗОВАТЕЛИ

app.get("/api/admin/users", auth, requireOwner, (req, res) => {
  const search = String(req.query.search || "").trim();

  const users = db.prepare(`
    SELECT id, name, email, role, is_blocked, created_at
    FROM users
    WHERE name LIKE ? OR email LIKE ?
    ORDER BY created_at DESC
    LIMIT 200
  `).all(`%${search}%`, `%${search}%`);

  res.json(users);
});

// АДМИН: ИЗМЕНЕНИЕ ПОЛЬЗОВАТЕЛЯ

app.patch("/api/admin/users/:id", auth, requireOwner, (req, res) => {
  const id = String(req.params.id);

  const target = db.prepare(
    "SELECT * FROM users WHERE id = ?"
  ).get(id);

  if (!target) {
    return res.status(404).json({ error: "Пользователь не найден." });
  }

  if (target.role === "OWNER" || target.id === req.user.id) {
    return res.status(403).json({
      error: "Нельзя изменять аккаунт владельца."
    });
  }

  const updates = {};

  if (req.body.role !== undefined) {
    if (!["FREE", "PRO"].includes(req.body.role)) {
      return res.status(400).json({
        error: "Можно назначить только FREE или PRO."
      });
    }
    updates.role = req.body.role;
  }

  if (req.body.is_blocked !== undefined) {
    if (typeof req.body.is_blocked !== "boolean") {
      return res.status(400).json({
        error: "Некорректное значение блокировки."
      });
    }
    updates.is_blocked = req.body.is_blocked ? 1 : 0;
  }

  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: "Нет изменений." });
  }

  const set = Object.keys(updates)
    .map(key => `${key} = @${key}`)
    .join(", ");

  db.prepare(`UPDATE users SET ${set} WHERE id = ?`)
    .run(...Object.values(updates), id);

  if (updates.is_blocked === 1) {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
  }

  const updated = db.prepare(`
    SELECT id, name, email, role, is_blocked, created_at
    FROM users WHERE id = ?
  `).get(id);

  res.json({ success: true, user: updated });
});

// ИСПОЛЬЗОВАНИЕ

function getUsage(userId) {
  return db.prepare(`
    SELECT messages, images, files
    FROM daily_usage
    WHERE user_id = ? AND usage_date = ?
  `).get(userId, usageDate()) || {
    messages: 0,
    images: 0,
    files: 0
  };
}

const reserveMessage = db.transaction(userId => {
  const date = usageDate();
  const current = getUsage(userId);

  if (current.messages >= LIMITS.FREE.messages) return false;

  db.prepare(`
    INSERT INTO daily_usage (user_id, usage_date, messages, images, files)
    VALUES (?, ?, 1, 0, 0)
    ON CONFLICT(user_id, usage_date)
    DO UPDATE SET messages = messages + 1
  `).run(userId, date);

  return true;
});

function releaseMessage(userId) {
  db.prepare(`
    UPDATE daily_usage
    SET messages = CASE WHEN messages > 0 THEN messages - 1 ELSE 0 END
    WHERE user_id = ? AND usage_date = ?
  `).run(userId, usageDate());
}

function limitsFor(user) {
  return LIMITS[user.role] || LIMITS.FREE;
}

function serializableLimits(limits) {
  return {
    messages: limits.messages === Infinity ? "unlimited" : limits.messages,
    images: limits.images === Infinity ? "unlimited" : limits.images,
    files: limits.files === Infinity ? "unlimited" : limits.files
  };
}

// СТАТУС

app.get("/api/status", (req, res) => {
  res.json({
    name: "Pinsk AI",
    server: "online",
    model: MODEL,
    apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY)
  });
});

// ТАРИФЫ

app.get("/api/plans", (req, res) => {
  res.json({
    plans: {
      FREE: {
        name: "FREE",
        price: 0,
        period: "навсегда",
        limits: serializableLimits(LIMITS.FREE),
        features: PLAN_FEATURES.FREE
      },
      PRO: {
        name: "Pinsk PRO",
        monthlyPrice: 2990,
        annualPrice: 30498,
        period: "KZT",
        limits: serializableLimits(LIMITS.PRO),
        features: PLAN_FEATURES.PRO
      },
      OWNER: {
        name: "OWNER",
        price: 0,
        limits: serializableLimits(LIMITS.OWNER),
        features: PLAN_FEATURES.OWNER
      }
    },
    paymentEnabled: false
  });
});

// ЛИМИТЫ

app.get("/api/limits", auth, (req, res) => {
  res.json({
    plan: req.user.role,
    limits: serializableLimits(limitsFor(req.user))
  });
});

// ИСПОЛЬЗОВАНИЕ

app.get("/api/usage", auth, (req, res) => {
  const used = getUsage(req.user.id);
  const limits = limitsFor(req.user);

  res.json({
    plan: req.user.role,
    date: usageDate(),
    used,
    limits: serializableLimits(limits),
    remaining: {
      messages: limits.messages === Infinity
        ? "unlimited"
        : Math.max(0, limits.messages - used.messages),
      images: limits.images === Infinity
        ? "unlimited"
        : Math.max(0, limits.images - used.images),
      files: limits.files === Infinity
        ? "unlimited"
        : Math.max(0, limits.files - used.files)
    }
  });
});

// ПЛАГИНЫ: КАТАЛОГ.
// Реальные внешние интеграции требуют отдельных подключений и ключей.

app.get("/api/plugins", auth, (req, res) => {
  res.json({
    plugins: [
      {
        id: "web-search",
        name: "Поиск в интернете",
        description: "Подключение поиска актуальной информации.",
        status: "not_connected"
      },
      {
        id: "data-analysis",
        name: "Анализ данных",
        description: "Анализ CSV, таблиц и текстовых файлов.",
        status: "available"
      },
      {
        id: "workspace",
        name: "Рабочее пространство",
        description: "Проекты и библиотека Pinsk.",
        status: "available"
      }
    ]
  });
});

// ИСТОРИЯ ЧАТОВ

app.get("/api/history", auth, (req, res) => {
  res.json(db.prepare(`
    SELECT id, title, created_at
    FROM conversations
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(req.user.id));
});

app.get("/api/history/:id", auth, (req, res) => {
  const conversation = db.prepare(`
    SELECT id FROM conversations
    WHERE id = ? AND user_id = ?
  `).get(req.params.id, req.user.id);

  if (!conversation) {
    return res.status(404).json({ error: "Чат не найден." });
  }

  res.json(db.prepare(`
    SELECT role, content, created_at
    FROM messages
    WHERE conversation_id = ?
    ORDER BY id ASC
  `).all(req.params.id));
});

// ПАМЯТЬ

app.post("/api/memory", auth, (req, res) => {
  const content = String(req.body.content || "").trim();

  if (!content) {
    return res.status(400).json({ error: "Пустая память." });
  }

  const result = db.prepare(`
    INSERT INTO memories (user_id, content)
    VALUES (?, ?)
  `).run(req.user.id, content);

  res.json({ success: true, id: result.lastInsertRowid });
});

app.get("/api/memory", auth, (req, res) => {
  res.json(db.prepare(`
    SELECT id, content, created_at
    FROM memories
    WHERE user_id = ?
    ORDER BY id DESC
  `).all(req.user.id));
});

app.delete("/api/memory/:id", auth, (req, res) => {
  db.prepare(`
    DELETE FROM memories
    WHERE id = ? AND user_id = ?
  `).run(req.params.id, req.user.id);

  res.json({ success: true });
});

// ПОДКЛЮЧЕНИЕ ИИ

const ai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  ...(process.env.OPENAI_BASE_URL
    ? { baseURL: process.env.OPENAI_BASE_URL }
    : {})
});

async function askAI(messages) {
  const response = await ai.chat.completions.create({
    model: MODEL,
    messages
  });

  return response.choices[0]?.message?.content ||
    "Не удалось получить ответ.";
}

// ЧАТ

app.post("/api/chat", auth, async (req, res) => {
  const userId = req.user.id;
  let reserved = false;

  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({
        error: "Не настроен API-ключ Pinsk."
      });
    }

    const message = String(req.body.message || "").trim();
    const conversationId = String(
      req.body.conversationId || crypto.randomUUID()
    );

    if (!message) {
      return res.status(400).json({ error: "Сообщение пустое." });
    }

    if (message.length > 12000) {
      return res.status(400).json({ error: "Сообщение слишком длинное." });
    }

    const limits = limitsFor(req.user);

    if (limits.messages !== Infinity) {
      reserved = reserveMessage(userId);

      if (!reserved) {
        return res.status(429).json({
          error: "Дневной лимит сообщений исчерпан.",
          code: "DAILY_LIMIT_REACHED",
          plan: req.user.role,
          used: getUsage(userId).messages,
          limit: limits.messages
        });
      }
    }

    const conversation = db.prepare(`
      SELECT id, user_id FROM conversations WHERE id = ?
    `).get(conversationId);

    if (conversation && conversation.user_id !== userId) {
      if (conversation.user_id === null) {
        db.prepare(`
          UPDATE conversations SET user_id = ? WHERE id = ?
        `).run(userId, conversationId);
      } else {
        if (reserved) releaseMessage(userId);
        return res.status(403).json({ error: "Нет доступа к этому чату." });
      }
    }

    if (!conversation) {
      db.prepare(`
        INSERT INTO conversations (id, title, user_id)
        VALUES (?, ?, ?)
      `).run(conversationId, message.slice(0, 60), userId);
    }

    db.prepare(`
      INSERT INTO messages (conversation_id, role, content)
      VALUES (?, 'user', ?)
    `).run(conversationId, message);

    const recentMessages = db.prepare(`
      SELECT role, content
      FROM messages
      WHERE conversation_id = ?
      ORDER BY id DESC
      LIMIT 15
    `).all(conversationId).reverse();

    const savedMemories = db.prepare(`
      SELECT content FROM memories
      WHERE user_id = ?
      ORDER BY id DESC LIMIT 30
    `).all(userId);

    const context = savedMemories.map(item => item.content).join("\n");

    const answer = await askAI([
      {
        role: "system",
        content:
          "Ты Pinsk — ИИ-ассистент. Отвечай полезно, точно и на языке пользователя. " +
          "Не выдумывай факты. Учитывай сохранённую память, если она относится к вопросу.\n\n" +
          "ПАМЯТЬ:\n" + context.slice(0, 10000)
      },
      ...recentMessages
    ]);

    db.prepare(`
      INSERT INTO messages (conversation_id, role, content)
      VALUES (?, 'assistant', ?)
    `).run(conversationId, answer);

    const usage = getUsage(userId);

    res.json({
      answer,
      conversationId,
      model: MODEL,
      usage: {
        plan: req.user.role,
        messagesUsed: usage.messages,
        messagesLimit: limits.messages === Infinity
          ? "unlimited"
          : limits.messages,
        messagesRemaining: limits.messages === Infinity
          ? "unlimited"
          : Math.max(0, limits.messages - usage.messages)
      }
    });

  } catch (error) {
    console.error("Pinsk AI error:", error);

    if (reserved) releaseMessage(userId);

    res.status(500).json({
      error: "Ошибка ИИ-сервера. Проверь настройки модели и API."
    });
  }
});

// АНАЛИЗ ДАННЫХ

app.post("/api/analysis", auth, async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({
        error: "ИИ-модель не настроена на сервере."
      });
    }

    const content = String(req.body.content || "").trim();
    const question = String(
      req.body.question || "Проанализируй эти данные и сделай выводы."
    ).trim();

    if (!content) {
      return res.status(400).json({
        error: "Нет данных для анализа."
      });
    }

    if (content.length > 100000) {
      return res.status(413).json({
        error: "Файл слишком большой для анализа."
      });
    }

    const answer = await askAI([
      {
        role: "system",
        content:
          "Ты аналитик данных Pinsk. Анализируй предоставленные таблицы и текст. " +
          "Находи закономерности, ошибки, тенденции, сравнения и делай выводы. " +
          "Не выдумывай отсутствующие значения. Если данных недостаточно, сообщи об этом."
      },
      {
        role: "user",
        content: question + "\n\nДАННЫЕ:\n" + content
      }
    ]);

    res.json({ success: true, answer });

  } catch (error) {
    console.error("Data analysis error:", error);
    res.status(500).json({
      error: "Не удалось выполнить анализ данных."
    });
  }
});

// САЙТ

app.use(express.static(__dirname, {
  index: "index.html"
}));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ОБРАБОТКА ОШИБОК

app.use((error, req, res, next) => {
  console.error("Express error:", error);

  if (res.headersSent) return next(error);

  res.status(500).json({
    error: "Внутренняя ошибка сервера."
  });
});

// ЗАПУСК

app.listen(PORT, () => {
  console.log("================================");
  console.log("          PINSK AI");
  console.log("================================");
  console.log("Порт:", PORT);
  console.log("База данных:", DB_PATH);
  console.log("Модель:", MODEL);
  console.log("OWNER:", OWNER_EMAIL);
  console.log("FREE: 100 сообщений в день");
  console.log("PRO: безлимит");
  console.log("OWNER: безлимит");
  console.log("Анализ данных API: включён");
  console.log("Админ API: включён");
  console.log("================================");
});

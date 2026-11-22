
"use strict";

const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const OpenAI = require("openai");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

dotenv.config();

const app = express();
const db = new Database(path.join(__dirname, "pinsk.db"));

const OWNER_EMAIL = "artamonovzahar466@gmail.com".toLowerCase();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.OPENAI_MODEL || "gemini-3.5-flash-lite";

const LIMITS = {
  FREE: { messages: 100, images: 5, files: 5 },
  PRO: { messages: Infinity, images: 10, files: 10 },
  OWNER: { messages: Infinity, images: Infinity, files: Infinity }
};

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "20mb" }));

db.pragma("journal_mode = WAL");

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
  db.exec("ALTER TABLE users ADD COLUMN is_blocked INTEGER NOT NULL DEFAULT 0");
}

// Автоматически назначаем OWNER нужному аккаунту.
db.prepare(`
  UPDATE users
  SET role = 'OWNER'
  WHERE email = ? COLLATE NOCASE
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

// Установка защищённой cookie для HTTPS.
function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production"
    ? "; Secure"
    : "";

  res.setHeader(
    "Set-Cookie",
    `pinsk_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`
  );
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production"
    ? "; Secure"
    : "";

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
  const token = cookieToken(req);

  if (!token) {
    return res.status(401).json({
      error: "Войди в аккаунт Pinsk."
    });
  }

  const session = db.prepare(`
    SELECT user_id FROM sessions
    WHERE token_hash = ? AND expires_at > ?
  `).get(hashToken(token), Date.now());

  if (!session) {
    clearSessionCookie(res);

    return res.status(401).json({
      error: "Сессия истекла. Войди снова."
    });
  }

  const user = db.prepare(`
    SELECT id, name, email, role, created_at, is_blocked
    FROM users
    WHERE id = ?
  `).get(session.user_id);

  if (!user) {
    return res.status(401).json({
      error: "Аккаунт не найден."
    });
  }

  if (user.is_blocked) {
    db.prepare("DELETE FROM sessions WHERE user_id = ?")
      .run(user.id);

    clearSessionCookie(res);

    return res.status(403).json({
      error: "Аккаунт заблокирован администратором."
    });
  }

  req.user = user;
  next();
}

function requireOwner(req, res, next) {
  if (!req.user || req.user.role !== "OWNER") {
    return res.status(403).json({
      error: "Доступ разрешён только владельцу Pinsk."
    });
  }

  next();
}

function issueSession(user, res) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;

  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (?, ?, ?)
  `).run(hashToken(token), user.id, expiresAt);

  setSessionCookie(res, token);
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
      return res.status(400).json({
        error: "Введи правильный email."
      });
    }

    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({
        error: "Пароль должен содержать от 8 до 128 символов."
      });
    }

    if (db.prepare("SELECT id FROM users WHERE email = ?").get(email)) {
      return res.status(409).json({
        error: "Аккаунт с таким email уже существует."
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
      FROM users
      WHERE id = ?
    `).get(id);

    issueSession(user, res);

    res.json({
      success: true,
      user: publicUser(user)
    });

  } catch (error) {
    console.error("Registration error:", error);

    res.status(500).json({
      error: "Не удалось создать аккаунт."
    });
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

    // Дополнительная проверка владельца.
    if (email === OWNER_EMAIL && user.role !== "OWNER") {
      db.prepare(`
        UPDATE users SET role = 'OWNER'
        WHERE id = ?
      `).run(user.id);

      user.role = "OWNER";
    }

    issueSession(user, res);

    res.json({
      success: true,
      user: publicUser(user)
    });

  } catch (error) {
    console.error("Login error:", error);

    res.status(500).json({
      error: "Ошибка входа."
    });
  }
});

// ТЕКУЩИЙ ПОЛЬЗОВАТЕЛЬ
app.get("/api/auth/me", auth, (req, res) => {
  res.json({
    user: publicUser(req.user)
  });
});

// ВЫХОД
app.post("/api/auth/logout", (req, res) => {
  const token = cookieToken(req);

  if (token) {
    db.prepare(`
      DELETE FROM sessions
      WHERE token_hash = ?
    `).run(hashToken(token));
  }

  clearSessionCookie(res);

  res.json({ success: true });
});

// УДАЛЕНИЕ ПРОСРОЧЕННЫХ СЕССИЙ
db.prepare(`
  DELETE FROM sessions
  WHERE expires_at <= ?
`).run(Date.now());

// АДМИН-ПАНЕЛЬ: СТАТИСТИКА
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

// АДМИН-ПАНЕЛЬ: ПОЛЬЗОВАТЕЛИ
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

// АДМИН-ПАНЕЛЬ: ИЗМЕНЕНИЕ ТАРИФА И БЛОКИРОВКА
app.patch("/api/admin/users/:id", auth, requireOwner, (req, res) => {
  const id = String(req.params.id);

  const target = db.prepare(
    "SELECT * FROM users WHERE id = ?"
  ).get(id);

  if (!target) {
    return res.status(404).json({
      error: "Пользователь не найден."
    });
  }

  if (target.role === "OWNER" || target.id === req.user.id) {
    return res.status(403).json({
      error: "Нельзя изменять или блокировать аккаунт владельца."
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
    return res.status(400).json({
      error: "Нет изменений."
    });
  }

  const set = Object.keys(updates)
    .map(key => `${key} = @${key}`)
    .join(", ");

  db.prepare(`
    UPDATE users
    SET ${set}
    WHERE id = @id
  `).run({
    ...updates,
    id
  });

  if (updates.is_blocked === 1) {
    db.prepare("DELETE FROM sessions WHERE user_id = ?")
      .run(id);
  }

  const updated = db.prepare(`
    SELECT id, name, email, role, is_blocked, created_at
    FROM users
    WHERE id = ?
  `).get(id);

  res.json({
    success: true,
    user: updated
  });
});

// ИСПОЛЬЗОВАНИЕ И ЛИМИТЫ
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

  if (current.messages >= LIMITS.FREE.messages) {
    return false;
  }

  db.prepare(`
    INSERT INTO daily_usage
      (user_id, usage_date, messages, images, files)
    VALUES (?, ?, 1, 0, 0)
    ON CONFLICT(user_id, usage_date)
    DO UPDATE SET messages = messages + 1
  `).run(userId, date);

  return true;
});

function releaseMessage(userId) {
  db.prepare(`
    UPDATE daily_usage
    SET messages = CASE
      WHEN messages > 0 THEN messages - 1
      ELSE 0
    END
    WHERE user_id = ? AND usage_date = ?
  `).run(userId, usageDate());
}

function limitsFor(user) {
  return LIMITS[user.role] || LIMITS.FREE;
}

// СТАТУС СЕРВЕРА
app.get("/api/status", (req, res) => {
  res.json({
    name: "Pinsk",
    server: "online",
    model: MODEL,
    apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY)
  });
});

// ЛИМИТЫ
app.get("/api/limits", auth, (req, res) => {
  res.json({
    plan: req.user.role,
    limits: limitsFor(req.user)
  });
});

// ИСПОЛЬЗОВАНИЕ
app.get("/api/usage", auth, (req, res) => {
  const used = getUsage(req.user.id);
  const limits = limitsFor(req.user);

  const convert = value =>
    value === Infinity ? "unlimited" : value;

  res.json({
    plan: req.user.role,
    date: usageDate(),
    used,
    limits: {
      messages: convert(limits.messages),
      images: convert(limits.images),
      files: convert(limits.files)
    },
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
    SELECT id
    FROM conversations
    WHERE id = ? AND user_id = ?
  `).get(req.params.id, req.user.id);

  if (!conversation) {
    return res.status(404).json({
      error: "Чат не найден."
    });
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
    return res.status(400).json({
      error: "Пустая память."
    });
  }

  const result = db.prepare(`
    INSERT INTO memories (user_id, content)
    VALUES (?, ?)
  `).run(req.user.id, content);

  res.json({
    success: true,
    id: result.lastInsertRowid
  });
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

// ЧАТ С ИИ
app.post("/api/chat", auth, async (req, res) => {
  const startedAt = Date.now();
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
      return res.status(400).json({
        error: "Сообщение пустое."
      });
    }

    if (message.length > 12000) {
      return res.status(400).json({
        error: "Сообщение слишком длинное."
      });
    }

    const role = req.user.role;
    const limits = limitsFor(req.user);

    if (limits.messages !== Infinity) {
      reserved = reserveMessage(userId);

      if (!reserved) {
        return res.status(429).json({
          error: "Дневной лимит сообщений исчерпан.",
          code: "DAILY_LIMIT_REACHED",
          plan: role,
          used: getUsage(userId).messages,
          limit: limits.messages
        });
      }
    }

    let conversation = db.prepare(`
      SELECT id, user_id
      FROM conversations
      WHERE id = ?
    `).get(conversationId);

    if (conversation && conversation.user_id !== userId) {
      if (conversation.user_id === null) {
        db.prepare(`
          UPDATE conversations
          SET user_id = ?
          WHERE id = ?
        `).run(userId, conversationId);
      } else {
        if (reserved) releaseMessage(userId);

        return res.status(403).json({
          error: "Нет доступа к этому чату."
        });
      }
    }

    if (!conversation) {
      db.prepare(`
        INSERT INTO conversations (id, title, user_id)
        VALUES (?, ?, ?)
      `).run(
        conversationId,
        message.slice(0, 60),
        userId
      );
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
      SELECT content
      FROM memories
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 50
    `).all(userId);

    const oldMessages = db.prepare(`
      SELECT m.content
      FROM messages m
      JOIN conversations c
        ON c.id = m.conversation_id
      WHERE c.user_id = ?
        AND m.conversation_id != ?
        AND m.role = 'user'
      ORDER BY m.id DESC
      LIMIT 30
    `).all(userId, conversationId);

    const context = [
      ...savedMemories.map(item => item.content),
      ...oldMessages.map(item => item.content)
    ].join("\n");

    const response = await ai.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: "system",
          content:
            "Ты Pinsk — самостоятельный ИИ-ассистент. " +
            "Отвечай полезно, честно и на языке пользователя. " +
            "Используй контекст памяти, если он помогает. " +
            "Не выдумывай воспоминания.\n\n" +
            "ПАМЯТЬ И ПРОШЛЫЕ РАЗГОВОРЫ:\n" +
            context.slice(0, 12000)
        },
        ...recentMessages
      ]
    });

    const answer =
      response.choices[0]?.message?.content ||
      "Не удалось получить ответ.";

    db.prepare(`
      INSERT INTO messages (conversation_id, role, content)
      VALUES (?, 'assistant', ?)
    `).run(conversationId, answer);

    const usage = getUsage(userId);

    res.json({
      answer,
      conversationId,
      model: MODEL,
      processingTimeMs: Date.now() - startedAt,
      usage: {
        plan: role,
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

    if (reserved) {
      releaseMessage(userId);
    }

    res.status(500).json({
      error: "Ошибка ИИ-сервера. Проверь настройки модели."
    });
  }
});

// САЙТ
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/style.css", (req, res) => {
  res.sendFile(path.join(__dirname, "style.css"));
});

app.get("/app.js", (req, res) => {
  res.sendFile(path.join(__dirname, "app.js"));
});

// ЗАПУСК
app.listen(PORT, () => {
  console.log("================================");
  console.log("       PINSK AI SERVER");
  console.log("================================");
  console.log(`Сервер запущен: http://localhost:${PORT}`);
  console.log("Gemini:", MODEL);
  console.log("OWNER:", OWNER_EMAIL);
  console.log("FREE: 100 сообщений в день");
  console.log("Админ API: включён");
  console.log("================================");
});

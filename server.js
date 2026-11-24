
"use strict";

const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const XLSX = require("xlsx");

const {
  initGeminiKeysTable,
  getAllKeys,
  insertKey,
  toggleKeyActive,
  deleteKey,
  executeWithKeyRotation
} = require("./key-manager");

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;
const MODEL = process.env.OPENAI_MODEL || "gemini-3.5-flash-lite";
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const OWNER_EMAIL = "artamonovzahar466@gmail.com".toLowerCase();


// ==========================================
// RESEND EMAIL API
// ==========================================

async function sendVerificationEmail(email, code) {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    throw new Error("RESEND_API_KEY не настроен в Render.");
  }

  const from = process.env.RESEND_FROM || "Pinsk AI <onboarding@resend.dev>";

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#222">
      <h2 style="text-align:center">Pinsk AI</h2>
      <p>Для подтверждения электронной почты введи этот код:</p>
      <div style="font-size:34px;font-weight:bold;letter-spacing:9px;text-align:center;padding:22px;background:#f2f4f8;border-radius:12px">
        ${code}
      </div>
      <p>Код действует <b>10 минут</b>.</p>
      <p style="color:#777;font-size:13px">Если ты не регистрировался в Pinsk AI, проигнорируй это письмо.</p>
    </div>
  `;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: "Код подтверждения Pinsk AI",
      text:
        `Твой код подтверждения Pinsk AI: ${code}\n\n` +
        "Код действует 10 минут.\n" +
        "Если ты не регистрировался в Pinsk AI, просто проигнорируй это письмо.",
      html
    }),
    signal: AbortSignal.timeout(20000)
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      result.message || result.error || `Resend HTTP ${response.status}`
    );
  }

  return result;
}


const LEGACY_API_KEY = process.env.OPENAI_API_KEY;

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

initGeminiKeysTable(db);

if (LEGACY_API_KEY && getAllKeys(db).length === 0) {
  try {
    insertKey(db, LEGACY_API_KEY.trim());
    console.log("Pinsk: старый API-ключ перенесён в менеджер.");
  } catch (error) {
    console.error("Не удалось перенести старый API-ключ:", error.message);
  }
}

function getGeminiKeys() {
  return getAllKeys(db);
}

function isKeyActive(key) {
  if (key.is_active !== undefined) return Boolean(key.is_active);
  if (key.active !== undefined) return Boolean(key.active);
  if (key.enabled !== undefined) return Boolean(key.enabled);
  return true;
}

function hasActiveGeminiKeys() {
  return getGeminiKeys().some(isKeyActive);
}

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
    "Безлимитная генерация изображений",
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

app.use(express.urlencoded({
  extended: true,
  limit: "25mb"
}));

// ==========================================
// ЗАГРУЗКА ФАЙЛОВ
// ==========================================

const MAX_FILE_SIZE = 12 * 1024 * 1024;
const MAX_FILES = 5;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES
  },
  fileFilter(req, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();

    const allowed = [
      ".png", ".jpg", ".jpeg", ".jfif", ".webp", ".gif",
      ".pdf", ".docx", ".xlsx", ".xls", ".csv",
      ".txt", ".md", ".json", ".html", ".xml", ".log"
    ];

    if (!allowed.includes(extension)) {
      return callback(
        new Error("Формат файла не поддерживается: " + extension)
      );
    }

    callback(null, true);
  }
});

function safeFileName(name) {
  return path.basename(String(name || "file"))
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .slice(0, 150);
}

function isImage(file) {
  return [
    ".png", ".jpg", ".jpeg", ".jfif", ".webp", ".gif"
  ].includes(path.extname(file.originalname).toLowerCase());
}

async function extractFileText(file) {
  const extension = path.extname(file.originalname).toLowerCase();

  if (isImage(file)) return "";

  if (extension === ".pdf") {
    const result = await pdfParse(file.buffer);
    return result.text || "";
  }

  if (extension === ".docx") {
    const result = await mammoth.extractRawText({
      buffer: file.buffer
    });
    return result.value || "";
  }

  if (extension === ".xlsx" || extension === ".xls") {
    const workbook = XLSX.read(file.buffer, { type: "buffer" });

    return workbook.SheetNames.map(sheetName => {
      return (
        "Лист: " + sheetName + "\n" +
        XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName])
      );
    }).join("\n\n");
  }

  if (extension === ".csv") {
    const workbook = XLSX.read(file.buffer, {
      type: "buffer",
      raw: false
    });

    return workbook.SheetNames.map(sheetName => {
      return (
        "Лист: " + sheetName + "\n" +
        XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName])
      );
    }).join("\n\n");
  }

  return file.buffer.toString("utf8");
}

function fileMime(file) {
  const extension = path.extname(file.originalname).toLowerCase();

  const types = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".jfif": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif"
  };

  return types[extension] || file.mimetype || "application/octet-stream";
}

// ==========================================
// БАЗА ДАННЫХ
// ==========================================

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

db.exec(`
  CREATE TABLE IF NOT EXISTS email_verifications (
    email TEXT PRIMARY KEY COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_sent_at INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
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

db.prepare(`
  UPDATE users
  SET role = 'OWNER'
  WHERE lower(email) = ?
`).run(OWNER_EMAIL);

// ==========================================
// ОБЩИЕ ФУНКЦИИ
// ==========================================

function usageDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Oral",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function hashToken(token) {
  return crypto.createHash("sha256")
    .update(token)
    .digest("hex");
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

// ==========================================
// АВТОРИЗАЦИЯ
// ==========================================

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

    if (
      user.email.toLowerCase() === OWNER_EMAIL &&
      user.role !== "OWNER"
    ) {
      db.prepare("UPDATE users SET role = 'OWNER' WHERE id = ?")
        .run(user.id);

      user.role = "OWNER";
    }

    if (user.is_blocked) {
      db.prepare("DELETE FROM sessions WHERE user_id = ?")
        .run(user.id);

      clearSessionCookie(res, req);

      return res.status(403).json({
        error: "Аккаунт заблокирован администратором."
      });
    }

    req.user = user;
    next();

  } catch (error) {
    console.error("Auth error:", error.message);

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

// ==========================================
// РЕГИСТРАЦИЯ С EMAIL-ПОДТВЕРЖДЕНИЕМ
// ==========================================

app.post("/api/auth/register", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (name.length < 2 || name.length > 50) {
      return res.status(400).json({
        error: "Имя должно содержать от 2 до 50 символов."
      });
    }

    if (
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return res.status(400).json({
        error: "Введи правильный email."
      });
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

    const now = Date.now();

    const pending = db.prepare(`
      SELECT last_sent_at
      FROM email_verifications
      WHERE email = ?
    `).get(email);

    if (pending && now - pending.last_sent_at < 60000) {
      return res.status(429).json({
        error: "Подожди минуту перед повторной отправкой кода."
      });
    }

    const code = String(
      crypto.randomInt(100000, 1000000)
    );

    const codeHash = crypto.createHash("sha256")
      .update(code)
      .digest("hex");

    const storedPassword = makePasswordHash(password);

    db.prepare(`
      INSERT INTO email_verifications (
        email,
        name,
        password_hash,
        code_hash,
        expires_at,
        attempts,
        last_sent_at
      )
      VALUES (?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(email) DO UPDATE SET
        name = excluded.name,
        password_hash = excluded.password_hash,
        code_hash = excluded.code_hash,
        expires_at = excluded.expires_at,
        attempts = 0,
        last_sent_at = excluded.last_sent_at
    `).run(
      email,
      name,
      storedPassword,
      codeHash,
      now + 10 * 60 * 1000,
      now
    );

    try {
      await sendVerificationEmail(email, code);
    } catch (mailError) {
      console.error("Verification email error:", mailError.message);

      db.prepare(`
        DELETE FROM email_verifications
        WHERE email = ?
      `).run(email);

      return res.status(503).json({
        error: "Не удалось отправить письмо. Проверь настройки Gmail и попробуй позже."
      });
    }

    return res.status(200).json({
      success: true,
      verificationRequired: true,
      message: "Код подтверждения отправлен на твою почту."
    });

  } catch (error) {
    console.error("Registration error:", error.message);

    return res.status(500).json({
      error: "Не удалось начать регистрацию. Попробуй позже."
    });
  }
});

// ==========================================
// ПОДТВЕРЖДЕНИЕ EMAIL
// ==========================================

app.post("/api/auth/verify-email", (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    const email = String(req.body.email || "").trim().toLowerCase();
    const code = String(req.body.code || "").trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        error: "Некорректный email."
      });
    }

    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({
        error: "Введи шестизначный код из письма."
      });
    }

    const pending = db.prepare(`
      SELECT *
      FROM email_verifications
      WHERE email = ?
    `).get(email);

    if (!pending) {
      return res.status(400).json({
        error: "Регистрация не найдена. Начни регистрацию заново."
      });
    }

    if (pending.expires_at <= Date.now()) {
      db.prepare(`
        DELETE FROM email_verifications
        WHERE email = ?
      `).run(email);

      return res.status(400).json({
        error: "Срок действия кода истёк. Зарегистрируйся заново."
      });
    }

    if (pending.attempts >= 5) {
      return res.status(429).json({
        error: "Слишком много попыток. Запроси новый код."
      });
    }

    const submittedHash = crypto.createHash("sha256")
      .update(code)
      .digest("hex");

    const actual = Buffer.from(submittedHash, "hex");
    const expected = Buffer.from(pending.code_hash, "hex");

    const valid = actual.length === expected.length &&
      crypto.timingSafeEqual(actual, expected);

    if (!valid) {
      db.prepare(`
        UPDATE email_verifications
        SET attempts = attempts + 1
        WHERE email = ?
      `).run(email);

      return res.status(400).json({
        error: "Неверный код подтверждения."
      });
    }

    const userId = crypto.randomUUID();
    const userRole = email === OWNER_EMAIL ? "OWNER" : "FREE";

    const createAccount = db.transaction(() => {
      const existing = db.prepare(
        "SELECT id FROM users WHERE email = ?"
      ).get(email);

      if (existing) {
        throw new Error("ACCOUNT_ALREADY_EXISTS");
      }

      db.prepare(`
        INSERT INTO users (
          id,
          name,
          email,
          password_hash,
          role
        )
        VALUES (?, ?, ?, ?, ?)
      `).run(
        userId,
        pending.name,
        email,
        pending.password_hash,
        userRole
      );

      db.prepare(`
        DELETE FROM email_verifications
        WHERE email = ?
      `).run(email);
    });

    try {
      createAccount();
    } catch (error) {
      if (error.message === "ACCOUNT_ALREADY_EXISTS") {
        return res.status(409).json({
          error: "Аккаунт уже существует. Используй вход."
        });
      }

      throw error;
    }

    const user = db.prepare(`
      SELECT id, name, email, role, created_at, is_blocked
      FROM users
      WHERE id = ?
    `).get(userId);

    issueSession(user, res, req);

    return res.status(201).json({
      success: true,
      user: publicUser(user)
    });

  } catch (error) {
    console.error("Email verification error:", error.message);

    return res.status(500).json({
      error: "Не удалось подтвердить почту. Попробуй позже."
    });
  }
});

// ==========================================
// ПОВТОРНАЯ ОТПРАВКА КОДА
// ==========================================

app.post("/api/auth/resend-code", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    const email = String(req.body.email || "").trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        error: "Некорректный email."
      });
    }

    const pending = db.prepare(`
      SELECT *
      FROM email_verifications
      WHERE email = ?
    `).get(email);

    if (!pending) {
      return res.json({
        success: true,
        message: "Если регистрация ожидает подтверждения, новый код будет отправлен."
      });
    }

    const now = Date.now();

    if (now - pending.last_sent_at < 60000) {
      return res.status(429).json({
        error: "Подожди минуту перед повторной отправкой."
      });
    }

    const code = String(
      crypto.randomInt(100000, 1000000)
    );

    const codeHash = crypto.createHash("sha256")
      .update(code)
      .digest("hex");

    db.prepare(`
      UPDATE email_verifications
      SET code_hash = ?,
          expires_at = ?,
          attempts = 0,
          last_sent_at = ?
      WHERE email = ?
    `).run(
      codeHash,
      now + 10 * 60 * 1000,
      now,
      email
    );

    try {
      await sendVerificationEmail(email, code);
    } catch (mailError) {
      console.error("Resend email error:", mailError.message);

      return res.status(503).json({
        error: "Не удалось отправить письмо. Попробуй позже."
      });
    }

    return res.json({
      success: true,
      message: "Новый код отправлен на почту."
    });

  } catch (error) {
    console.error("Resend code error:", error.message);

    return res.status(500).json({
      error: "Не удалось отправить новый код."
    });
  }
});

// ==========================================
// ВХОД
// ==========================================

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
    console.error("Login error:", error.message);

    res.status(500).json({
      error: "Ошибка входа."
    });
  }
});

// ==========================================
// ТЕКУЩИЙ ПОЛЬЗОВАТЕЛЬ
// ==========================================

app.get("/api/auth/me", auth, (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  const user = db.prepare(`
    SELECT id, name, email, role, created_at, is_blocked
    FROM users WHERE id = ?
  `).get(req.user.id);

  if (!user) {
    return res.status(401).json({
      error: "Аккаунт не найден."
    });
  }

  res.json({
    user: publicUser(user)
  });
});

// ==========================================
// ВЫХОД
// ==========================================

app.post("/api/auth/logout", (req, res) => {
  const token = cookieToken(req);

  if (token) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?")
      .run(hashToken(token));
  }

  clearSessionCookie(res, req);

  res.json({
    success: true
  });
});

db.prepare("DELETE FROM sessions WHERE expires_at <= ?")
  .run(Date.now());

// ==========================================
// АДМИН-ПАНЕЛЬ
// ==========================================

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
    return res.status(400).json({
      error: "Нет изменений."
    });
  }

  const keys = Object.keys(updates);
  const set = keys.map(key => `${key} = @${key}`).join(", ");

  db.prepare(`UPDATE users SET ${set} WHERE id = ?`)
    .run({ ...updates, id });

  if (updates.is_blocked === 1) {
    db.prepare("DELETE FROM sessions WHERE user_id = ?")
      .run(id);
  }

  const updated = db.prepare(`
    SELECT id, name, email, role, is_blocked, created_at
    FROM users WHERE id = ?
  `).get(id);

  res.json({
    success: true,
    user: updated
  });
});

// ==========================================
// УПРАВЛЕНИЕ GEMINI API-КЛЮЧАМИ
// ==========================================

app.get("/api/admin/gemini-keys", auth, requireOwner, (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    const keys = getGeminiKeys().map(key => ({
      id: key.id,
      active: isKeyActive(key),
      status: key.status || null,
      created_at: key.created_at || null,
      last_used_at: key.last_used_at || null,
      last_error: key.last_error || null
    }));

    res.json({
      success: true,
      total: keys.length,
      active: keys.filter(key => key.active).length,
      keys
    });

  } catch (error) {
    console.error("Gemini keys list error:", error.message);

    res.status(500).json({
      error: "Не удалось получить список API-ключей."
    });
  }
});

app.post("/api/admin/gemini-keys", auth, requireOwner, (req, res) => {
  try {
    const apiKey = typeof req.body.apiKey === "string"
      ? req.body.apiKey.trim()
      : "";

    if (!apiKey || apiKey.length < 10 || apiKey.length > 500) {
      return res.status(400).json({
        error: "Укажи корректный Gemini API-ключ."
      });
    }

    const result = insertKey(db, apiKey);

    res.status(201).json({
      success: true,
      message: "API-ключ добавлен.",
      key: result
    });

  } catch (error) {
    console.error("Gemini key insert error:", error.message);

    res.status(400).json({
      error: "Не удалось добавить ключ. Проверь его или попробуй другой."
    });
  }
});

app.patch(
  "/api/admin/gemini-keys/:id/toggle",
  auth,
  requireOwner,
  (req, res) => {
    try {
      const result = toggleKeyActive(db, req.params.id);

      if (!result || result.changes === 0) {
        return res.status(404).json({
          error: "API-ключ не найден."
        });
      }

      res.json({
        success: true,
        message: "Статус API-ключа изменён."
      });

    } catch (error) {
      console.error("Gemini key toggle error:", error.message);

      res.status(500).json({
        error: "Не удалось изменить статус ключа."
      });
    }
  }
);

app.delete(
  "/api/admin/gemini-keys/:id",
  auth,
  requireOwner,
  (req, res) => {
    try {
      const result = deleteKey(db, req.params.id);

      if (!result || result.changes === 0) {
        return res.status(404).json({
          error: "API-ключ не найден."
        });
      }

      res.json({
        success: true,
        message: "API-ключ удалён."
      });

    } catch (error) {
      console.error("Gemini key delete error:", error.message);

      res.status(500).json({
        error: "Не удалось удалить ключ."
      });
    }
  }
);

// ==========================================
// ЛИМИТЫ И ИСПОЛЬЗОВАНИЕ
// ==========================================

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

function reserveCounter(userId, counter, amount, limit) {
  if (limit === Infinity) return true;

  const date = usageDate();
  const current = getUsage(userId);

  if (current[counter] + amount > limit) return false;

  const allowedColumns = ["messages", "images", "files"];

  if (!allowedColumns.includes(counter)) return false;

  db.prepare(`
    INSERT INTO daily_usage
      (user_id, usage_date, messages, images, files)
    VALUES (?, ?, 0, 0, 0)
    ON CONFLICT(user_id, usage_date) DO NOTHING
  `).run(userId, date);

  db.prepare(`
    UPDATE daily_usage
    SET ${counter} = ${counter} + ?
    WHERE user_id = ? AND usage_date = ?
  `).run(amount, userId, date);

  return true;
}

function releaseCounter(userId, counter, amount = 1) {
  if (!["messages", "images", "files"].includes(counter)) return;

  db.prepare(`
    UPDATE daily_usage
    SET ${counter} = MAX(0, ${counter} - ?)
    WHERE user_id = ? AND usage_date = ?
  `).run(amount, userId, usageDate());
}

const reserveMessage = db.transaction(userId => {
  return reserveCounter(
    userId,
    "messages",
    1,
    LIMITS.FREE.messages
  );
});

function releaseMessage(userId) {
  releaseCounter(userId, "messages", 1);
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

// ==========================================
// СТАТУС
// ==========================================

app.get("/api/status", (req, res) => {
  const keys = getGeminiKeys();
  const activeKeys = keys.filter(isKeyActive).length;

  res.json({
    name: "Pinsk AI",
    server: "online",
    model: MODEL,
    imageModel: IMAGE_MODEL,
    apiKeyConfigured: activeKeys > 0,
    geminiKeysTotal: keys.length,
    geminiKeysActive: activeKeys,
    uploadsEnabled: true,
    imageGenerationEnabled: Boolean(
      process.env.CLOUDFLARE_ACCOUNT_ID &&
      process.env.CLOUDFLARE_API_TOKEN
    )
  });
});

// ==========================================
// ТАРИФЫ
// ==========================================

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

app.get("/api/limits", auth, (req, res) => {
  res.json({
    plan: req.user.role,
    limits: serializableLimits(limitsFor(req.user))
  });
});

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

// ==========================================
// ПЛАГИНЫ
// ==========================================

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

// ==========================================
// ИСТОРИЯ ЧАТОВ
// ==========================================

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

// ==========================================
// ПАМЯТЬ
// ==========================================

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

  res.json({
    success: true
  });
});

// ==========================================
// GEMINI API: ОБЩИЕ ФУНКЦИИ
// ==========================================

function makeGeminiSignal(managerSignal) {
  const timeoutSignal = AbortSignal.timeout(180000);

  if (managerSignal && typeof AbortSignal.any === "function") {
    return AbortSignal.any([managerSignal, timeoutSignal]);
  }

  return timeoutSignal;
}

function convertMessageContent(content) {
  if (typeof content === "string") {
    return [{ text: content }];
  }

  if (!Array.isArray(content)) {
    return [{ text: String(content ?? "") }];
  }

  const parts = [];

  for (const item of content) {
    if (item.type === "text") {
      parts.push({
        text: String(item.text || "")
      });

      continue;
    }

    if (item.type === "image_url") {
      const url = item.image_url?.url || "";

      const match = url.match(
        /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/
      );

      if (match) {
        parts.push({
          inlineData: {
            mimeType: match[1],
            data: match[2]
          }
        });
      }
    }
  }

  return parts;
}

function convertMessagesToGemini(messages) {
  const systemMessages = [];
  const contents = [];

  for (const message of messages) {
    if (message.role === "system") {
      const text = typeof message.content === "string"
        ? message.content
        : convertMessageContent(message.content)
          .map(part => part.text || "")
          .join("\n");

      systemMessages.push(text);
      continue;
    }

    const role = message.role === "assistant" ? "model" : "user";
    const parts = convertMessageContent(message.content);

    if (!parts.length) continue;

    contents.push({
      role,
      parts
    });
  }

  const result = { contents };

  if (systemMessages.length) {
    result.systemInstruction = {
      parts: [{
        text: systemMessages.join("\n\n")
      }]
    };
  }

  return result;
}

async function readGeminiResponse(response) {
  let data;

  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    const error = new Error(
      data?.error?.message ||
      `Gemini API вернул HTTP ${response.status}`
    );

    error.status = response.status;
    throw error;
  }

  return data;
}

async function askAI(messages) {
  const requestBody = convertMessagesToGemini(messages);

  return executeWithKeyRotation(
    db,
    async (apiKey, { signal }) => {
      const endpoint =
        `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${encodeURIComponent(MODEL)}:generateContent`;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify(requestBody),
        signal: makeGeminiSignal(signal)
      });

      const data = await readGeminiResponse(response);
      const parts = data?.candidates?.[0]?.content?.parts || [];

      const answer = parts
        .map(part => part.text || "")
        .filter(Boolean)
        .join("\n");

      return answer || "Модель не вернула текстовый ответ.";
    }
  );
}

// ==========================================
// ЧАТ С ФАЙЛАМИ И ИЗОБРАЖЕНИЯМИ
// ==========================================

app.post(
  "/api/chat",
  auth,
  upload.array("files", MAX_FILES),
  async (req, res) => {
    const userId = req.user.id;

    let messageReserved = false;
    let filesReserved = false;

    const files = req.files || [];

    try {
      if (!hasActiveGeminiKeys()) {
        return res.status(503).json({
          error: "Нет активных Gemini API-ключей. Обратись к владельцу Pinsk."
        });
      }

      const message = String(req.body.message || "").trim();

      const conversationId = String(
        req.body.conversationId || crypto.randomUUID()
      );

      if (!message && files.length === 0) {
        return res.status(400).json({
          error: "Напиши сообщение или прикрепи файл."
        });
      }

      if (message.length > 12000) {
        return res.status(400).json({
          error: "Сообщение слишком длинное."
        });
      }

      const totalSize = files.reduce(
        (sum, file) => sum + file.size,
        0
      );

      if (totalSize > 30 * 1024 * 1024) {
        return res.status(413).json({
          error: "Общий размер файлов слишком большой."
        });
      }

      const limits = limitsFor(req.user);

      if (limits.messages !== Infinity) {
        messageReserved = reserveMessage(userId);

        if (!messageReserved) {
          return res.status(429).json({
            error: "Дневной лимит сообщений исчерпан.",
            code: "DAILY_LIMIT_REACHED",
            plan: req.user.role,
            used: getUsage(userId).messages,
            limit: limits.messages
          });
        }
      }

      if (files.length > 0 && limits.files !== Infinity) {
        filesReserved = reserveCounter(
          userId,
          "files",
          files.length,
          limits.files
        );

        if (!filesReserved) {
          if (messageReserved) releaseMessage(userId);

          return res.status(429).json({
            error: "Дневной лимит файлов исчерпан.",
            code: "FILE_LIMIT_REACHED",
            used: getUsage(userId).files,
            limit: limits.files
          });
        }
      }

      const conversation = db.prepare(`
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
          if (messageReserved) releaseMessage(userId);

          if (filesReserved) {
            releaseCounter(userId, "files", files.length);
          }

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
          (message || "Прикреплённые файлы").slice(0, 60),
          userId
        );
      }

      const fileParts = [];
      const imageParts = [];
      const fileDescriptions = [];

      for (const file of files) {
        const filename = safeFileName(file.originalname);

        fileDescriptions.push({
          name: filename,
          size: file.size,
          type: file.mimetype
        });

        if (isImage(file)) {
          const mime = fileMime(file);

          imageParts.push({
            type: "image_url",
            image_url: {
              url: `data:${mime};base64,${file.buffer.toString("base64")}`
            }
          });

          fileParts.push(`[Изображение прикреплено: ${filename}]`);

        } else {
          const extracted = await extractFileText(file);

          fileParts.push(
            `\n\n===== ФАЙЛ: ${filename} =====\n` +
            (extracted || "Не удалось извлечь текст.") +
            "\n===== КОНЕЦ ФАЙЛА =====\n"
          );
        }
      }

      const attachmentText = fileParts.join("\n");

      const userContent = (
        message || "Проанализируй прикреплённые файлы."
      ) + attachmentText;

      db.prepare(`
        INSERT INTO messages (conversation_id, role, content)
        VALUES (?, 'user', ?)
      `).run(conversationId, userContent);

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
        LIMIT 30
      `).all(userId);

      const context = savedMemories
        .map(item => item.content)
        .join("\n");

      const history = recentMessages.map(item => ({
        role: item.role,
        content: item.content
      }));

      if (imageParts.length > 0) {
        const last = history[history.length - 1];

        last.content = [
          {
            type: "text",
            text: last.content
          },
          ...imageParts
        ];
      }

      const answer = await askAI([
        {
          role: "system",
          content:
            "Ты Pinsk — интеллектуальный ИИ-ассистент. " +
            "Отвечай полезно, точно и на языке пользователя. " +
            "Анализируй прикреплённые файлы и изображения, если они есть. " +
            "Не утверждай, что файл не прикреплён, если его содержимое передано в сообщении. " +
            "Не выдумывай факты. " +
            "Учитывай сохранённую память, если она относится к вопросу.\n\n" +
            "ПАМЯТЬ:\n" + context.slice(0, 10000)
        },
        ...history
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
        files: fileDescriptions,
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
      console.error("Pinsk AI chat error:", error.message);

      if (messageReserved) releaseMessage(userId);

      if (filesReserved) {
        releaseCounter(userId, "files", files.length);
      }

      const status = error instanceof multer.MulterError
        ? 400
        : (error.status === 429 ? 503 : 500);

      res.status(status).json({
        error: error instanceof multer.MulterError
          ? "Ошибка загрузки файла: " + error.message
          : status === 503
            ? "Сейчас все доступные API-ключи заняты или исчерпали квоту. Попробуй немного позже."
            : "Ошибка ИИ-сервера. Проверь настройки модели и API."
      });
    }
  }
);

// ==========================================
// ГЕНЕРАЦИЯ ИЗОБРАЖЕНИЙ CLOUDFLARE
// ==========================================

async function generateCloudflareImage(prompt) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !apiToken) {
    throw new Error("Cloudflare API не настроен.");
  }

  const endpoint =
    `https://api.cloudflare.com/client/v4/accounts/` +
    `${encodeURIComponent(accountId)}/ai/run/${IMAGE_MODEL}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      prompt: String(prompt).slice(0, 2048),
      steps: 4
    }),
    signal: AbortSignal.timeout(180000)
  });

  const contentType = response.headers.get("content-type") || "";
  const buffer = Buffer.from(await response.arrayBuffer());

  if (!response.ok) {
    let message = `Cloudflare HTTP ${response.status}`;

    try {
      const errorData = JSON.parse(buffer.toString("utf8"));

      message =
        errorData.errors?.map(item => item.message).join("; ") ||
        errorData.error ||
        message;
    } catch {}

    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  let imageData;
  let mimeType = "image/png";

  if (contentType.includes("application/json")) {
    mimeType = "image/jpeg";

    const data = JSON.parse(buffer.toString("utf8"));

    imageData =
      data.result?.image ||
      data.result?.data ||
      (typeof data.result === "string" ? data.result : null) ||
      data.image;

    if (typeof imageData !== "string") {
      throw new Error("Cloudflare не вернул изображение.");
    }

    imageData = imageData.replace(
      /^data:image\/[^;]+;base64,/,
      ""
    );

  } else if (contentType.startsWith("image/")) {
    mimeType = contentType.split(";")[0];
    imageData = buffer.toString("base64");

  } else {
    throw new Error(
      "Cloudflare вернул неподдерживаемый формат изображения."
    );
  }

  if (!imageData || imageData.length < 100) {
    throw new Error("Получено пустое изображение.");
  }

  return {
    mimeType,
    data: imageData,
    text: ""
  };
}

async function imageGenerationHandler(req, res) {
  let reserved = false;

  try {
    if (
      !process.env.CLOUDFLARE_ACCOUNT_ID ||
      !process.env.CLOUDFLARE_API_TOKEN
    ) {
      return res.status(503).json({
        error: "Генерация изображений временно недоступна."
      });
    }

    const prompt = String(
      req.body.prompt || req.body.message || ""
    ).trim();

    if (!prompt) {
      return res.status(400).json({
        error: "Опиши изображение, которое нужно создать."
      });
    }

    if (prompt.length > 2048) {
      return res.status(400).json({
        error: "Описание не должно превышать 2048 символов."
      });
    }

    const limits = limitsFor(req.user);

    if (limits.images !== Infinity) {
      reserved = reserveCounter(
        req.user.id,
        "images",
        1,
        limits.images
      );

      if (!reserved) {
        return res.status(429).json({
          error: "Дневной лимит генерации изображений исчерпан.",
          code: "IMAGE_LIMIT_REACHED",
          used: getUsage(req.user.id).images,
          limit: limits.images
        });
      }
    }

    const result = await generateCloudflareImage(prompt);

    res.json({
      success: true,
      model: IMAGE_MODEL,
      image: `data:${result.mimeType};base64,${result.data}`,
      mimeType: result.mimeType,
      text: result.text,
      usage: getUsage(req.user.id)
    });

  } catch (error) {
    console.error(
      "Cloudflare image generation error:",
      error.message
    );

    if (reserved) {
      releaseCounter(req.user.id, "images", 1);
    }

    const status =
      error.status === 429 ? 503 :
      error.status === 401 || error.status === 403 ? 503 :
      500;

    res.status(status).json({
      error: status === 503
        ? "Cloudflare временно недоступен или исчерпан лимит генерации. Попробуй позже."
        : "Не удалось создать изображение. Попробуй изменить описание."
    });
  }
}

app.post(
  "/api/images/generate",
  auth,
  imageGenerationHandler
);

app.post(
  "/api/image/generate",
  auth,
  imageGenerationHandler
);

// ==========================================
// АНАЛИЗ ДАННЫХ
// ==========================================

app.post("/api/analysis", auth, async (req, res) => {
  try {
    if (!hasActiveGeminiKeys()) {
      return res.status(503).json({
        error: "Нет активных Gemini API-ключей."
      });
    }

    const content = String(req.body.content || "").trim();

    const question = String(
      req.body.question ||
      "Проанализируй эти данные и сделай выводы."
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
          "Ты аналитик данных Pinsk. " +
          "Анализируй таблицы и текст. " +
          "Находи закономерности, ошибки, тенденции, сравнения " +
          "и делай выводы. Не выдумывай отсутствующие значения."
      },
      {
        role: "user",
        content: question + "\n\nДАННЫЕ:\n" + content
      }
    ]);

    res.json({
      success: true,
      answer
    });

  } catch (error) {
    console.error("Data analysis error:", error.message);

    res.status(error.status === 429 ? 503 : 500).json({
      error: error.status === 429
        ? "Сейчас все доступные API-ключи заняты или исчерпали квоту."
        : "Не удалось выполнить анализ данных."
    });
  }
});

// ==========================================
// САЙТ
// ==========================================

app.use(express.static(__dirname, {
  index: "index.html"
}));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ==========================================
// ОБРАБОТКА ОШИБОК
// ==========================================

app.use((error, req, res, next) => {
  console.error("Express error:", error.message);

  if (res.headersSent) return next(error);

  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      error: "Ошибка загрузки файла: " + error.message
    });
  }

  if (error.message && error.message.startsWith("Формат файла")) {
    return res.status(400).json({
      error: error.message
    });
  }

  res.status(500).json({
    error: "Внутренняя ошибка сервера."
  });
});

// ==========================================
// ЗАПУСК
// ==========================================

app.listen(PORT, () => {
  const keys = getGeminiKeys();
  const activeKeys = keys.filter(isKeyActive).length;

  console.log("================================");
  console.log("          PINSK AI");
  console.log("================================");
  console.log("Порт:", PORT);
  console.log("База данных:", DB_PATH);
  console.log("Модель чата:", MODEL);
  console.log("Модель изображений:", IMAGE_MODEL);
  console.log("OWNER:", OWNER_EMAIL);
  console.log("Gemini API-ключей:", keys.length);
  console.log("Активных Gemini API-ключей:", activeKeys);
  console.log("Автоматическая ротация: включена");
  console.log("Регистрация: с подтверждением email");
  console.log("FREE: 100 сообщений в день");
  console.log("FREE: 5 изображений и 5 файлов в день");
  console.log("PRO: безлимит");
  console.log("OWNER: безлимит");
  console.log("Загрузка файлов: включена");
  console.log("Генерация изображений: включена");
  console.log("Анализ данных API: включён");
  console.log("Админ API: включён");
  console.log("================================");
});

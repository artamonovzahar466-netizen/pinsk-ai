

"use strict";

const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { Pool } = require("pg");
const crypto = require("crypto");
const path = require("path");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const XLSX = require("xlsx");
// Gmail API uses Node.js built-in fetch; no extra package required.

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
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const CLOUDFLARE_ACCOUNT_ID =
  process.env.CLOUDFLARE_ACCOUNT_ID || "2b8f981543ffb8d68aace4fa3a205747";
const OWNER_EMAIL = "artamonovzahar466@gmail.com".toLowerCase();

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL не задан. Проверь настройки Render.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000
});

pool.on("error", error => {
  console.error("PostgreSQL pool error:", error.message);
});


// ==========================================
// GMAIL API EMAIL
// ==========================================

async function sendVerificationEmail(email, code) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
  const refreshToken = String(process.env.GOOGLE_REFRESH_TOKEN || "").trim();
  const gmailUser = String(process.env.GMAIL_USER || "").trim();

  if (!clientId || !clientSecret || !refreshToken || !gmailUser) {
    throw new Error(
      "Не настроены GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN или GMAIL_USER в Render."
    );
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Некорректный адрес получателя.");
  }

  // Получаем новый access token по сохранённому refresh token.
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });

  const tokenData = await tokenResponse.json().catch(() => ({}));

  if (!tokenResponse.ok || !tokenData.access_token) {
    console.error("Gmail OAuth token error:", tokenData);
    throw new Error(
      `Не удалось получить Gmail access token: ${tokenData.error_description || tokenData.error || tokenResponse.status}`
    );
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#222">
      <h2 style="text-align:center">Pinsk AI</h2>
      <p>Для подтверждения электронной почты введи этот код:</p>
      <div style="font-size:34px;font-weight:bold;letter-spacing:9px;text-align:center;padding:22px;background:#f2f4f8;border-radius:12px">
        ${code}
      </div>
      <p>Код действует <b>10 минут</b>.</p>
      <p style="color:#777;font-size:13px">
        Если ты не регистрировался в Pinsk AI, проигнорируй это письмо.
      </p>
    </div>
  `;

  const plainText =
    `Твой код подтверждения Pinsk AI: ${code}\n\n` +
    "Код действует 10 минут.\n" +
    "Если ты не регистрировался в Pinsk AI, просто проигнорируй это письмо.";

  const boundary = "pinsk_" + crypto.randomBytes(12).toString("hex");

  const encodeBase64 = value => {
    const lines = Buffer.from(value, "utf8")
      .toString("base64")
      .match(/.{1,76}/g);
    return (lines || []).join("\r\n");
  };

  const subject = Buffer.from(
    "Код подтверждения Pinsk AI",
    "utf8"
  ).toString("base64");

  const message = [
    `From: Pinsk AI <${gmailUser}>`,
    `To: ${email}`,
    `Subject: =?UTF-8?B?${subject}?=`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodeBase64(plainText),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodeBase64(html),
    `--${boundary}--`
  ].join("\r\n");

  const raw = Buffer.from(message, "utf8").toString("base64url");

  const sendResponse = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ raw })
    }
  );

  const sendData = await sendResponse.json().catch(() => ({}));

  if (!sendResponse.ok || !sendData.id) {
    console.error("Gmail API send error:", sendData);
    throw new Error(
      `Gmail API не отправил письмо: ${sendData.error?.message || sendResponse.status}`
    );
  }

  console.log("Pinsk: письмо отправлено через Gmail API:", sendData.id);
  return sendData;
}


// ==========================================
// GEMINI API KEY LEGACY FALLBACK
// ==========================================

const LEGACY_API_KEY = process.env.GEMINI_API_KEY;


// ==========================================
// APPLICATION SETTINGS
// ==========================================

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
// DATABASE INITIALIZATION
// ==========================================

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'FREE',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      is_blocked INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      user_id TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      conversation_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS memories (
      id BIGSERIAL PRIMARY KEY,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      user_id TEXT
    );

    CREATE TABLE IF NOT EXISTS daily_usage (
      user_id TEXT NOT NULL,
      usage_date TEXT NOT NULL,
      messages INTEGER NOT NULL DEFAULT 0,
      images INTEGER NOT NULL DEFAULT 0,
      files INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, usage_date)
    );

    CREATE TABLE IF NOT EXISTS email_verifications (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_sent_at BIGINT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user
      ON sessions(user_id);

    CREATE INDEX IF NOT EXISTS idx_sessions_expiry
      ON sessions(expires_at);

    CREATE INDEX IF NOT EXISTS idx_conversations_user
      ON conversations(user_id);

    CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages(conversation_id);

    CREATE INDEX IF NOT EXISTS idx_memories_user
      ON memories(user_id);

    CREATE INDEX IF NOT EXISTS idx_usage_user_date
      ON daily_usage(user_id, usage_date);
  `);

  await pool.query(`
    UPDATE users
    SET role = 'OWNER'
    WHERE LOWER(email) = LOWER($1)
  `, [OWNER_EMAIL]);

  await initGeminiKeysTable(pool);

  if (LEGACY_API_KEY) {
    const keys = await getAllKeys(pool);

    if (keys.length === 0) {
      try {
        await insertKey(pool, LEGACY_API_KEY.trim());
        console.log("Pinsk: Gemini API-ключ добавлен в менеджер.");
      } catch (error) {
        console.error(
          "Не удалось перенести старый API-ключ:",
          error.message
        );
      }
    }
  }

  await pool.query(`
    DELETE FROM sessions
    WHERE expires_at <= $1
  `, [Date.now()]);

  console.log("Pinsk: PostgreSQL подключён и схема проверена.");
}


// ==========================================
// FILE UPLOADS
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

    return workbook.SheetNames.map(sheetName => (
      "Лист: " + sheetName + "\n" +
      XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName])
    )).join("\n\n");
  }

  if (extension === ".csv") {
    const workbook = XLSX.read(file.buffer, {
      type: "buffer",
      raw: false
    });

    return workbook.SheetNames.map(sheetName => (
      "Лист: " + sheetName + "\n" +
      XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName])
    )).join("\n\n");
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

  return types[extension] ||
    file.mimetype ||
    "application/octet-stream";
}


// ==========================================
// COMMON HELPERS
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

function isKeyActive(key) {
  if (key.is_active !== undefined) {
    return Boolean(Number(key.is_active));
  }

  if (key.active !== undefined) return Boolean(key.active);
  if (key.enabled !== undefined) return Boolean(key.enabled);

  return true;
}

async function getGeminiKeys() {
  const result = await getAllKeys(pool);

  if (Array.isArray(result)) {
    return result;
  }

  if (Array.isArray(result?.rows)) {
    return result.rows;
  }

  console.error(
    "Pinsk: getAllKeys вернул неожиданный результат:",
    typeof result,
    result
  );

  return [];
}

async function hasActiveGeminiKeys() {
  const keys = await getGeminiKeys();
  return keys.some(isKeyActive);
}


// ==========================================
// AUTHENTICATION
// ==========================================

async function auth(req, res, next) {
  try {
    const token = cookieToken(req);

    if (!token) {
      return res.status(401).json({
        error: "Войди в аккаунт Pinsk."
      });
    }

    const sessionResult = await pool.query(`
      SELECT user_id
      FROM sessions
      WHERE token_hash = $1 AND expires_at > $2
    `, [hashToken(token), Date.now()]);

    const session = sessionResult.rows[0];

    if (!session) {
      clearSessionCookie(res, req);

      return res.status(401).json({
        error: "Сессия истекла. Войди в аккаунт."
      });
    }

    const userResult = await pool.query(`
      SELECT id, name, email, role, created_at, is_blocked
      FROM users
      WHERE id = $1
    `, [session.user_id]);

    const user = userResult.rows[0];

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
      await pool.query(
        "UPDATE users SET role = 'OWNER' WHERE id = $1",
        [user.id]
      );

      user.role = "OWNER";
    }

    if (Number(user.is_blocked) === 1) {
      await pool.query(
        "DELETE FROM sessions WHERE user_id = $1",
        [user.id]
      );

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

async function issueSession(user, res, req) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;

  await pool.query(`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES ($1, $2, $3)
  `, [hashToken(token), user.id, expiresAt]);

  setSessionCookie(res, token, req);
}


// ==========================================
// REGISTRATION
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

    const existing = await pool.query(
      "SELECT id FROM users WHERE LOWER(email) = $1",
      [email]
    );

    if (existing.rows.length) {
      return res.status(409).json({
        error: "Аккаунт уже существует. Используй вход."
      });
    }

    const now = Date.now();

    const pendingResult = await pool.query(`
      SELECT last_sent_at
      FROM email_verifications
      WHERE LOWER(email) = $1
    `, [email]);

    const pending = pendingResult.rows[0];

    if (pending && now - Number(pending.last_sent_at) < 60000) {
      return res.status(429).json({
        error: "Подожди минуту перед повторной отправкой кода."
      });
    }

    const code = String(crypto.randomInt(100000, 1000000));

    const codeHash = crypto.createHash("sha256")
      .update(code)
      .digest("hex");

    const storedPassword = makePasswordHash(password);

    await pool.query(`
      INSERT INTO email_verifications (
        email, name, password_hash, code_hash,
        expires_at, attempts, last_sent_at
      )
      VALUES ($1, $2, $3, $4, $5, 0, $6)
      ON CONFLICT(email) DO UPDATE SET
        name = EXCLUDED.name,
        password_hash = EXCLUDED.password_hash,
        code_hash = EXCLUDED.code_hash,
        expires_at = EXCLUDED.expires_at,
        attempts = 0,
        last_sent_at = EXCLUDED.last_sent_at
    `, [
      email,
      name,
      storedPassword,
      codeHash,
      now + 10 * 60 * 1000,
      now
    ]);

    try {
      await sendVerificationEmail(email, code);
    } catch (mailError) {
      console.error("Verification email error:", mailError.message);

      await pool.query(
        "DELETE FROM email_verifications WHERE LOWER(email) = $1",
        [email]
      );

      return res.status(503).json({
        error: "Не удалось отправить письмо. Проверь настройки почты и попробуй позже."
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
// EMAIL VERIFICATION
// ==========================================

app.post("/api/auth/verify-email", async (req, res) => {
  const client = await pool.connect();

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

    await client.query("BEGIN");

    const pendingResult = await client.query(`
      SELECT *
      FROM email_verifications
      WHERE LOWER(email) = $1
      FOR UPDATE
    `, [email]);

    const pending = pendingResult.rows[0];

    if (!pending) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "Регистрация не найдена. Начни регистрацию заново."
      });
    }

    if (Number(pending.expires_at) <= Date.now()) {
      await client.query(
        "DELETE FROM email_verifications WHERE LOWER(email) = $1",
        [email]
      );

      await client.query("COMMIT");

      return res.status(400).json({
        error: "Срок действия кода истёк. Зарегистрируйся заново."
      });
    }

    if (Number(pending.attempts) >= 5) {
      await client.query("ROLLBACK");

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
      await client.query(`
        UPDATE email_verifications
        SET attempts = attempts + 1
        WHERE LOWER(email) = $1
      `, [email]);

      await client.query("COMMIT");

      return res.status(400).json({
        error: "Неверный код подтверждения."
      });
    }

    const userId = crypto.randomUUID();
    const userRole = email === OWNER_EMAIL ? "OWNER" : "FREE";

    const inserted = await client.query(`
      INSERT INTO users (
        id, name, email, password_hash, role
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT DO NOTHING
      RETURNING id, name, email, role, created_at, is_blocked
    `, [
      userId,
      pending.name,
      email,
      pending.password_hash,
      userRole
    ]);

    if (!inserted.rows.length) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        error: "Аккаунт уже существует. Используй вход."
      });
    }

    await client.query(`
      DELETE FROM email_verifications
      WHERE LOWER(email) = $1
    `, [email]);

    await client.query("COMMIT");

    await issueSession(inserted.rows[0], res, req);

    return res.status(201).json({
      success: true,
      user: publicUser(inserted.rows[0])
    });

  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    console.error("Email verification error:", error.message);

    return res.status(500).json({
      error: "Не удалось подтвердить почту. Попробуй позже."
    });
  } finally {
    client.release();
  }
});


// ==========================================
// RESEND VERIFICATION CODE
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

    const result = await pool.query(`
      SELECT *
      FROM email_verifications
      WHERE LOWER(email) = $1
    `, [email]);

    const pending = result.rows[0];

    if (!pending) {
      return res.json({
        success: true,
        message: "Если регистрация ожидает подтверждения, новый код будет отправлен."
      });
    }

    const now = Date.now();

    if (now - Number(pending.last_sent_at) < 60000) {
      return res.status(429).json({
        error: "Подожди минуту перед повторной отправкой."
      });
    }

    const code = String(crypto.randomInt(100000, 1000000));

    const codeHash = crypto.createHash("sha256")
      .update(code)
      .digest("hex");

    await pool.query(`
      UPDATE email_verifications
      SET code_hash = $1,
          expires_at = $2,
          attempts = 0,
          last_sent_at = $3
      WHERE LOWER(email) = $4
    `, [
      codeHash,
      now + 10 * 60 * 1000,
      now,
      email
    ]);

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
// LOGIN
// ==========================================

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const result = await pool.query(`
      SELECT *
      FROM users
      WHERE LOWER(email) = $1
    `, [email]);

    const user = result.rows[0];

    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({
        error: "Неверный email или пароль."
      });
    }

    if (Number(user.is_blocked) === 1) {
      return res.status(403).json({
        error: "Аккаунт заблокирован администратором."
      });
    }

    if (email === OWNER_EMAIL && user.role !== "OWNER") {
      await pool.query(
        "UPDATE users SET role = 'OWNER' WHERE id = $1",
        [user.id]
      );

      user.role = "OWNER";
    }

    await issueSession(user, res, req);

    res.setHeader("Cache-Control", "no-store");

    return res.json({
      success: true,
      user: publicUser(user)
    });

  } catch (error) {
    console.error("Login error:", error.message);

    return res.status(500).json({
      error: "Ошибка входа."
    });
  }
});


// ==========================================
// CURRENT USER
// ==========================================

app.get("/api/auth/me", auth, async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    const result = await pool.query(`
      SELECT id, name, email, role, created_at, is_blocked
      FROM users
      WHERE id = $1
    `, [req.user.id]);

    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({
        error: "Аккаунт не найден."
      });
    }

    res.json({
      user: publicUser(user)
    });

  } catch (error) {
    console.error("Current user error:", error.message);

    res.status(500).json({
      error: "Не удалось получить данные пользователя."
    });
  }
});


// ==========================================
// LOGOUT
// ==========================================

app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = cookieToken(req);

    if (token) {
      await pool.query(
        "DELETE FROM sessions WHERE token_hash = $1",
        [hashToken(token)]
      );
    }

    clearSessionCookie(res, req);

    res.json({ success: true });

  } catch (error) {
    console.error("Logout error:", error.message);

    res.status(500).json({
      error: "Не удалось завершить сессию."
    });
  }
});


// ==========================================
// ADMIN
// ==========================================

app.get("/api/admin/stats", auth, requireOwner, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE role = 'FREE') AS free,
        COUNT(*) FILTER (WHERE role = 'PRO') AS pro,
        COUNT(*) FILTER (WHERE role = 'OWNER') AS owners,
        COUNT(*) FILTER (WHERE is_blocked = 1) AS blocked
      FROM users
    `);

    res.json(result.rows[0]);

  } catch (error) {
    console.error("Admin stats error:", error.message);

    res.status(500).json({
      error: "Не удалось получить статистику."
    });
  }
});

app.get("/api/admin/users", auth, requireOwner, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();

    const result = await pool.query(`
      SELECT id, name, email, role, is_blocked, created_at
      FROM users
      WHERE name ILIKE $1 OR email ILIKE $1
      ORDER BY created_at DESC
      LIMIT 200
    `, [`%${search}%`]);

    res.json(result.rows);

  } catch (error) {
    console.error("Admin users error:", error.message);

    res.status(500).json({
      error: "Не удалось получить пользователей."
    });
  }
});

app.patch("/api/admin/users/:id", auth, requireOwner, async (req, res) => {
  try {
    const id = String(req.params.id);

    const targetResult = await pool.query(
      "SELECT * FROM users WHERE id = $1",
      [id]
    );

    const target = targetResult.rows[0];

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

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      if (updates.role !== undefined) {
        await client.query(
          "UPDATE users SET role = $1 WHERE id = $2",
          [updates.role, id]
        );
      }

      if (updates.is_blocked !== undefined) {
        await client.query(
          "UPDATE users SET is_blocked = $1 WHERE id = $2",
          [updates.is_blocked, id]
        );

        if (updates.is_blocked === 1) {
          await client.query(
            "DELETE FROM sessions WHERE user_id = $1",
            [id]
          );
        }
      }

      await client.query("COMMIT");

    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const updated = await pool.query(`
      SELECT id, name, email, role, is_blocked, created_at
      FROM users
      WHERE id = $1
    `, [id]);

    res.json({
      success: true,
      user: updated.rows[0]
    });

  } catch (error) {
    console.error("Admin user update error:", error.message);

    res.status(500).json({
      error: "Не удалось изменить пользователя."
    });
  }
});


// ==========================================
// GEMINI API KEY MANAGEMENT
// ==========================================

app.get(
  "/api/admin/gemini-keys",
  auth,
  requireOwner,
  async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");

      const keys = await getGeminiKeys();

      const safeKeys = keys.map(key => ({
        id: key.id,
        masked_key: key.masked_key,
        active: isKeyActive(key),
        is_active: key.is_active,
        usage_count: key.usage_count,
        error_count: key.error_count,
        last_used: key.last_used,
        last_error: key.last_error,
        cooldown_until: key.cooldown_until,
        created_at: key.created_at
      }));

      res.json({
        success: true,
        total: safeKeys.length,
        active: safeKeys.filter(key => key.active).length,
        keys: safeKeys
      });

    } catch (error) {
      console.error("Gemini keys list error:", error.message);

      res.status(500).json({
        error: "Не удалось получить список API-ключей."
      });
    }
  }
);

app.post(
  "/api/admin/gemini-keys",
  auth,
  requireOwner,
  async (req, res) => {
    try {
      const apiKey = typeof req.body.apiKey === "string"
        ? req.body.apiKey.trim()
        : "";

      if (!apiKey || apiKey.length < 10 || apiKey.length > 500) {
        return res.status(400).json({
          error: "Укажи корректный Gemini API-ключ."
        });
      }

      const result = await insertKey(pool, apiKey);

      res.status(201).json({
        success: true,
        message: "API-ключ добавлен.",
        key: result
      });

    } catch (error) {
      console.error("Gemini key insert error:", error.message);

      res.status(400).json({
        error: error.message === "Этот API-ключ уже добавлен."
          ? error.message
          : "Не удалось добавить ключ. Проверь его или попробуй другой."
      });
    }
  }
);

app.patch(
  "/api/admin/gemini-keys/:id/toggle",
  auth,
  requireOwner,
  async (req, res) => {
    try {
      const result = await toggleKeyActive(pool, req.params.id);

      if (!result || result.rowCount === 0) {
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
  async (req, res) => {
    try {
      const result = await deleteKey(pool, req.params.id);

      if (!result || result.rowCount === 0) {
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
// USAGE AND LIMITS
// ==========================================

async function getUsage(userId) {
  const result = await pool.query(`
    SELECT messages, images, files
    FROM daily_usage
    WHERE user_id = $1 AND usage_date = $2
  `, [userId, usageDate()]);

  return result.rows[0] || {
    messages: 0,
    images: 0,
    files: 0
  };
}

async function reserveCounter(userId, counter, amount, limit) {
  if (limit === Infinity) return true;

  const allowedColumns = ["messages", "images", "files"];

  if (!allowedColumns.includes(counter)) return false;

  const date = usageDate();

  const result = await pool.query(`
    INSERT INTO daily_usage (
      user_id, usage_date, messages, images, files
    )
    VALUES (
      $1, $2,
      CASE WHEN $3 = 'messages' THEN $4 ELSE 0 END,
      CASE WHEN $3 = 'images' THEN $4 ELSE 0 END,
      CASE WHEN $3 = 'files' THEN $4 ELSE 0 END
    )
    ON CONFLICT (user_id, usage_date)
    DO UPDATE SET
      ${counter} = daily_usage.${counter} + $4
    WHERE daily_usage.${counter} + $4 <= $5
    RETURNING ${counter}
  `, [userId, date, counter, amount, limit]);

  return result.rowCount === 1;
}

async function releaseCounter(userId, counter, amount = 1) {
  if (!["messages", "images", "files"].includes(counter)) return;

  await pool.query(`
    UPDATE daily_usage
    SET ${counter} = GREATEST(0, ${counter} - $1)
    WHERE user_id = $2 AND usage_date = $3
  `, [amount, userId, usageDate()]);
}

async function reserveMessage(userId) {
  return reserveCounter(
    userId,
    "messages",
    1,
    LIMITS.FREE.messages
  );
}

async function releaseMessage(userId) {
  return releaseCounter(userId, "messages", 1);
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
// STATUS
// ==========================================

app.get("/api/status", async (req, res) => {
  try {
    const keys = await getGeminiKeys();

    res.json({
      name: "Pinsk AI",
      server: "online",
      database: "postgresql",
      model: MODEL,
      provider: "Google Gemini",
      imageModel: IMAGE_MODEL,
      apiKeyConfigured: keys.some(isKeyActive),
      uploadsEnabled: true,
      imageGenerationEnabled: Boolean(process.env.CLOUDFLARE_API_TOKEN),
      webSearchEnabled: Boolean(process.env.TAVILY_API_KEY)
    });
  } catch (error) {
    console.error("API status error:", error.message);

    res.status(500).json({
      error: "Не удалось получить статус API."
    });
  }
});


// ==========================================
// PLANS
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

app.get("/api/usage", auth, async (req, res) => {
  try {
    const used = await getUsage(req.user.id);
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

  } catch (error) {
    console.error("Usage error:", error.message);

    res.status(500).json({
      error: "Не удалось получить использование."
    });
  }
});


// ==========================================
// PLUGINS
// ==========================================

app.get("/api/plugins", auth, (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  res.json({
    plugins: [
      {
        id: "web-search",
        name: "Поиск в интернете",
        description: "Поиск актуальной информации в интернете.",
        status: process.env.TAVILY_API_KEY ? "available" : "not_connected"
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
// INTERNET SEARCH — TAVILY
// ==========================================

const webSearchRateLimits = new Map();
const WEB_SEARCH_WINDOW_MS = 60 * 1000;
const WEB_SEARCH_MAX_REQUESTS = 15;

function checkWebSearchRateLimit(userId) {
  const now = Date.now();
  const current = webSearchRateLimits.get(userId);

  if (!current || now - current.startedAt >= WEB_SEARCH_WINDOW_MS) {
    webSearchRateLimits.set(userId, {
      startedAt: now,
      count: 1
    });
    return true;
  }

  if (current.count >= WEB_SEARCH_MAX_REQUESTS) {
    return false;
  }

  current.count += 1;
  return true;
}

function normalizeSearchResult(item) {
  if (!item || typeof item !== "object") return null;

  let parsedUrl;

  try {
    parsedUrl = new URL(String(item.url || ""));
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return null;
  }

  return {
    title: String(item.title || parsedUrl.hostname).slice(0, 300),
    url: parsedUrl.toString(),
    domain: parsedUrl.hostname.slice(0, 200),
    snippet: String(item.content || item.snippet || "").slice(0, 1800),
    publishedDate: item.published_date
      ? String(item.published_date).slice(0, 100)
      : null,
    score: Number.isFinite(Number(item.score))
      ? Number(item.score)
      : null
  };
}

app.post("/api/search", auth, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  const apiKey = String(process.env.TAVILY_API_KEY || "").trim();

  if (!apiKey) {
    return res.status(503).json({
      error: "Интернет-поиск ещё не настроен. Добавь TAVILY_API_KEY в переменные окружения Render.",
      code: "SEARCH_NOT_CONFIGURED"
    });
  }

  const query = String(req.body.query || "").trim();

  if (!query) {
    return res.status(400).json({
      error: "Введи поисковый запрос."
    });
  }

  if (query.length > 500) {
    return res.status(400).json({
      error: "Поисковый запрос не должен превышать 500 символов."
    });
  }

  if (!checkWebSearchRateLimit(req.user.id)) {
    return res.status(429).json({
      error: "Слишком много поисковых запросов. Подожди минуту и попробуй снова.",
      code: "SEARCH_RATE_LIMIT"
    });
  }

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        topic: "general",
        max_results: 8,
        chunks_per_source: 2,
        include_answer: true,
        include_raw_content: false,
        include_images: false,
        include_favicon: true,
        include_usage: true,
        safe_search: true
      }),
      signal: AbortSignal.timeout(30000)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const providerMessage =
        data?.detail?.error ||
        data?.detail ||
        data?.error ||
        `Tavily HTTP ${response.status}`;

      console.error("Tavily search error:", response.status, providerMessage);

      if (response.status === 401) {
        return res.status(503).json({
          error: "Поиск не авторизован. Проверь TAVILY_API_KEY в Render.",
          code: "SEARCH_AUTH_ERROR"
        });
      }

      if ([429, 432, 433, 434].includes(response.status)) {
        return res.status(503).json({
          error: "Сервис поиска временно ограничил запросы или закончились доступные кредиты. Проверь лимит Tavily и попробуй позже.",
          code: "SEARCH_PROVIDER_LIMIT"
        });
      }

      return res.status(502).json({
        error: "Провайдер интернет-поиска временно не отвечает. Попробуй позже.",
        code: "SEARCH_PROVIDER_ERROR"
      });
    }

    const results = (Array.isArray(data.results) ? data.results : [])
      .map(normalizeSearchResult)
      .filter(Boolean)
      .slice(0, 8);

    return res.json({
      success: true,
      query,
      answer: String(data.answer || "").slice(0, 6000),
      results,
      responseTime: data.response_time || null,
      usage: data.usage && Number.isFinite(Number(data.usage.credits))
        ? { credits: Number(data.usage.credits) }
        : null
    });

  } catch (error) {
    console.error("Internet search error:", error.message);

    const timedOut = error.name === "TimeoutError" ||
      error.name === "AbortError";

    return res.status(503).json({
      error: timedOut
        ? "Поиск занял слишком много времени. Попробуй ещё раз."
        : "Не удалось выполнить интернет-поиск. Попробуй позже.",
      code: timedOut ? "SEARCH_TIMEOUT" : "SEARCH_UNAVAILABLE"
    });
  }
});


// ==========================================
// CHAT HISTORY
// ==========================================

app.get("/api/history", auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, title, created_at
      FROM conversations
      WHERE user_id = $1
      ORDER BY created_at DESC
    `, [req.user.id]);

    res.json(result.rows);

  } catch (error) {
    console.error("History error:", error.message);

    res.status(500).json({
      error: "Не удалось получить историю."
    });
  }
});

app.get("/api/history/:id", auth, async (req, res) => {
  try {
    const conversation = await pool.query(`
      SELECT id
      FROM conversations
      WHERE id = $1 AND user_id = $2
    `, [req.params.id, req.user.id]);

    if (!conversation.rows.length) {
      return res.status(404).json({
        error: "Чат не найден."
      });
    }

    const result = await pool.query(`
      SELECT role, content, created_at
      FROM messages
      WHERE conversation_id = $1
      ORDER BY id ASC
    `, [req.params.id]);

    res.json(result.rows);

  } catch (error) {
    console.error("History detail error:", error.message);

    res.status(500).json({
      error: "Не удалось получить сообщения."
    });
  }
});


// ==========================================
// MEMORY
// ==========================================

app.post("/api/memory", auth, async (req, res) => {
  try {
    const content = String(req.body.content || "").trim();

    if (!content) {
      return res.status(400).json({
        error: "Пустая память."
      });
    }

    const result = await pool.query(`
      INSERT INTO memories (user_id, content)
      VALUES ($1, $2)
      RETURNING id
    `, [req.user.id, content]);

    res.json({
      success: true,
      id: result.rows[0].id
    });

  } catch (error) {
    console.error("Memory insert error:", error.message);

    res.status(500).json({
      error: "Не удалось сохранить память."
    });
  }
});

app.get("/api/memory", auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, content, created_at
      FROM memories
      WHERE user_id = $1
      ORDER BY id DESC
    `, [req.user.id]);

    res.json(result.rows);

  } catch (error) {
    console.error("Memory list error:", error.message);

    res.status(500).json({
      error: "Не удалось получить память."
    });
  }
});

app.delete("/api/memory/:id", auth, async (req, res) => {
  try {
    await pool.query(`
      DELETE FROM memories
      WHERE id = $1 AND user_id = $2
    `, [req.params.id, req.user.id]);

    res.json({ success: true });

  } catch (error) {
    console.error("Memory delete error:", error.message);

    res.status(500).json({
      error: "Не удалось удалить память."
    });
  }
});


// ==========================================
// GEMINI API
// ==========================================

function convertToGeminiContents(messages) {
  const supportedImageTypes = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp"
  ]);

  return (Array.isArray(messages) ? messages : [])
    .filter(message => message && message.role !== "system")
    .map(message => {
      const role = message.role === "assistant" ? "model" : "user";
      const rawContent = message.content;
      const items = Array.isArray(rawContent)
        ? rawContent
        : [{ type: "text", text: String(rawContent ?? "") }];

      const parts = items.map(item => {
        if (!item) return null;

        if (item.type === "text") {
          const text = String(item.text ?? "");
          return text ? { text } : null;
        }

        if (item.type === "image_url") {
          const url = String(item.image_url?.url || "").trim();
          const match = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/i);

          if (!match) {
            return { text: "[Изображение не удалось обработать: неверный формат данных]" };
          }

          let mimeType = match[1].toLowerCase();
          if (mimeType === "image/jpg" || mimeType === "image/pjpeg") {
            mimeType = "image/jpeg";
          }

          if (!supportedImageTypes.has(mimeType)) {
            return { text: "[Изображение не удалось обработать: формат не поддерживается]" };
          }

          const data = match[2].replace(/\s+/g, "");
          if (!data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1) {
            return { text: "[Изображение не удалось обработать: повреждённые данные]" };
          }

          return {
            inlineData: {
              mimeType,
              data
            }
          };
        }

        return null;
      }).filter(Boolean);

      return { role, parts };
    })
    .filter(message => message.parts.length > 0);
}

async function askAI(messages) {
  const systemText = messages
    .filter(message => message.role === "system")
    .map(message => typeof message.content === "string"
      ? message.content
      : String(message.content || "")
    )
    .filter(Boolean)
    .join("\n\n");

  const contents = convertToGeminiContents(messages);

  if (!contents.length) {
    throw new Error("Нет сообщений для отправки в Gemini.");
  }

  return executeWithKeyRotation(
    pool,
    async (apiKey, { signal }) => {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            ...(systemText
              ? {
                  systemInstruction: {
                    parts: [{ text: systemText }]
                  }
                }
              : {}),
            contents,
            generationConfig: {
              maxOutputTokens: 4096
            }
          }),
          signal
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const error = new Error(
          data?.error?.message ||
          `Gemini API вернул HTTP ${response.status}`
        );

        error.status = response.status;

        throw error;
      }

      const candidate = data.candidates?.[0];

      const answer = (candidate?.content?.parts || [])
        .filter(part => typeof part.text === "string")
        .map(part => part.text)
        .join("\n")
        .trim();

      if (!answer) {
        const reason = candidate?.finishReason;

        throw new Error(
          reason
            ? `Gemini не вернул текстовый ответ. Причина: ${reason}`
            : "Gemini не вернул текстовый ответ."
        );
      }

      return answer;
    },
    { maxAttempts: 5 }
  );
}


// ==========================================
// CHAT WITH FILES AND IMAGES
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
        messageReserved = await reserveMessage(userId);

        if (!messageReserved) {
          const usage = await getUsage(userId);

          return res.status(429).json({
            error: "Дневной лимит сообщений исчерпан.",
            code: "DAILY_LIMIT_REACHED",
            plan: req.user.role,
            used: usage.messages,
            limit: limits.messages
          });
        }
      }

      if (files.length > 0 && limits.files !== Infinity) {
        filesReserved = await reserveCounter(
          userId,
          "files",
          files.length,
          limits.files
        );

        if (!filesReserved) {
          if (messageReserved) await releaseMessage(userId);

          const usage = await getUsage(userId);

          return res.status(429).json({
            error: "Дневной лимит файлов исчерпан.",
            code: "FILE_LIMIT_REACHED",
            used: usage.files,
            limit: limits.files
          });
        }
      }

      const conversationResult = await pool.query(`
        SELECT id, user_id
        FROM conversations
        WHERE id = $1
      `, [conversationId]);

      const conversation = conversationResult.rows[0];

      if (conversation && conversation.user_id !== userId) {
        if (conversation.user_id === null) {
          const claimed = await pool.query(`
            UPDATE conversations
            SET user_id = $1
            WHERE id = $2 AND user_id IS NULL
          `, [userId, conversationId]);

          if (claimed.rowCount !== 1) {
            if (messageReserved) await releaseMessage(userId);

            if (filesReserved) {
              await releaseCounter(userId, "files", files.length);
            }

            return res.status(403).json({
              error: "Нет доступа к этому чату."
            });
          }
        } else {
          if (messageReserved) await releaseMessage(userId);

          if (filesReserved) {
            await releaseCounter(userId, "files", files.length);
          }

          return res.status(403).json({
            error: "Нет доступа к этому чату."
          });
        }
      }

      if (!conversation) {
        await pool.query(`
          INSERT INTO conversations (id, title, user_id)
          VALUES ($1, $2, $3)
        `, [
          conversationId,
          (message || "Прикреплённые файлы").slice(0, 60),
          userId
        ]);
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

      await pool.query(`
        INSERT INTO messages (conversation_id, role, content)
        VALUES ($1, 'user', $2)
      `, [conversationId, userContent]);

      const recentResult = await pool.query(`
        SELECT role, content
        FROM messages
        WHERE conversation_id = $1
        ORDER BY id DESC
        LIMIT 15
      `, [conversationId]);

      const recentMessages = recentResult.rows.reverse();

      const memoryResult = await pool.query(`
        SELECT content
        FROM memories
        WHERE user_id = $1
        ORDER BY id DESC
        LIMIT 30
      `, [userId]);

      const context = memoryResult.rows
        .map(item => item.content)
        .join("\n");

      const history = recentMessages.map(item => ({
        role: item.role,
        content: item.content
      }));

      if (imageParts.length > 0) {
        const lastUserIndex = history.map(item => item.role).lastIndexOf("user");

        if (lastUserIndex !== -1) {
          const lastUserMessage = history[lastUserIndex];
          const previousContent = Array.isArray(lastUserMessage.content)
            ? lastUserMessage.content
            : [{
                type: "text",
                text: String(lastUserMessage.content ?? "")
              }];

          lastUserMessage.content = [
            ...previousContent,
            ...imageParts
          ];
        }
      }

      const answer = await askAI([
        {
          role: "system",
          content:
            "Ты Pinsk — интеллектуальный ИИ-ассистент. " +
            "Отвечай полезно, точно, естественно и на языке пользователя. " +
            "Сначала пойми конкретный вопрос пользователя и отвечай именно на него. " +
            "Не ограничивайся общими фразами, если можно дать конкретный ответ.\n\n" +

            "ПРАВИЛА ГЛУБОКОГО АНАЛИЗА ИЗОБРАЖЕНИЙ:\n" +
            "1. Внимательно рассматривай все переданные изображения и анализируй их содержимое, " +
            "а не только имя файла или текстовое описание вложения.\n" +
            "2. Подробно распознавай видимые объекты и их признаки: форму, цвет, материал, " +
            "надписи, маркировки, логотипы, детали конструкции, расположение и контекст.\n" +
            "3. Для техники, телефонов, компьютеров, автомобилей, одежды, обуви, предметов, " +
            "зданий и товаров определяй возможную категорию, марку или модель по видимым " +
            "отличительным признакам. Разделяй подтверждённое и предположительное.\n" +
            "4. Если просят определить предмет или модель, сначала перечисли конкретные " +
            "визуальные признаки, затем дай наиболее вероятный вариант. Если точность " +
            "недостаточна, назови несколько вариантов или попроси более чёткое фото.\n" +
            "5. Внимательно читай видимый текст на вывесках, упаковках, документах, " +
            "скриншотах, интерфейсах, схемах, графиках и таблицах. Сохраняй числа, " +
            "единицы измерения и регистр там, где это важно. Не додумывай нечитаемые фрагменты.\n" +
            "6. Для скриншотов интерфейсов объясняй, какие элементы видны, что они означают " +
            "и какие действия доступны. Для ошибок на экране точно переписывай сообщение " +
            "об ошибке, если оно читается.\n" +
            "7. Для диаграмм и таблиц извлекай структуру, сравнивай значения и делай выводы " +
            "только на основании отображённых данных. Указывай, если часть таблицы обрезана.\n" +
            "8. Для еды, растений и животных описывай заметные признаки и вероятную категорию. " +
            "Не делай медицинских или иных высокорисковых выводов только по фотографии.\n" +
            "9. Если на изображении несколько объектов, описывай их по отдельности и " +
            "объясняй взаимное расположение. Если изображений несколько, анализируй каждое " +
            "отдельно, а затем сравнивай их, если пользователь этого хочет.\n" +
            "10. Не устанавливай и не подтверждай личность реального человека по лицу, " +
            "даже если это знаменитость. Вместо этого подробно опиши видимые признаки: " +
            "одежду, причёску, аксессуары, татуировки, позу и окружение.\n" +
            "11. Если пользователь сам назвал человека, можешь использовать это имя как " +
            "предоставленный пользователем контекст, но не утверждай, что распознал или " +
            "подтвердил личность по лицу.\n" +
            "12. Не угадывай личность, название песни, альбома, фильма, бренд или событие " +
            "без достаточных визуальных оснований. Если есть читаемый логотип или надпись, " +
            "опирайся прежде всего на них.\n" +
            "13. Не путай похожих людей, персонажей, модели устройств и бренды. Объясняй, " +
            "какие детали подтверждают твой вывод, а какие остаются неопределёнными.\n" +
            "14. Если пользователь исправил описание, учитывай исправление и не повторяй " +
            "уже опровергнутую ошибку.\n" +
            "15. Не заявляй, что изображение не прикреплено или недоступно, если в контекст " +
            "переданы его визуальные данные. Если данные действительно не поступили, " +
            "честно сообщи об этом.\n\n" +

            "РАБОТА С ФАЙЛАМИ:\n" +
            "Анализируй прикреплённые документы, PDF, таблицы, текстовые файлы и изображения. " +
            "Используй извлечённый текст, сохраняй структуру документа, названия листов, " +
            "заголовки, значения и связи между разделами. Не утверждай, что файл не прикреплён, " +
            "если его содержимое передано в сообщении. Если извлечение неполное, укажи это.\n\n" +

            "ОБЩИЕ ПРАВИЛА:\n" +
            "Не выдумывай факты, источники, цифры или детали. Отличай факт от гипотезы. " +
            "Если не уверен, прямо обозначь степень уверенности. Учитывай историю диалога " +
            "и сохранённую память, если они относятся к вопросу. Пиши понятно и по делу, " +
            "при необходимости используй списки и пошаговые инструкции.\n\n" +

            "ПАМЯТЬ:\n" + context.slice(0, 10000)
        },
        ...history
      ]);

      await pool.query(`
        INSERT INTO messages (conversation_id, role, content)
        VALUES ($1, 'assistant', $2)
      `, [conversationId, answer]);

      const usage = await getUsage(userId);

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

      if (messageReserved) {
        await releaseMessage(userId).catch(() => {});
      }

      if (filesReserved) {
        await releaseCounter(userId, "files", files.length)
          .catch(() => {});
      }

      const status = error instanceof multer.MulterError
        ? 400
        : ([429, 529].includes(error.status) ? 503 : 500);

      res.status(status).json({
        error: error instanceof multer.MulterError
          ? "Ошибка загрузки файла: " + error.message
          : status === 503
            ? "Gemini API временно перегружен или все ключи заняты. Попробуй позже."
            : "Ошибка ИИ-сервера. Проверь настройки модели и API."
      });
    }
  }
);


// ==========================================
// CLOUDFLARE WORKERS AI — IMAGE GENERATION
// ==========================================

async function generateCloudflareImage(prompt) {
  const apiToken = String(
    process.env.CLOUDFLARE_API_TOKEN || ""
  ).trim();

  const accountId = String(CLOUDFLARE_ACCOUNT_ID || "").trim();

  if (!apiToken) {
    const error = new Error(
      "CLOUDFLARE_API_TOKEN не настроен в Render."
    );
    error.status = 503;
    throw error;
  }

  if (!accountId) {
    const error = new Error(
      "CLOUDFLARE_ACCOUNT_ID не настроен в Render."
    );
    error.status = 503;
    throw error;
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${IMAGE_MODEL}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        prompt: String(prompt).slice(0, 2048),
        steps: 4
      }),
      signal: AbortSignal.timeout(180000)
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.success === false) {
    const providerError =
      data?.errors?.map(item => item.message).join("; ") ||
      data?.error?.message ||
      `Cloudflare Workers AI HTTP ${response.status}`;

    const error = new Error(providerError);
    error.status = response.status || 500;

    console.error("Cloudflare Workers AI:", providerError);

    throw error;
  }

  const imageData = data?.result?.image;

  if (typeof imageData !== "string" || !imageData) {
    throw new Error(
      "Cloudflare Workers AI не вернул готовое изображение."
    );
  }

  const imageBuffer = Buffer.from(imageData, "base64");

  if (
    !imageBuffer.length ||
    imageBuffer.length > 20 * 1024 * 1024
  ) {
    throw new Error(
      "Cloudflare вернул изображение некорректного размера."
    );
  }

  return {
    mimeType: "image/png",
    data: imageData,
    text: ""
  };
}


// ==========================================
// MULTILINGUAL IMAGE PROMPT UNDERSTANDING
// ==========================================

async function prepareImagePrompt(prompt) {
  const source = String(prompt || "").trim();

  // English prompts already work well with FLUX: do not add an extra API call.
  // For Russian and other Cyrillic prompts, convert the meaning into a precise
  // visual prompt before sending it to the image model.
  if (!/[\u0400-\u04FF]/u.test(source)) {
    return source;
  }

  const translated = await askAI([
    {
      role: "system",
      content:
        "You are a professional image-prompt translator for the FLUX image model. " +
        "Translate the user's image request into clear, natural English. " +
        "Preserve the exact meaning and every named object. Do not replace, reinterpret, " +
        "or invent objects. A short request must remain short and literal: for example, " +
        "'гора' means 'a mountain', never food or noodles. If the request is one or two " +
        "words, translate those words directly without adding a scene. If it describes " +
        "a scene, preserve its subject, setting, style, colors, composition, and details. " +
        "Return only the English image prompt, with no explanations, quotes, or markdown."
    },
    { role: "user", content: source }
  ]);

  const result = String(translated || "")
    .replace(/^```(?:text)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim()
    .replace(/^["']|["']$/g, "");

  if (!result) {
    throw new Error("Не удалось правильно обработать русское описание изображения.");
  }

  console.log("Pinsk: русское описание изображения обработано.");
  return result.slice(0, 2048);
}


async function imageGenerationHandler(req, res) {
  let reserved = false;

  try {
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
      reserved = await reserveCounter(
        req.user.id,
        "images",
        1,
        limits.images
      );

      if (!reserved) {
        const usage = await getUsage(req.user.id);

        return res.status(429).json({
          error: "Дневной лимит генерации изображений исчерпан.",
          code: "IMAGE_LIMIT_REACHED",
          used: usage.images,
          limit: limits.images
        });
      }
    }

    const imagePrompt = await prepareImagePrompt(prompt);
    const result = await generateCloudflareImage(imagePrompt);

    res.json({
      success: true,
      model: IMAGE_MODEL,
      image: `data:${result.mimeType};base64,${result.data}`,
      mimeType: result.mimeType,
      text: result.text,
      usage: await getUsage(req.user.id)
    });

  } catch (error) {
    console.error(
      "Cloudflare Workers AI image generation error:",
      error.message
    );

    if (reserved) {
      await releaseCounter(req.user.id, "images", 1)
        .catch(() => {});
    }

    const status =
      error.name === "TimeoutError" ||
      error.name === "AbortError" ||
      error.status === 429 ||
      error.status === 401 ||
      error.status === 403 ||
      (error.status >= 500 && error.status <= 599)
        ? 503
        : 500;

    res.status(status).json({
      error: status === 503
        ? "Cloudflare Workers AI временно недоступен, превышен лимит или не хватает разрешений. Попробуй позже."
        : "Не удалось создать изображение. Проверь описание и настройки Cloudflare."
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
// DESIGN STUDIO — WEBSITE GENERATION
// ==========================================

app.post("/api/design/generate", auth, async (req, res) => {
  let messageReserved = false;

  try {
    const prompt = String(req.body.prompt || "").trim();

    if (!prompt) {
      return res.status(400).json({ error: "Опиши сайт, который нужно создать." });
    }

    if (prompt.length > 5000) {
      return res.status(400).json({ error: "Описание сайта не должно превышать 5000 символов." });
    }

    const limits = limitsFor(req.user);
    if (limits.messages !== Infinity) {
      messageReserved = await reserveMessage(req.user.id);
      if (!messageReserved) {
        const usage = await getUsage(req.user.id);
        return res.status(429).json({
          error: "Дневной лимит сообщений исчерпан.",
          code: "DAILY_LIMIT_REACHED",
          used: usage.messages,
          limit: limits.messages
        });
      }
    }

    const answer = await askAI([
      {
        role: "system",
        content:
          "Ты — senior frontend-разработчик и UI/UX-дизайнер Pinsk AI. " +
          "Создавай законченные, адаптивные, визуально качественные сайты. " +
          "Верни строго один JSON-объект без Markdown и пояснений, с ключами html, css, js. " +
          "html — только содержимое body без тегов style и script; css — полный CSS; js — JavaScript без тегов script. " +
          "Не используй внешние библиотеки, CDN, внешние шрифты и сетевые запросы. " +
          "Все изображения подключай только через безопасные публичные URL или CSS-градиенты; не выдумывай локальные файлы. " +
          "Код должен работать автономно в sandbox iframe. Добавляй доступность, адаптивность и интерактивность. " +
          "Все текстовые значения JSON должны быть корректно экранированы."
      },
      {
        role: "user",
        content: "Создай сайт по этому заданию.\n\n" + prompt
      }
    ]);

    let generated;
    try {
      const cleaned = String(answer)
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start < 0 || end <= start) throw new Error("JSON not found");
      generated = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      throw new Error("ИИ вернул некорректный формат проекта. Повтори запрос.");
    }

    const html = String(generated.html || "").slice(0, 120000);
    const css = String(generated.css || "").slice(0, 120000);
    const js = String(generated.js || "").slice(0, 120000);

    if (!html.trim()) {
      throw new Error("ИИ не создал HTML-разметку. Попробуй уточнить запрос.");
    }

    return res.json({ success: true, html, css, js });

  } catch (error) {
    console.error("Design Studio generation error:", error.message);
    if (messageReserved) {
      await releaseMessage(req.user.id).catch(() => {});
    }

    const status = [429, 529].includes(error.status) ? 503 : 500;
    return res.status(status).json({
      error: status === 503
        ? "ИИ временно перегружен. Попробуй создать сайт позже."
        : error.message || "Не удалось создать сайт. Попробуй изменить описание."
    });
  }
});


// ==========================================
// DATA ANALYSIS
// ==========================================

app.post("/api/analysis", auth, async (req, res) => {
  try {
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

    const status = [429, 529].includes(error.status) ? 503 : 500;

    res.status(status).json({
      error: status === 503
        ? "Gemini API временно перегружен или все ключи заняты. Попробуй позже."
        : "Не удалось выполнить анализ данных."
    });
  }
});


// ==========================================
// STATIC WEBSITE AND SECURITY
// ==========================================

app.use((req, res, next) => {
  const blockedFiles =
    /(^|\/)(server\.js|key-manager\.js|pinsk\.db(?:-(wal|shm|journal))?|\.env(?:\.[^/]*)?|package(?:-lock)?\.json|yarn\.lock|pnpm-lock\.yaml)(\/|$)/i;

  const blockedDirs =
    /(^|\/)(node_modules|\.git|\.github)(\/|$)/i;

  let pathname;

  try {
    pathname = decodeURIComponent(req.path).replace(/\\/g, "/");
  } catch {
    return res.sendStatus(400);
  }

  if (blockedFiles.test(pathname) || blockedDirs.test(pathname)) {
    return res.sendStatus(404);
  }

  next();
});

app.use(express.static(__dirname, {
  index: "index.html",
  dotfiles: "deny"
}));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});


// ==========================================
// ERROR HANDLING
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
// START SERVER
// ==========================================

async function startServer() {
  try {
    await initializeDatabase();

    const keys = await getGeminiKeys();
    const activeKeys = keys.filter(isKeyActive).length;

    app.listen(PORT, () => {
      console.log("================================");
      console.log("          PINSK AI");
      console.log("================================");
      console.log("Порт:", PORT);
      console.log("База данных: Supabase PostgreSQL");
      console.log("Модель чата:", MODEL);
      console.log("Модель изображений Cloudflare:", IMAGE_MODEL);
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

  } catch (error) {
    console.error("Pinsk startup error:", error);
    process.exit(1);
  }
}

startServer();


// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================

async function shutdown(signal) {
  console.log(`Pinsk: получен сигнал ${signal}, остановка...`);

  try {
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error("Shutdown error:", error.message);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

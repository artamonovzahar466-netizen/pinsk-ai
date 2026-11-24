
"use strict";

const crypto = require("crypto");

const LEASE_MS = 35000;
const HEARTBEAT_MS = 15000;
const KEY_WAIT_MS = 12000;
const KEY_WAIT_INTERVAL_MS = 400;
const MAX_ATTEMPTS = 5;
const QUOTA_COOLDOWN_MS = 10 * 60 * 1000;
const SERVER_COOLDOWN_MS = 5000;

let cachedKeys = null;

function deriveKeys() {
  if (cachedKeys) return cachedKeys;

  const secret = String(process.env.ENCRYPTION_SECRET_KEY || "");

  if (secret.length < 16) {
    throw new Error(
      "ENCRYPTION_SECRET_KEY не задан или слишком короткий."
    );
  }

  cachedKeys = {
    encryption: crypto.scryptSync(
      secret,
      "pinsk-enc-salt",
      32
    ),
    hmac: crypto.scryptSync(
      secret,
      "pinsk-hmac-salt",
      32
    )
  };

  return cachedKeys;
}

function hashApiKey(apiKey) {
  return crypto
    .createHmac("sha256", deriveKeys().hmac)
    .update(String(apiKey))
    .digest("hex");
}

function encryptApiKey(apiKey) {
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    deriveKeys().encryption,
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(String(apiKey), "utf8"),
    cipher.final()
  ]);

  return {
    encrypted_key: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    auth_tag: cipher.getAuthTag().toString("base64")
  };
}

function decryptApiKey(row) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    deriveKeys().encryption,
    Buffer.from(row.iv, "base64")
  );

  decipher.setAuthTag(
    Buffer.from(row.auth_tag, "base64")
  );

  return Buffer.concat([
    decipher.update(
      Buffer.from(row.encrypted_key, "base64")
    ),
    decipher.final()
  ]).toString("utf8");
}

function maskApiKey(apiKey) {
  const value = String(apiKey);

  if (value.length <= 8) {
    return "*".repeat(value.length);
  }

  return value.slice(0, 4) +
    "*".repeat(Math.max(4, value.length - 8)) +
    value.slice(-4);
}

function hasColumn(db, table, column) {
  return db.prepare(
    `PRAGMA table_info(${table})`
  ).all().some(item => item.name === column);
}

function addColumnIfMissing(db, table, column, definition) {
  if (!hasColumn(db, table, column)) {
    db.exec(
      `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`
    );
  }
}

function initGeminiKeysTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gemini_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash TEXT UNIQUE NOT NULL,
      masked_key TEXT NOT NULL,
      encrypted_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      usage_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      last_used DATETIME,
      last_error TEXT,
      cooldown_until DATETIME,
      lease_until DATETIME,
      lease_token TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  addColumnIfMissing(
    db, "gemini_keys", "key_hash", "TEXT"
  );

  addColumnIfMissing(
    db, "gemini_keys", "masked_key", "TEXT"
  );

  addColumnIfMissing(
    db, "gemini_keys", "encrypted_key", "TEXT"
  );

  addColumnIfMissing(
    db, "gemini_keys", "iv", "TEXT"
  );

  addColumnIfMissing(
    db, "gemini_keys", "auth_tag", "TEXT"
  );

  addColumnIfMissing(
    db, "gemini_keys", "is_active", "INTEGER DEFAULT 1"
  );

  addColumnIfMissing(
    db, "gemini_keys", "usage_count", "INTEGER DEFAULT 0"
  );

  addColumnIfMissing(
    db, "gemini_keys", "error_count", "INTEGER DEFAULT 0"
  );

  addColumnIfMissing(
    db, "gemini_keys", "last_used", "DATETIME"
  );

  addColumnIfMissing(
    db, "gemini_keys", "last_error", "TEXT"
  );

  addColumnIfMissing(
    db, "gemini_keys", "cooldown_until", "DATETIME"
  );

  addColumnIfMissing(
    db, "gemini_keys", "lease_until", "DATETIME"
  );

  addColumnIfMissing(
    db, "gemini_keys", "lease_token", "TEXT"
  );

  addColumnIfMissing(
    db, "gemini_keys", "created_at",
    "DATETIME DEFAULT CURRENT_TIMESTAMP"
  );

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_gemini_keys_active
    ON gemini_keys(is_active);

    CREATE INDEX IF NOT EXISTS idx_gemini_keys_lease
    ON gemini_keys(lease_until);

    CREATE INDEX IF NOT EXISTS idx_gemini_keys_cooldown
    ON gemini_keys(cooldown_until);
  `);
}

function getAllKeys(db) {
  return db.prepare(`
    SELECT
      id,
      masked_key,
      is_active,
      usage_count,
      error_count,
      last_used,
      last_error,
      cooldown_until,
      created_at
    FROM gemini_keys
    ORDER BY id DESC
  `).all();
}

function insertKey(db, apiKey) {
  const value = String(apiKey || "").trim();

  if (value.length < 10 || value.length > 500) {
    throw new Error("Некорректный Gemini API-ключ.");
  }

  const keyHash = hashApiKey(value);

  const existing = db.prepare(`
    SELECT id FROM gemini_keys
    WHERE key_hash = ?
  `).get(keyHash);

  if (existing) {
    throw new Error("Этот API-ключ уже добавлен.");
  }

  const encrypted = encryptApiKey(value);
  const masked = maskApiKey(value);

  const result = db.prepare(`
    INSERT INTO gemini_keys (
      key_hash,
      masked_key,
      encrypted_key,
      iv,
      auth_tag,
      is_active,
      usage_count,
      error_count
    )
    VALUES (?, ?, ?, ?, ?, 1, 0, 0)
  `).run(
    keyHash,
    masked,
    encrypted.encrypted_key,
    encrypted.iv,
    encrypted.auth_tag
  );

  return {
    id: result.lastInsertRowid,
    masked_key: masked
  };
}

function toggleKeyActive(db, id) {
  return db.prepare(`
    UPDATE gemini_keys
    SET
      is_active = CASE
        WHEN is_active = 1 THEN 0
        ELSE 1
      END,
      lease_until = NULL,
      lease_token = NULL
    WHERE id = ?
  `).run(id);
}

function deleteKey(db, id) {
  return db.prepare(`
    DELETE FROM gemini_keys
    WHERE id = ?
  `).run(id);
}

function getNextApiKey(db, excludedIds = []) {
  const excluded = new Set(
    (excludedIds || []).map(Number)
  );

  const now = Date.now();

  const select = db.prepare(`
    SELECT *
    FROM gemini_keys
    WHERE is_active = 1
      AND (
        cooldown_until IS NULL
        OR CAST(cooldown_until AS INTEGER) <= ?
        OR datetime(cooldown_until) <= datetime('now')
      )
      AND (
        lease_until IS NULL
        OR CAST(lease_until AS INTEGER) <= ?
        OR datetime(lease_until) <= datetime('now')
      )
    ORDER BY
      error_count ASC,
      usage_count ASC,
      last_used ASC,
      id ASC
  `);

  const update = db.prepare(`
    UPDATE gemini_keys
    SET
      lease_until = ?,
      lease_token = ?,
      last_used = CURRENT_TIMESTAMP
    WHERE id = ?
      AND is_active = 1
      AND (
        lease_until IS NULL
        OR CAST(lease_until AS INTEGER) <= ?
        OR datetime(lease_until) <= datetime('now')
      )
  `);

  const transaction = db.transaction(() => {
    const candidates = select.all(now, now);

    for (const row of candidates) {
      if (excluded.has(Number(row.id))) continue;

      const leaseToken = crypto.randomUUID();
      const leaseUntil = now + LEASE_MS;

      const result = update.run(
        leaseUntil,
        leaseToken,
        row.id,
        now
      );

      if (result.changes !== 1) continue;

      return {
        id: row.id,
        apiKey: decryptApiKey(row),
        leaseToken
      };
    }

    return null;
  });

  return transaction.immediate();
}

function extendKeyLease(db, keyId, leaseToken) {
  return db.prepare(`
    UPDATE gemini_keys
    SET lease_until = ?
    WHERE id = ?
      AND lease_token = ?
      AND is_active = 1
  `).run(
    Date.now() + LEASE_MS,
    keyId,
    leaseToken
  );
}

function recordKeyResultAndRelease(
  db,
  keyId,
  leaseToken,
  result = {}
) {
  const success = result.success === true;
  const errorMessage = result.error
    ? String(result.error.message || result.error).slice(0, 1000)
    : null;

  if (success) {
    return db.prepare(`
      UPDATE gemini_keys
      SET
        usage_count = usage_count + 1,
        error_count = MAX(0, error_count - 1),
        last_error = NULL,
        cooldown_until = NULL,
        lease_until = NULL,
        lease_token = NULL
      WHERE id = ?
        AND lease_token = ?
    `).run(keyId, leaseToken);
  }

  const cooldownUntil = result.cooldownUntil || null;

  return db.prepare(`
    UPDATE gemini_keys
    SET
      error_count = error_count + 1,
      last_error = ?,
      cooldown_until = COALESCE(?, cooldown_until),
      lease_until = NULL,
      lease_token = NULL
    WHERE id = ?
      AND lease_token = ?
  `).run(
    errorMessage,
    cooldownUntil,
    keyId,
    leaseToken
  );
}

function getErrorStatus(error) {
  const status = Number(error?.status || error?.statusCode);

  return Number.isFinite(status) ? status : 0;
}

function getErrorCode(error) {
  return String(
    error?.code ||
    error?.cause?.code ||
    ""
  ).toUpperCase();
}

function isQuotaError(error) {
  const status = getErrorStatus(error);
  const message = String(error?.message || "").toLowerCase();

  return status === 429 ||
    message.includes("quota exceeded") ||
    message.includes("resource_exhausted") ||
    message.includes("rate limit") ||
    message.includes("requests per minute") ||
    message.includes("limit exceeded");
}

function isInvalidKeyError(error) {
  const status = getErrorStatus(error);
  const message = String(error?.message || "").toLowerCase();

  if (status === 401) return true;

  return (
    (status === 400 || status === 403) &&
    (
      message.includes("api key not valid") ||
      message.includes("invalid api key") ||
      message.includes("api_key_invalid") ||
      message.includes("permission denied") ||
      message.includes("key is not valid")
    )
  );
}

function isNetworkError(error) {
  const code = getErrorCode(error);
  const message = String(error?.message || "").toLowerCase();

  const networkCodes = [
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENOTFOUND",
    "EPIPE",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET"
  ];

  return networkCodes.includes(code) ||
    message.includes("fetch failed") ||
    message.includes("failed to fetch") ||
    message.includes("network error") ||
    message.includes("socket hang up") ||
    message.includes("timed out") ||
    message.includes("timeout");
}

function isTransientError(error) {
  const status = getErrorStatus(error);

  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500 ||
    isNetworkError(error)
  );
}

function isServerTransientError(error) {
  const status = getErrorStatus(error);

  return status === 408 ||
    status === 425 ||
    status >= 500 ||
    isNetworkError(error);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForAvailableKey(db, excludedIds, startedAt) {
  while (Date.now() - startedAt < KEY_WAIT_MS) {
    const key = getNextApiKey(db, excludedIds);

    if (key) return key;

    await wait(KEY_WAIT_INTERVAL_MS);
  }

  return null;
}

async function executeWithKeyRotation(
  db,
  callback,
  options = {}
) {
  if (typeof callback !== "function") {
    throw new TypeError("Не передана функция запроса к Gemini.");
  }

  const excludedIds = new Set();
  const maxAttempts = Math.max(
    1,
    Math.min(
      Number(options.maxAttempts) || MAX_ATTEMPTS,
      20
    )
  );

  const startedAt = Date.now();
  let lastError = null;
  let attempts = 0;

  while (attempts < maxAttempts) {
    let key = getNextApiKey(db, [...excludedIds]);

    if (!key && attempts === 0) {
      key = await waitForAvailableKey(
        db,
        [...excludedIds],
        startedAt
      );
    }

    if (!key) break;

    attempts += 1;
    excludedIds.add(Number(key.id));

    const controller = new AbortController();

    const heartbeat = setInterval(() => {
      try {
        extendKeyLease(
          db,
          key.id,
          key.leaseToken
        );
      } catch (error) {
        console.error(
          "Gemini key lease heartbeat error:",
          error.message
        );
      }
    }, HEARTBEAT_MS);

    if (typeof heartbeat.unref === "function") {
      heartbeat.unref();
    }

    let finished = false;

    try {
      const result = await callback(
        key.apiKey,
        {
          signal: controller.signal,
          keyId: key.id,
          attempt: attempts
        }
      );

      recordKeyResultAndRelease(
        db,
        key.id,
        key.leaseToken,
        { success: true }
      );

      finished = true;
      return result;

    } catch (error) {
      lastError = error;

      const status = getErrorStatus(error);
      const invalidKey = isInvalidKeyError(error);
      const quotaError = isQuotaError(error);
      const transientError = isTransientError(error);

      let cooldownUntil = null;

      if (quotaError) {
        cooldownUntil = Date.now() + QUOTA_COOLDOWN_MS;
      } else if (isServerTransientError(error)) {
        cooldownUntil = Date.now() + SERVER_COOLDOWN_MS;
      }

      recordKeyResultAndRelease(
        db,
        key.id,
        key.leaseToken,
        {
          success: false,
          error,
          cooldownUntil
        }
      );

      finished = true;

      if (invalidKey) {
        try {
          db.prepare(`
            UPDATE gemini_keys
            SET
              is_active = 0,
              last_error = ?,
              lease_until = NULL,
              lease_token = NULL
            WHERE id = ?
          `).run(
            String(error.message || "Invalid API key").slice(0, 1000),
            key.id
          );
        } catch (dbError) {
          console.error(
            "Gemini invalid key update error:",
            dbError.message
          );
        }

        console.error(
          `Gemini key #${key.id} disabled: invalid API key.`
        );

        continue;
      }

      if (transientError || quotaError) {
        console.error("Gemini key request failed:", {
          keyId: key.id,
          status,
          code: getErrorCode(error) || null,
          attempt: attempts,
          message: String(error.message || error).slice(0, 500)
        });

        continue;
      }

      throw error;

    } finally {
      clearInterval(heartbeat);

      if (!finished) {
        try {
          controller.abort();

          recordKeyResultAndRelease(
            db,
            key.id,
            key.leaseToken,
            {
              success: false,
              error: new Error("Запрос был прерван.")
            }
          );
        } catch (releaseError) {
          console.error(
            "Gemini key release error:",
            releaseError.message
          );
        }
      }
    }
  }

  if (lastError) {
    const error = new Error(
      "Не удалось выполнить запрос после проверки доступных Gemini API-ключей. " +
      String(lastError.message || "").slice(0, 500)
    );

    error.status = getErrorStatus(lastError);
    error.code = getErrorCode(lastError);
    error.cause = lastError;

    throw error;
  }

  const error = new Error(
    "Все Gemini API-ключи временно заняты, отключены или находятся на паузе."
  );

  error.status = 503;
  error.code = "NO_AVAILABLE_GEMINI_KEYS";

  throw error;
}

module.exports = {
  initGeminiKeysTable,
  getAllKeys,
  insertKey,
  toggleKeyActive,
  deleteKey,
  getNextApiKey,
  extendKeyLease,
  recordKeyResultAndRelease,
  executeWithKeyRotation
};

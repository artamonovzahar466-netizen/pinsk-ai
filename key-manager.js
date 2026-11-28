

"use strict";

const crypto = require("crypto");

const LEASE_MS = 35000;
const HEARTBEAT_MS = 15000;
// Ключ может быть занят параллельным запросом до истечения LEASE_MS (35 секунд).
// Ждём дольше lease, иначе чат/Design Studio ошибочно получают NO_AVAILABLE_GEMINI_KEYS.
// Do not hold short chat requests for tens of seconds waiting on a leased key.
const KEY_WAIT_MS = 2500;
const KEY_WAIT_INTERVAL_MS = 400;
const MAX_ATTEMPTS = 5;
const QUOTA_COOLDOWN_MS = 10 * 60 * 1000;
const SERVER_COOLDOWN_MS = 5000;

let cachedKeys = null;

// =====================================================
// ENCRYPTION
// =====================================================

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

// =====================================================
// POSTGRESQL HELPERS
// =====================================================

async function withTransaction(db, callback) {
  let client;
  let shouldRelease = false;

  if (typeof db.connect === "function") {
    client = await db.connect();
    shouldRelease = true;
  } else {
    client = db;
  }

  try {
    await client.query("BEGIN");

    const result = await callback(client);

    await client.query("COMMIT");

    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error(
        "PostgreSQL rollback error:",
        rollbackError.message
      );
    }

    throw error;
  } finally {
    if (shouldRelease) {
      client.release();
    }
  }
}

// =====================================================
// DATABASE INITIALIZATION
// =====================================================

async function initGeminiKeysTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS gemini_keys (
      id BIGSERIAL PRIMARY KEY,
      key_hash TEXT UNIQUE NOT NULL,
      masked_key TEXT NOT NULL,
      encrypted_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      usage_count BIGINT DEFAULT 0,
      error_count BIGINT DEFAULT 0,
      last_used TIMESTAMPTZ,
      last_error TEXT,
      cooldown_until BIGINT,
      lease_until BIGINT,
      lease_token TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const columns = [
    ["key_hash", "TEXT"],
    ["masked_key", "TEXT"],
    ["encrypted_key", "TEXT"],
    ["iv", "TEXT"],
    ["auth_tag", "TEXT"],
    ["is_active", "INTEGER DEFAULT 1"],
    ["usage_count", "BIGINT DEFAULT 0"],
    ["error_count", "BIGINT DEFAULT 0"],
    ["last_used", "TIMESTAMPTZ"],
    ["last_error", "TEXT"],
    ["cooldown_until", "BIGINT"],
    ["lease_until", "BIGINT"],
    ["lease_token", "TEXT"],
    ["created_at", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"]
  ];

  for (const [column, definition] of columns) {
    await db.query(`
      ALTER TABLE gemini_keys
      ADD COLUMN IF NOT EXISTS ${column} ${definition}
    `);
  }

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_gemini_keys_active
    ON gemini_keys(is_active);

    CREATE INDEX IF NOT EXISTS idx_gemini_keys_lease
    ON gemini_keys(lease_until);

    CREATE INDEX IF NOT EXISTS idx_gemini_keys_cooldown
    ON gemini_keys(cooldown_until);
  `);
}

// =====================================================
// GET ALL KEYS
// =====================================================

async function getAllKeys(db) {
  const result = await db.query(`
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
  `);

  if (!result || !Array.isArray(result.rows)) {
    throw new Error(
      "PostgreSQL getAllKeys: запрос не вернул массив rows."
    );
  }

  return result.rows;
}

// =====================================================
// INSERT KEY
// =====================================================

async function insertKey(db, apiKey) {
  const value = String(apiKey || "").trim();

  if (value.length < 10 || value.length > 500) {
    throw new Error("Некорректный Gemini API-ключ.");
  }

  const keyHash = hashApiKey(value);
  const encrypted = encryptApiKey(value);
  const masked = maskApiKey(value);

  try {
    const result = await db.query(`
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
      VALUES ($1, $2, $3, $4, $5, 1, 0, 0)
      RETURNING id
    `, [
      keyHash,
      masked,
      encrypted.encrypted_key,
      encrypted.iv,
      encrypted.auth_tag
    ]);

    return {
      id: result.rows[0].id,
      masked_key: masked
    };
  } catch (error) {
    if (error.code === "23505") {
      throw new Error("Этот API-ключ уже добавлен.");
    }

    throw error;
  }
}

// =====================================================
// TOGGLE KEY
// =====================================================

async function toggleKeyActive(db, id) {
  return db.query(`
    UPDATE gemini_keys
    SET
      is_active = CASE
        WHEN is_active = 1 THEN 0
        ELSE 1
      END,
      lease_until = NULL,
      lease_token = NULL
    WHERE id = $1
  `, [id]);
}

// =====================================================
// DELETE KEY
// =====================================================

async function deleteKey(db, id) {
  return db.query(`
    DELETE FROM gemini_keys
    WHERE id = $1
  `, [id]);
}

// =====================================================
// GET NEXT AVAILABLE KEY
// =====================================================

async function getNextApiKey(db, excludedIds = []) {
  const excluded = (excludedIds || [])
    .map(Number)
    .filter(Number.isSafeInteger);

  const now = Date.now();

  return withTransaction(db, async client => {
    const result = await client.query(`
      SELECT *
      FROM gemini_keys
      WHERE is_active = 1
        AND (
          cooldown_until IS NULL
          OR cooldown_until <= $1
        )
        AND (
          lease_until IS NULL
          OR lease_until <= $1
        )
        AND NOT (id = ANY($2::bigint[]))
      ORDER BY
        error_count ASC,
        usage_count ASC,
        last_used ASC NULLS FIRST,
        id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `, [now, excluded]);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    const leaseToken = crypto.randomUUID();
    const leaseUntil = now + LEASE_MS;

    await client.query(`
      UPDATE gemini_keys
      SET
        lease_until = $1,
        lease_token = $2,
        last_used = CURRENT_TIMESTAMP
      WHERE id = $3
    `, [
      leaseUntil,
      leaseToken,
      row.id
    ]);

    return {
      id: row.id,
      apiKey: decryptApiKey(row),
      leaseToken
    };
  });
}

// =====================================================
// EXTEND KEY LEASE
// =====================================================

async function extendKeyLease(db, keyId, leaseToken) {
  return db.query(`
    UPDATE gemini_keys
    SET lease_until = $1
    WHERE id = $2
      AND lease_token = $3
      AND is_active = 1
  `, [
    Date.now() + LEASE_MS,
    keyId,
    leaseToken
  ]);
}

// =====================================================
// RECORD RESULT AND RELEASE KEY
// =====================================================

async function recordKeyResultAndRelease(
  db,
  keyId,
  leaseToken,
  result = {}
) {
  const success = result.success === true;

  const errorMessage = result.error
    ? String(
        result.error.message || result.error
      ).slice(0, 1000)
    : null;

  if (success) {
    return db.query(`
      UPDATE gemini_keys
      SET
        usage_count = usage_count + 1,
        error_count = GREATEST(0, error_count - 1),
        last_error = NULL,
        cooldown_until = NULL,
        lease_until = NULL,
        lease_token = NULL
      WHERE id = $1
        AND lease_token = $2
    `, [keyId, leaseToken]);
  }

  const cooldownUntil = result.cooldownUntil || null;

  return db.query(`
    UPDATE gemini_keys
    SET
      error_count = error_count + 1,
      last_error = $1,
      cooldown_until = COALESCE($2, cooldown_until),
      lease_until = NULL,
      lease_token = NULL
    WHERE id = $3
      AND lease_token = $4
  `, [
    errorMessage,
    cooldownUntil,
    keyId,
    leaseToken
  ]);
}

// =====================================================
// ERROR CLASSIFICATION
// =====================================================

function getErrorStatus(error) {
  const status = Number(
    error?.status || error?.statusCode
  );

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
  const message = String(
    error?.message || ""
  ).toLowerCase();

  return status === 429 ||
    message.includes("quota exceeded") ||
    message.includes("resource_exhausted") ||
    message.includes("rate limit") ||
    message.includes("requests per minute") ||
    message.includes("limit exceeded");
}

function isInvalidKeyError(error) {
  const status = getErrorStatus(error);
  const message = String(
    error?.message || ""
  ).toLowerCase();

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
  const message = String(
    error?.message || ""
  ).toLowerCase();

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

// =====================================================
// WAIT FOR AVAILABLE KEY
// =====================================================

function wait(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function waitForAvailableKey(
  db,
  excludedIds,
  startedAt,
  signal = null
) {
  while (Date.now() - startedAt < KEY_WAIT_MS) {
    if (signal?.aborted) {
      const error = new Error("Запрос остановлен пользователем.");
      error.name = "AbortError";
      throw error;
    }
    const key = await getNextApiKey(
      db,
      excludedIds
    );

    if (key) return key;

    if (signal) {
      await new Promise(resolve => {
        const timer = setTimeout(done, KEY_WAIT_INTERVAL_MS);
        function done() {
          signal.removeEventListener("abort", done);
          clearTimeout(timer);
          resolve();
        }
        signal.addEventListener("abort", done, { once: true });
      });
    } else {
      await wait(KEY_WAIT_INTERVAL_MS);
    }
  }

  return null;
}

// =====================================================
// EXECUTE WITH AUTOMATIC KEY ROTATION
// =====================================================

async function executeWithKeyRotation(
  db,
  callback,
  options = {}
) {
  if (typeof callback !== "function") {
    throw new TypeError(
      "Не передана функция запроса к Gemini."
    );
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
  const externalSignal = options.signal;
  const makeAbortError = () => {
    const error = new Error("Запрос остановлен пользователем.");
    error.name = "AbortError";
    return error;
  };
  const throwIfAborted = () => {
    if (externalSignal?.aborted) throw makeAbortError();
  };

  let lastError = null;
  let attempts = 0;

  while (attempts < maxAttempts) {
    throwIfAborted();
    let key = await getNextApiKey(
      db,
      [...excludedIds]
    );

    throwIfAborted();

    if (!key && attempts === 0) {
      key = await waitForAvailableKey(
        db,
        [...excludedIds],
        startedAt,
        externalSignal
      );
    }

    throwIfAborted();
    if (!key) break;

    attempts += 1;
    excludedIds.add(Number(key.id));

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });

    const heartbeat = setInterval(async () => {
      try {
        await extendKeyLease(
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

      await recordKeyResultAndRelease(
        db,
        key.id,
        key.leaseToken,
        { success: true }
      );

      finished = true;

      return result;

    } catch (error) {
      if (externalSignal?.aborted) {
        await recordKeyResultAndRelease(
          db,
          key.id,
          key.leaseToken,
          { success: true }
        );
        finished = true;
        throw makeAbortError();
      }

      lastError = error;

      const status = getErrorStatus(error);
      const invalidKey = isInvalidKeyError(error);
      const quotaError = isQuotaError(error);
      const transientError = isTransientError(error);

      let cooldownUntil = null;

      if (quotaError) {
        cooldownUntil = Date.now() +
          QUOTA_COOLDOWN_MS;
      } else if (isServerTransientError(error)) {
        cooldownUntil = Date.now() +
          SERVER_COOLDOWN_MS;
      }

      await recordKeyResultAndRelease(
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
          await db.query(`
            UPDATE gemini_keys
            SET
              is_active = 0,
              last_error = $1,
              lease_until = NULL,
              lease_token = NULL
            WHERE id = $2
          `, [
            String(
              error.message || "Invalid API key"
            ).slice(0, 1000),
            key.id
          ]);
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
        console.error(
          "Gemini key request failed:",
          {
            keyId: key.id,
            status,
            code: getErrorCode(error) || null,
            attempt: attempts,
            message: String(
              error.message || error
            ).slice(0, 500)
          }
        );

        continue;
      }

      throw error;

    } finally {
      clearInterval(heartbeat);
      externalSignal?.removeEventListener("abort", abortFromCaller);

      if (!finished) {
        try {
          controller.abort();

          await recordKeyResultAndRelease(
            db,
            key.id,
            key.leaseToken,
            {
              success: false,
              error: new Error(
                "Запрос был прерван."
              )
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
      String(
        lastError.message || ""
      ).slice(0, 500)
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

// =====================================================
// EXPORTS
// =====================================================

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

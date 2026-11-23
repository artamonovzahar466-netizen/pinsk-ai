"use strict";

const crypto = require("crypto");

const SECRET_KEY = process.env.ENCRYPTION_SECRET_KEY;

if (
  typeof SECRET_KEY !== "string" ||
  SECRET_KEY.trim().length === 0
) {
  throw new Error(
    "CRITICAL ERROR: ENCRYPTION_SECRET_KEY is not configured."
  );
}

const ENC_KEY = crypto.scryptSync(
  SECRET_KEY,
  "pinsk-enc-salt",
  32
);

const HMAC_KEY = crypto.scryptSync(
  SECRET_KEY,
  "pinsk-hmac-salt",
  32
);

const ALGORITHM = "aes-256-gcm";

const LEASE_DURATION_MS = 35000;
const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_EXTENSION_MS = 30000;

function createAbortError(message = "Request aborted") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function initGeminiKeysTable(db) {
  if (!db || typeof db.exec !== "function") {
    throw new TypeError("A valid better-sqlite3 database is required.");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS gemini_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash TEXT,
      masked_key TEXT NOT NULL,
      encrypted_key TEXT NOT NULL,
      iv TEXT,
      auth_tag TEXT,
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

  const existingColumns = new Set(
    db.prepare("PRAGMA table_info(gemini_keys)")
      .all()
      .map(column => column.name)
  );

  const requiredColumns = [
    ["key_hash", "TEXT"],
    ["masked_key", "TEXT"],
    ["encrypted_key", "TEXT"],
    ["iv", "TEXT"],
    ["auth_tag", "TEXT"],
    ["is_active", "INTEGER DEFAULT 1"],
    ["usage_count", "INTEGER DEFAULT 0"],
    ["error_count", "INTEGER DEFAULT 0"],
    ["last_used", "DATETIME"],
    ["last_error", "TEXT"],
    ["cooldown_until", "DATETIME"],
    ["lease_until", "DATETIME"],
    ["lease_token", "TEXT"],

    // ВАЖНО:
    // При ALTER TABLE нельзя использовать
    // DEFAULT CURRENT_TIMESTAMP для старой таблицы.
    ["created_at", "DATETIME"]
  ];

  for (const [name, definition] of requiredColumns) {
    if (!existingColumns.has(name)) {
      db.exec(
        `ALTER TABLE gemini_keys ADD COLUMN ${name} ${definition};`
      );
    }
  }

  // Заполняем created_at у старых записей.
  db.exec(`
    UPDATE gemini_keys
    SET created_at = CURRENT_TIMESTAMP
    WHERE created_at IS NULL;
  `);

  const duplicates = db.prepare(`
    SELECT key_hash, COUNT(*) AS cnt
    FROM gemini_keys
    WHERE key_hash IS NOT NULL
      AND key_hash != ''
    GROUP BY key_hash
    HAVING COUNT(*) > 1
  `).all();

  if (duplicates.length > 0) {
    throw new Error(
      "Migration failed: duplicate key_hash entries found."
    );
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gemini_keys_key_hash
    ON gemini_keys(key_hash)
    WHERE key_hash IS NOT NULL;
  `);
}

function hashApiKey(apiKey) {
  const value = String(apiKey || "").trim();

  if (!value) {
    throw new Error("API key cannot be empty.");
  }

  return crypto
    .createHmac("sha256", HMAC_KEY)
    .update(value)
    .digest("hex");
}

function encryptKey(apiKey) {
  const trimmed = String(apiKey || "").trim();

  if (!trimmed) {
    throw new Error("API key cannot be empty.");
  }

  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    ALGORITHM,
    ENC_KEY,
    iv
  );

  let encrypted = cipher.update(
    trimmed,
    "utf8",
    "hex"
  );

  encrypted += cipher.final("hex");

  const authTag = cipher
    .getAuthTag()
    .toString("hex");

  const maskedKey = trimmed.length > 8
    ? `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`
    : "****";

  return {
    key_hash: hashApiKey(trimmed),
    masked_key: maskedKey,
    encrypted_key: encrypted,
    iv: iv.toString("hex"),
    auth_tag: authTag
  };
}

function decryptKey(row) {
  try {
    if (
      !row ||
      !row.encrypted_key ||
      !row.iv ||
      !row.auth_tag
    ) {
      throw new Error("Encryption data is incomplete.");
    }

    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      ENC_KEY,
      Buffer.from(row.iv, "hex")
    );

    decipher.setAuthTag(
      Buffer.from(row.auth_tag, "hex")
    );

    let decrypted = decipher.update(
      row.encrypted_key,
      "hex",
      "utf8"
    );

    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (error) {
    throw new Error(
      "Failed to decrypt API key. Check ENCRYPTION_SECRET_KEY."
    );
  }
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
  const trimmed = String(apiKey || "").trim();

  if (trimmed.length < 15) {
    throw new Error(
      "Invalid API key format. Key is too short or empty."
    );
  }

  const encrypted = encryptKey(trimmed);

  const existing = db.prepare(`
    SELECT id
    FROM gemini_keys
    WHERE key_hash = ?
  `).get(encrypted.key_hash);

  if (existing) {
    throw new Error(
      "This API key is already added to the system."
    );
  }

  const result = db.prepare(`
    INSERT INTO gemini_keys (
      key_hash,
      masked_key,
      encrypted_key,
      iv,
      auth_tag
    )
    VALUES (?, ?, ?, ?, ?)
  `).run(
    encrypted.key_hash,
    encrypted.masked_key,
    encrypted.encrypted_key,
    encrypted.iv,
    encrypted.auth_tag
  );

  return {
    id: result.lastInsertRowid,
    masked_key: encrypted.masked_key
  };
}

function toggleKeyActive(db, id) {
  return db.prepare(`
    UPDATE gemini_keys
    SET is_active = CASE
      WHEN is_active = 1 THEN 0
      ELSE 1
    END
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
  const nowIso = new Date().toISOString();

  const leaseUntilIso = new Date(
    Date.now() + LEASE_DURATION_MS
  ).toISOString();

  const leaseToken = crypto.randomUUID();

  const transaction = db.transaction(() => {
    let query = `
      SELECT *
      FROM gemini_keys
      WHERE is_active = 1
        AND (
          cooldown_until IS NULL
          OR julianday(cooldown_until) <= julianday(?)
        )
        AND (
          lease_until IS NULL
          OR julianday(lease_until) <= julianday(?)
        )
    `;

    const params = [nowIso, nowIso];

    if (excludedIds.length > 0) {
      const placeholders = excludedIds
        .map(() => "?")
        .join(",");

      query += ` AND id NOT IN (${placeholders})`;

      params.push(...excludedIds);
    }

    query += `
      ORDER BY usage_count ASC, last_used ASC
      LIMIT 1
    `;

    const row = db.prepare(query).get(...params);

    if (!row) {
      return null;
    }

    const updateResult = db.prepare(`
      UPDATE gemini_keys
      SET lease_until = ?,
          lease_token = ?
      WHERE id = ?
        AND (
          lease_until IS NULL
          OR julianday(lease_until) <= julianday(?)
        )
    `).run(
      leaseUntilIso,
      leaseToken,
      row.id,
      nowIso
    );

    if (updateResult.changes !== 1) {
      return null;
    }

    return {
      ...row,
      leaseToken
    };
  }).immediate();

  let leased = null;

  for (let attempt = 0; attempt < 3 && !leased; attempt++) {
    leased = transaction();
  }

  if (!leased) {
    return null;
  }

  try {
    const apiKey = decryptKey(leased);

    return {
      id: leased.id,
      apiKey,
      leaseToken: leased.leaseToken
    };
  } catch (error) {
    releaseKeyLease(
      db,
      leased.id,
      leased.leaseToken
    );

    throw error;
  }
}

function releaseKeyLease(db, keyId, leaseToken) {
  if (!keyId || !leaseToken) {
    return false;
  }

  const result = db.prepare(`
    UPDATE gemini_keys
    SET lease_until = NULL,
        lease_token = NULL
    WHERE id = ?
      AND lease_token = ?
  `).run(keyId, leaseToken);

  return result.changes > 0;
}

function extendKeyLease(
  db,
  keyId,
  leaseToken,
  additionalMs = HEARTBEAT_EXTENSION_MS
) {
  if (!keyId || !leaseToken) {
    return false;
  }

  const nowIso = new Date().toISOString();

  const newLeaseUntilIso = new Date(
    Date.now() + additionalMs
  ).toISOString();

  const result = db.prepare(`
    UPDATE gemini_keys
    SET lease_until = ?
    WHERE id = ?
      AND lease_token = ?
      AND lease_until IS NOT NULL
      AND julianday(lease_until) > julianday(?)
  `).run(
    newLeaseUntilIso,
    keyId,
    leaseToken,
    nowIso
  );

  return result.changes > 0;
}

function recordKeyResultAndRelease(
  db,
  keyId,
  leaseToken,
  options = {}
) {
  const {
    isError = false,
    safeErrorMsg = null,
    cooldownUntilIso = null,
    disableKey = false
  } = options;

  const nowIso = new Date().toISOString();

  const transaction = db.transaction(() => {
    const current = db.prepare(`
      SELECT lease_token, lease_until
      FROM gemini_keys
      WHERE id = ?
    `).get(keyId);

    if (
      !current ||
      current.lease_token !== leaseToken ||
      !current.lease_until ||
      !(
        new Date(current.lease_until).getTime() >
        Date.now()
      )
    ) {
      return false;
    }

    let result;

    if (disableKey) {
      result = db.prepare(`
        UPDATE gemini_keys
        SET is_active = 0,
            last_error = ?,
            lease_until = NULL,
            lease_token = NULL
        WHERE id = ?
          AND lease_token = ?
      `).run(
        safeErrorMsg || "Key disabled",
        keyId,
        leaseToken
      );
    } else if (cooldownUntilIso) {
      result = db.prepare(`
        UPDATE gemini_keys
        SET error_count = error_count + 1,
            last_error = ?,
            cooldown_until = ?,
            lease_until = NULL,
            lease_token = NULL
        WHERE id = ?
          AND lease_token = ?
      `).run(
        safeErrorMsg || "Rate limit",
        cooldownUntilIso,
        keyId,
        leaseToken
      );
    } else if (isError) {
      result = db.prepare(`
        UPDATE gemini_keys
        SET error_count = error_count + 1,
            last_error = ?,
            last_used = ?,
            lease_until = NULL,
            lease_token = NULL
        WHERE id = ?
          AND lease_token = ?
      `).run(
        safeErrorMsg || "API error",
        nowIso,
        keyId,
        leaseToken
      );
    } else {
      result = db.prepare(`
        UPDATE gemini_keys
        SET usage_count = usage_count + 1,
            last_used = ?,
            last_error = NULL,
            lease_until = NULL,
            lease_token = NULL
        WHERE id = ?
          AND lease_token = ?
      `).run(
        nowIso,
        keyId,
        leaseToken
      );
    }

    return result.changes === 1;
  }).immediate();

  return transaction();
}

function isNetworkOrTransientError(error) {
  if (!error) {
    return false;
  }

  const message = String(
    error.message || ""
  ).toLowerCase();

  const code = String(
    error.code || error.cause?.code || ""
  ).toLowerCase();

  const networkCodes = [
    "econnreset",
    "etimedout",
    "enotfound",
    "eai_again",
    "econnrefused",
    "ehostunreach",
    "enetunreach"
  ];

  if (networkCodes.includes(code)) {
    return true;
  }

  if (
    error instanceof TypeError ||
    message.includes("failed to fetch") ||
    message.includes("network error") ||
    message.includes("networkrequestfailed")
  ) {
    return true;
  }

  return false;
}

function getErrorStatus(error) {
  return (
    error?.status ||
    error?.statusCode ||
    error?.response?.status ||
    0
  );
}

function isQuotaError(error) {
  const status = getErrorStatus(error);

  const message = String(
    error?.message || ""
  ).toLowerCase();

  return (
    status === 429 ||
    message.includes("resource has been exhausted") ||
    message.includes("quota exceeded")
  );
}

function isServerTransientError(error) {
  const status = getErrorStatus(error);

  const message = String(
    error?.message || ""
  ).toLowerCase();

  return (
    (status >= 500 && status < 600) ||
    message.includes("service unavailable")
  );
}

function isConfirmedInvalidKey(error) {
  const status = getErrorStatus(error);

  const message = String(
    error?.message || ""
  ).toLowerCase();

  const invalidMessage =
    message.includes("api_key_invalid") ||
    message.includes("api key not valid") ||
    message.includes("key expired") ||
    message.includes("api key not found");

  return (
    [400, 401, 403].includes(status) &&
    invalidMessage
  );
}

async function executeWithKeyRotation(
  db,
  apiCallFn,
  externalOptions = {}
) {
  if (typeof apiCallFn !== "function") {
    throw new TypeError("apiCallFn must be a function.");
  }

  const externalSignal = externalOptions.signal;

  if (
    externalSignal &&
    externalSignal.aborted
  ) {
    throw createAbortError(
      "Request aborted by user."
    );
  }

  const totalActiveRow = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM gemini_keys
    WHERE is_active = 1
  `).get();

  const totalActive = totalActiveRow
    ? totalActiveRow.cnt
    : 0;

  if (totalActive === 0) {
    throw new Error(
      "No active Gemini API keys available. Add keys in the OWNER panel."
    );
  }

  const triedKeyIds = [];

  let attempts = 0;

  let lastSafeError =
    "All available keys are exhausted or locked.";

  while (attempts < totalActive) {
    if (
      externalSignal &&
      externalSignal.aborted
    ) {
      throw createAbortError(
        "Request aborted by user."
      );
    }

    const keyObj = getNextApiKey(
      db,
      triedKeyIds
    );

    if (!keyObj) {
      break;
    }

    triedKeyIds.push(keyObj.id);
    attempts++;

    const abortController = new AbortController();

    let leaseLost = false;
    let heartbeatError = null;
    let requestSettled = false;

    const onExternalAbort = () => {
      if (!requestSettled) {
        abortController.abort(
          createAbortError("Request aborted by user.")
        );
      }
    };

    if (externalSignal) {
      externalSignal.addEventListener(
        "abort",
        onExternalAbort,
        { once: true }
      );
    }

    if (
      externalSignal &&
      externalSignal.aborted
    ) {
      onExternalAbort();
    }

    const heartbeatInterval = setInterval(() => {
      if (requestSettled || leaseLost || heartbeatError) {
        return;
      }

      try {
        const extended = extendKeyLease(
          db,
          keyObj.id,
          keyObj.leaseToken,
          HEARTBEAT_EXTENSION_MS
        );

        if (!extended) {
          leaseLost = true;

          abortController.abort(
            new Error("KEY_LEASE_LOST")
          );
        }
      } catch (error) {
        heartbeatError = error;

        abortController.abort(
          new Error("KEY_LEASE_DATABASE_ERROR")
        );
      }
    }, HEARTBEAT_INTERVAL_MS);

    if (typeof heartbeatInterval.unref === "function") {
      heartbeatInterval.unref();
    }

    let result;
    let apiError = null;

    try {
      result = await apiCallFn(
        keyObj.apiKey,
        {
          signal: abortController.signal
        }
      );
    } catch (error) {
      apiError = error;
    } finally {
      requestSettled = true;

      clearInterval(heartbeatInterval);

      if (externalSignal) {
        externalSignal.removeEventListener(
          "abort",
          onExternalAbort
        );
      }
    }

    // Пользователь отменил запрос.
    // Освобождаем только собственную аренду
    // после завершения API-вызова.
    if (
      externalSignal &&
      externalSignal.aborted
    ) {
      releaseKeyLease(
        db,
        keyObj.id,
        keyObj.leaseToken
      );

      throw createAbortError(
        "Request aborted by user."
      );
    }

    // Ошибка самой базы данных.
    if (heartbeatError) {
      releaseKeyLease(
        db,
        keyObj.id,
        keyObj.leaseToken
      );

      throw heartbeatError;
    }

    // Другой запрос уже получил эту аренду.
    // Нельзя записывать результат старого запроса.
    if (leaseLost) {
      lastSafeError =
        "Key lease was lost. Trying another key.";

      continue;
    }

    // API вернул успех.
    if (!apiError) {
      const successRecorded = recordKeyResultAndRelease(
        db,
        keyObj.id,
        keyObj.leaseToken,
        { isError: false }
      );

      if (!successRecorded) {
        lastSafeError =
          "Key lease ownership was lost before completion.";

        continue;
      }

      return result;
    }

    // Если API завершился с ошибкой, но аренда уже
    // принадлежит другому запросу, не изменяем её.
    if (
      apiError.code === "KEY_LEASE_LOST" ||
      apiError.message === "KEY_LEASE_LOST"
    ) {
      lastSafeError =
        "Key lease was lost. Trying another key.";

      continue;
    }

    const status = getErrorStatus(apiError);

    if (isQuotaError(apiError)) {
      const cooldownUntilIso = new Date(
        Date.now() + 10 * 60 * 1000
      ).toISOString();

      const recorded = recordKeyResultAndRelease(
        db,
        keyObj.id,
        keyObj.leaseToken,
        {
          isError: true,
          safeErrorMsg: "Rate limit (429)",
          cooldownUntilIso
        }
      );

      if (!recorded) {
        lastSafeError =
          "Key lease was lost. Trying another key.";

        continue;
      }

      lastSafeError =
        "API rate limit exceeded. Rotating key.";

      continue;
    }

    if (
      isNetworkOrTransientError(apiError) ||
      isServerTransientError(apiError)
    ) {
      const recorded = recordKeyResultAndRelease(
        db,
        keyObj.id,
        keyObj.leaseToken,
        {
          isError: true,
          safeErrorMsg:
            `Transient network/server error (${status || "network"})`
        }
      );

      if (!recorded) {
        lastSafeError =
          "Key lease was lost. Trying another key.";

        continue;
      }

      lastSafeError =
        "Transient server or network error. Rotating key.";

      continue;
    }

    if (isConfirmedInvalidKey(apiError)) {
      const recorded = recordKeyResultAndRelease(
        db,
        keyObj.id,
        keyObj.leaseToken,
        {
          disableKey: true,
          safeErrorMsg: "Key disabled: invalid credentials"
        }
      );

      if (!recorded) {
        lastSafeError =
          "Key lease was lost. Trying another key.";

        continue;
      }

      lastSafeError =
        "API key invalid or expired.";

      continue;
    }

    const errorRecorded = recordKeyResultAndRelease(
      db,
      keyObj.id,
      keyObj.leaseToken,
      {
        isError: true,
        safeErrorMsg: "Request error"
      }
    );

    if (!errorRecorded) {
      lastSafeError =
        "Key lease was lost. Trying another key.";

      continue;
    }

    throw apiError;
  }

  throw new Error(
    lastSafeError ||
    "All available Gemini API keys are currently cooling down or locked."
  );
}

module.exports = {
  initGeminiKeysTable,
  getAllKeys,
  insertKey,
  toggleKeyActive,
  deleteKey,
  getNextApiKey,
  releaseKeyLease,
  extendKeyLease,
  recordKeyResultAndRelease,
  executeWithKeyRotation
};

"use strict";

process.env.ENCRYPTION_SECRET_KEY =
  "test-secret-key-for-unit-testing-purposes-only-32bytes-long";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const Database = require("better-sqlite3");

const {
  initGeminiKeysTable,
  insertKey,
  getNextApiKey,
  recordKeyResultAndRelease,
  executeWithKeyRotation
} = require("./key-manager");

const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "pinsk-key-manager-")
);

const testDbPath = path.join(
  tempDir,
  "test_pinsk.db"
);

const testDbPathAlt = path.join(
  tempDir,
  "test_pinsk_alt.db"
);

function cleanup() {
  try {
    fs.rmSync(tempDir, {
      recursive: true,
      force: true
    });
  } catch (error) {
    console.error("Cleanup warning:", error.message);
  }
}

function createDatabase(filePath) {
  const database = new Database(filePath);

  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");

  return database;
}

async function testMigration(db) {
  console.log("1. Testing legacy database migration...");

  db.exec(`
    CREATE TABLE gemini_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      masked_key TEXT NOT NULL,
      encrypted_key TEXT NOT NULL
    );
  `);

  db.prepare(`
    INSERT INTO gemini_keys (
      masked_key,
      encrypted_key
    )
    VALUES (?, ?)
  `).run(
    "test...ing",
    "dummy-encrypted-value"
  );

  initGeminiKeysTable(db);

  const columns = db.prepare(
    "PRAGMA table_info(gemini_keys)"
  ).all();

  const columnNames = columns.map(
    column => column.name
  );

  assert.ok(
    columnNames.includes("key_hash"),
    "Migration must add key_hash."
  );

  assert.ok(
    columnNames.includes("cooldown_until"),
    "Migration must add cooldown_until."
  );

  assert.ok(
    columnNames.includes("lease_token"),
    "Migration must add lease_token."
  );

  assert.ok(
    columnNames.includes("created_at"),
    "Migration must add created_at."
  );

  const oldRow = db.prepare(`
    SELECT created_at
    FROM gemini_keys
    LIMIT 1
  `).get();

  assert.ok(
    oldRow.created_at,
    "Old records must receive created_at."
  );

  db.exec("DELETE FROM gemini_keys;");

  initGeminiKeysTable(db);

  console.log("   Migration and repeated initialization passed.");
}

async function testEncryptionAndDuplicates(db) {
  console.log("2. Testing encryption and duplicate protection...");

  const validKey =
    "AIzaSyTestKey1234567890abcdefghijklmnopqrstuvwxyz";

  const added = insertKey(db, validKey);

  assert.ok(
    added.id,
    "Key must be inserted."
  );

  assert.notStrictEqual(
    added.masked_key,
    validKey,
    "Key must be masked."
  );

  assert.throws(
    () => insertKey(db, validKey),
    /already added/i,
    "Duplicate key must be rejected."
  );

  console.log("   Encryption and duplicate protection passed.");

  return {
    id: added.id,
    apiKey: validKey
  };
}

async function testWrongSecret() {
  console.log("3. Testing wrong encryption secret in child process...");

  const badDb = createDatabase(testDbPathAlt);

  try {
    initGeminiKeysTable(badDb);

    const sourceDb = new Database(testDbPath);

    try {
      const row = sourceDb.prepare(`
        SELECT *
        FROM gemini_keys
        LIMIT 1
      `).get();

      assert.ok(row, "Source key must exist.");

      badDb.prepare(`
        INSERT INTO gemini_keys (
          key_hash,
          masked_key,
          encrypted_key,
          iv,
          auth_tag
        )
        VALUES (?, ?, ?, ?, ?)
      `).run(
        row.key_hash,
        row.masked_key,
        row.encrypted_key,
        row.iv,
        row.auth_tag
      );
    } finally {
      sourceDb.close();
    }
  } finally {
    badDb.close();
  }

  const childScript = `
    "use strict";

    process.env.ENCRYPTION_SECRET_KEY =
      "wrong-secret-key-that-does-not-match-original-at-all";

    const Database = require("better-sqlite3");

    const {
      getNextApiKey
    } = require("./key-manager");

    const db = new Database(${JSON.stringify(testDbPathAlt)});

    try {
      getNextApiKey(db);

      console.error("Expected decryption failure did not occur.");
      process.exitCode = 1;
    } catch (error) {
      if (
        error.message.includes("Failed to decrypt API key")
      ) {
        console.log("Wrong secret correctly rejected.");
      } else {
        console.error(error);
        process.exitCode = 2;
      }
    } finally {
      db.close();
    }
  `;

  const child = spawnSync(
    process.execPath,
    ["-e", childScript],
    {
      cwd: __dirname,
      encoding: "utf8",
      env: process.env
    }
  );

  if (child.stdout) {
    process.stdout.write(child.stdout);
  }

  if (child.stderr) {
    process.stderr.write(child.stderr);
  }

  assert.strictEqual(
    child.status,
    0,
    "Child process must reject the wrong encryption secret."
  );

  console.log("   Wrong-secret test passed.");
}

async function testLeaseManagement(db, firstKey) {
  console.log("4. Testing key leases and ownership...");

  const firstLease = getNextApiKey(db);

  assert.ok(firstLease);
  assert.strictEqual(firstLease.id, firstKey.id);
  assert.ok(firstLease.leaseToken);

  // Искусственно истекает первая аренда.
  db.prepare(`
    UPDATE gemini_keys
    SET lease_until = ?
    WHERE id = ?
  `).run(
    new Date(Date.now() - 60000).toISOString(),
    firstLease.id
  );

  const secondLease = getNextApiKey(db);

  assert.ok(secondLease);
  assert.strictEqual(secondLease.id, firstKey.id);

  // Старый токен больше не должен иметь права
  // изменять запись.
  const fakeToken = crypto.randomUUID();

  const fakeResult = recordKeyResultAndRelease(
    db,
    secondLease.id,
    fakeToken,
    { isError: false }
  );

  assert.strictEqual(
    fakeResult,
    false,
    "Foreign lease token must not modify the key."
  );

  // Токен первой аренды уже истёк.
  const expiredResult = recordKeyResultAndRelease(
    db,
    firstLease.id,
    firstLease.leaseToken,
    { isError: false }
  );

  assert.strictEqual(
    expiredResult,
    false,
    "Expired lease must not finalize a request."
  );

  // Действующая аренда может завершить запрос.
  const validResult = recordKeyResultAndRelease(
    db,
    secondLease.id,
    secondLease.leaseToken,
    { isError: false }
  );

  assert.strictEqual(
    validResult,
    true,
    "Current lease must finalize successfully."
  );

  console.log("   Lease ownership tests passed.");
}

async function testCooldown(db, firstKey) {
  console.log("5. Testing cooldown after HTTP 429...");

  const lease = getNextApiKey(db);

  assert.ok(lease);

  const cooldownUntilIso = new Date(
    Date.now() + 60000
  ).toISOString();

  const recorded = recordKeyResultAndRelease(
    db,
    lease.id,
    lease.leaseToken,
    {
      isError: true,
      safeErrorMsg: "Rate limit",
      cooldownUntilIso
    }
  );

  assert.strictEqual(
    recorded,
    true,
    "Cooldown must be recorded."
  );

  const noKey = getNextApiKey(db);

  assert.strictEqual(
    noKey,
    null,
    "Key in cooldown must not be issued."
  );

  db.prepare(`
    UPDATE gemini_keys
    SET cooldown_until = NULL,
        is_active = 1
    WHERE id = ?
  `).run(firstKey.id);

  console.log("   Cooldown test passed.");
}

async function testRotation(db) {
  console.log("6. Testing automatic key rotation...");

  const secondKey =
    "AIzaSyAnotherKey9876543210zyxwvutsrqponmlkjihgfedcba";

  insertKey(db, secondKey);

  let callCount = 0;

  const mockApiCall = async (apiKey, { signal }) => {
    callCount++;

    assert.ok(signal, "API call must receive AbortSignal.");

    if (callCount === 1) {
      const error = new Error("Rate limit exceeded");
      error.status = 429;
      throw error;
    }

    return "success_result";
  };

  const result = await executeWithKeyRotation(
    db,
    mockApiCall
  );

  assert.strictEqual(
    result,
    "success_result"
  );

  assert.strictEqual(
    callCount,
    2,
    "Rotation must try another key after 429."
  );

  console.log("   Automatic rotation test passed.");
}

async function testExternalAbort(db) {
  console.log("7. Testing external AbortSignal...");

  const controller = new AbortController();

  let callbackStarted = false;

  const apiCall = async (apiKey, { signal }) => {
    callbackStarted = true;

    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }

      signal.addEventListener(
        "abort",
        () => {
          reject(signal.reason);
        },
        { once: true }
      );
    });
  };

  const request = executeWithKeyRotation(
    db,
    apiCall,
    {
      signal: controller.signal
    }
  );

  const timer = setTimeout(() => {
    controller.abort();
  }, 50);

  try {
    await assert.rejects(
      request,
      error => {
        return (
          error.name === "AbortError" ||
          error.code === "ABORT_ERR"
        );
      }
    );
  } finally {
    clearTimeout(timer);
  }

  assert.ok(
    callbackStarted,
    "API callback must have started."
  );

  const remainingLeases = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM gemini_keys
    WHERE lease_token IS NOT NULL
  `).get();

  assert.strictEqual(
    remainingLeases.cnt,
    0,
    "External cancellation must release its own lease."
  );

  console.log("   External AbortSignal test passed.");
}

async function testLeaseLossDuringRequest(db) {
  console.log("8. Testing lease loss during API execution...");

  let callCount = 0;
  let foreignLeaseToken = null;

  const apiCall = async (apiKey, { signal }) => {
    callCount++;

    if (callCount === 1) {
      // Имитируем ситуацию, когда другой владелец
      // получил эту запись во время API-запроса.
      const current = db.prepare(`
        SELECT id, lease_token
        FROM gemini_keys
        WHERE lease_token IS NOT NULL
        LIMIT 1
      `).get();

      assert.ok(current);

      foreignLeaseToken = crypto.randomUUID();

      db.prepare(`
        UPDATE gemini_keys
        SET lease_token = ?
        WHERE id = ?
      `).run(
        foreignLeaseToken,
        current.id
      );

      // Старый запрос вернул успех,
      // но его токен уже не принадлежит ему.
      return "stale_result";
    }

    return "valid_result";
  };

  const result = await executeWithKeyRotation(
    db,
    apiCall
  );

  assert.strictEqual(
    result,
    "valid_result",
    "Stale result must be discarded and another key tried."
  );

  assert.strictEqual(
    callCount,
    2,
    "A second key must be tried after lease loss."
  );

  const foreignLease = db.prepare(`
    SELECT lease_token
    FROM gemini_keys
    WHERE lease_token = ?
  `).get(foreignLeaseToken);

  assert.ok(
    foreignLease,
    "The foreign lease must not be released or modified."
  );

  console.log("   Lease loss test passed.");
}

async function main() {
  let db = null;

  try {
    console.log("");
    console.log("======================================");
    console.log(" Pinsk AI key-manager test suite");
    console.log("======================================");
    console.log("");

    db = createDatabase(testDbPath);

    await testMigration(db);

    const firstKey = await testEncryptionAndDuplicates(db);

    await testWrongSecret();

    await testLeaseManagement(db, firstKey);

    await testCooldown(db, firstKey);

    await testRotation(db);

    // Для теста внешней отмены используем отдельную
    // базу, чтобы не затрагивать аренду из предыдущего теста.
    db.close();
    db = null;

    const abortDbPath = path.join(
      tempDir,
      "abort_test.db"
    );

    db = createDatabase(abortDbPath);

    initGeminiKeysTable(db);

    insertKey(
      db,
      "AIzaSyAbortTestKey12345678901234567890"
    );

    await testExternalAbort(db);

    // Отдельная база для тестирования потери аренды.
    db.close();
    db = null;

    const leaseDbPath = path.join(
      tempDir,
      "lease_loss_test.db"
    );

    db = createDatabase(leaseDbPath);

    initGeminiKeysTable(db);

    insertKey(
      db,
      "AIzaSyLeaseTestKey12345678901234567890"
    );

    insertKey(
      db,
      "AIzaSyLeaseTestKey98765432109876543210"
    );

    await testLeaseLossDuringRequest(db);

    console.log("");
    console.log("======================================");
    console.log(" ALL TESTS PASSED");
    console.log("======================================");
    console.log("");
  } catch (error) {
    console.error("");
    console.error("======================================");
    console.error(" TEST SUITE FAILED");
    console.error("======================================");
    console.error(error);
    console.error("");

    process.exitCode = 1;
  } finally {
    if (db) {
      try {
        db.close();
      } catch (error) {
        console.error("Database close error:", error.message);
        process.exitCode = 1;
      }
    }

    cleanup();
  }
}

main().catch(error => {
  console.error("Unexpected test runner error:", error);
  cleanup();
  process.exitCode = 1;
});

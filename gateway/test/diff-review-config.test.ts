// Diff-Review v0.1.3..fix/security-review: Haertung der neuen Security-Settings.
// Env VOR dem Import von config.ts setzen (dotenv ueberschreibt nicht) und die
// DB in ein temporaeres Verzeichnis legen - nie die reale smartpilot.db.
// F-D19: ungueltige Werte duerfen Limits nicht still deaktivieren (NaN) oder
// versehentlich sperren (0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ADMIN_TOKEN = 'diff-review-admin-token';
process.env.API_TOKEN = 'diff-review-api-token';
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.LLM_API_KEY = 'diff-review-key';
process.env.LLM_MODEL = 'diff-review-model';
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'diff-review-db-')), 'review.sqlite');
// Ungueltige Werte: duerfen nicht NaN (Fail-open) oder z. B. 0 erzeugen.
process.env.SESSION_MAX_HOURS = 'keine-zahl';
process.env.QUERY_RATE_MAX = 'keine-zahl';

const { config, envPositiveNumber } = await import('../src/config.js');

test('SESSION_MAX_HOURS ungueltig faellt auf Default zurueck statt NaN', () => {
  assert.ok(
    Number.isFinite(config.sessionMaxMs) && config.sessionMaxMs > 0,
    `sessionMaxMs=${config.sessionMaxMs} (erwartet endlich > 0)`
  );
});

test('QUERY_RATE_MAX ungueltig faellt auf Default zurueck statt NaN', () => {
  assert.ok(
    Number.isFinite(config.queryRateMax) && config.queryRateMax > 0,
    `queryRateMax=${config.queryRateMax} (erwartet endlich > 0)`
  );
});

test('envPositiveNumber: ungueltig/0/negativ/leer -> Default, gueltig -> Wert', () => {
  assert.equal(envPositiveNumber(undefined, 30), 30);
  assert.equal(envPositiveNumber('   ', 30), 30);
  assert.equal(envPositiveNumber('keine-zahl', 30), 30);
  assert.equal(envPositiveNumber('0', 30), 30);
  assert.equal(envPositiveNumber('-5', 30), 30);
  assert.equal(envPositiveNumber('45', 30), 45);
});

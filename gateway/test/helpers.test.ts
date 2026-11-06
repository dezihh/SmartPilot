import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errMsg, parseId } from '../src/routes/helpers.js';

test('parseId: nur positive Ganzzahlen', () => {
  assert.equal(parseId('42'), 42);
  assert.equal(parseId(7), 7);
  assert.equal(parseId('abc'), null);
  assert.equal(parseId('0'), null);
  assert.equal(parseId('-1'), null);
  assert.equal(parseId('1.5'), null);
  assert.equal(parseId(undefined), null);
});

test('errMsg: Error und Fremdwert', () => {
  assert.equal(errMsg(new Error('x')), 'x');
  assert.equal(errMsg(42), '42');
  assert.equal(errMsg(null), 'null');
});

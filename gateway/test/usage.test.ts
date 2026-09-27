import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traceUsage, sumUsageFromTrace } from '../src/core/usage.js';
import type { TraceEvent } from '../src/types.js';
import type { ChatCompletionResult } from '../src/llm/client.js';

test('traceUsage: nutzt usage.model (Response-echo), faellt auf arg zurueck', () => {
  const trace: TraceEvent[] = [];
  traceUsage(trace, 'fallback-name', {
    message: { role: 'assistant', content: null },
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, model: 'gpt-oss-120b' },
  });
  assert.equal(trace[0]!.step, 'llm.usage');
  const d = trace[0]!.detail as { model?: string; total_tokens?: number };
  assert.equal(d.model, 'gpt-oss-120b');
  assert.equal(d.total_tokens, 15);

  const trace2: TraceEvent[] = [];
  traceUsage(trace2, 'default-modell', { message: { role: 'assistant', content: null }, usage: { total_tokens: 1 } });
  const d2 = trace2[0]!.detail as { model?: string };
  assert.equal(d2.model, 'default-modell');
});

test('traceUsage: ohne usage kein Event', () => {
  const trace: TraceEvent[] = [];
  traceUsage(trace, 'x', { message: { role: 'assistant', content: null } });
  assert.equal(trace.length, 0);
});

test('sumUsageFromTrace: summiert mehrere Runden, erste Modell-Nennung gewinnt', () => {
  const trace: TraceEvent[] = [
    { ts: 1, step: 'route.agent' },
    { ts: 2, step: 'llm.usage', detail: { model: 'a', prompt_tokens: 100, completion_tokens: 20 } },
    { ts: 3, step: 'tool.call' },
    { ts: 4, step: 'llm.usage', detail: { model: 'b', prompt_tokens: 50, completion_tokens: 30 } },
  ];
  const sum = sumUsageFromTrace(trace);
  assert.equal(sum.promptTokens, 150);
  assert.equal(sum.completionTokens, 50);
  assert.equal(sum.model, 'a');
});

test('sumUsageFromTrace: leere Spur = undefined-Werte', () => {
  const sum = sumUsageFromTrace([{ ts: 1, step: 'route.agent' }]);
  assert.equal(sum.promptTokens, undefined);
  assert.equal(sum.model, undefined);
});

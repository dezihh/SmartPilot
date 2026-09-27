import { config } from './config.js';
import { chatCompletion } from './llm/client.js';
import { createApp } from './app.js';

createApp().listen(config.port, () => {
  console.log(`SmartPilot Gateway auf Port ${config.port}`);
});

if (process.env.LLM_KEEPALIVE_MS !== '0') {
  setInterval(() => {
    chatCompletion([{ role: 'user', content: 'OK' }], undefined, 15000).catch(() => {});
  }, Number(process.env.LLM_KEEPALIVE_MS ?? 120_000)).unref();
}

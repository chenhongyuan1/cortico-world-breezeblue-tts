/** Status is offline; --voices lists voices; --speak generates audio (billed); --play plays it. */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { petVoiceDefaults } from '../src/index.js';
import { resolveDataDir } from '../src/events.js';
import { breezeKeyStatus, listBreezeVoices, synthesizeBreeze } from '../src/breeze.js';
import { playWav } from '../src/player.js';

const args = process.argv.slice(2);
const value = (name, fallback = '') => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} requires a value`);
  return args[i + 1];
};

try {
  const deployment = value('--data', resolveDataDir() || '');
  if (!deployment) throw new Error('Pass --data with the deployment directory containing config.json and .env.');
  const dataDir = resolve(deployment);
  let saved = {};
  try { saved = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')).worlds?.['breezeblue-tts'] ?? {}; }
  catch (err) { if (err.code !== 'ENOENT') throw new Error(`Cannot read config.json: ${err.message}`); }
  const cfg = { ...petVoiceDefaults(), ...saved };
  if (args.includes('--voice')) cfg.breezeVoice = value('--voice');
  const opts = { botDir: dataDir, dataDir };
  if (args.includes('--voices')) {
    const result = await listBreezeVoices(cfg, opts, { language: value('--language'), pageToken: value('--page-token') });
    if (!result.ok) throw new Error(result.error);
    console.log(JSON.stringify({
      voices: result.voices.map((v) => ({ id: v.voice_id, name: v.name, language: v.language_code })),
      hasMore: result.hasMore, nextPageToken: result.nextPageToken,
    }, null, 2));
  } else if (args.includes('--speak')) {
    const result = await synthesizeBreeze(value('--text', '你好。'), cfg, opts);
    if (!result.ok) throw new Error(result.error);
    console.log(JSON.stringify({ ok: true, model: result.model, voice: result.voiceId, bytes: result.bytes.length, ms: result.ms, usage: result.usage }));
    if (args.includes('--play')) {
      const played = await playWav(result.bytes, cfg);
      if (!played.ok) throw new Error(played.error);
    }
  } else {
    const status = breezeKeyStatus(cfg, opts);
    console.log(JSON.stringify({ provider: cfg.cloudProvider, enabled: cfg.enabled, ...status,
      voice: cfg.breezeVoice || null, model: cfg.breezeModel || 'auto', ready: status.configured && Boolean(cfg.breezeVoice?.trim()),
    }, null, 2));
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}

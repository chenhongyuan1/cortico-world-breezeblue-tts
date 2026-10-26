import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { synthesizeBreeze, listBreezeVoices, breezeKeyStatus } from '../src/breeze.js';
import { resolveBreezeApiKey, BREEZE_KEY_ENVS, redact } from '../src/secrets.js';
import { createSpeech } from '../src/speech.js';
import { createSpeaker } from '../src/queue.js';
import { petVoiceDefaults } from '../src/index.js';

const key = 'brz_offline_test_123456789';
const cfg = { ...petVoiceDefaults(), breezeApiKey: key, breezeVoice: 'voc_test', breezeLanguageCode: 'zh' };
const opts = { botDir: '__missing__', dataDir: '__missing__' };
const realFetch = globalThis.fetch;
const savedEnv = Object.fromEntries([...BREEZE_KEY_ENVS, 'BREEZE_TEST_KEY', 'CORTICO_HOME', 'CORTICO_COMPANION_DATA'].map((name) => [name, process.env[name]]));
for (const name of Object.keys(savedEnv)) delete process.env[name];
const wav = Buffer.alloc(44 + 4800);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(4800, 40);
const audio = () => new Response(wav, { headers: { 'content-type': 'audio/wav' } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

try {
  await test('Breeze request uses documented path, key header, body and binary WAV', async () => {
    let seen;
    globalThis.fetch = async (url, init) => { seen = { url, init }; return audio(); };
    const result = await synthesizeBreeze('你好', { ...cfg, breezeInstructions: '  温柔地说  ', breezeSpeed: 1.25, breezeVolume: 0.8, breezeGuidanceScale: 4, breezeSpeakerBoost: true }, opts);
    assert.equal(result.ok, true); assert.deepEqual(result.bytes, wav);
    assert.equal(result.usage.audioMs, 100); assert.equal(result.usage.sampleRate, 24000);
    assert.equal(seen.url, 'https://api.breeze.blue/v1/text-to-speech/voc_test?output_format=wav&delivery=sync');
    assert.equal(seen.init.method, 'POST'); assert.equal(seen.init.redirect, 'error');
    assert.equal(seen.init.headers['xi-api-key'], key); assert.equal(seen.init.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(seen.init.body), { text: '你好', model_id: 'breeze-tts-2', language_code: 'zh', instructions: '温柔地说', voice_settings: { speed: 1.25, volume: 0.8, guidance_scale: 4, use_speaker_boost: true } });
    assert.ok(!seen.init.body.includes(key)); assert.ok(!JSON.stringify(breezeKeyStatus(cfg, opts)).includes(key));
  });
  await test('Automatic model/language/instructions omitted; voice ID cannot alter request path', async () => {
    let seen;
    globalThis.fetch = async (url, init) => { seen = { url, init }; return audio(); };
    await synthesizeBreeze('x', { ...cfg, breezeVoice: 'voc_/test?bad=1', breezeModel: '', breezeLanguageCode: '', breezeInstructions: ' ' }, opts);
    assert.ok(seen.url.includes('voc_%2Ftest%3Fbad%3D1?'));
    const body = JSON.parse(seen.init.body);
    for (const field of ['model_id', 'language_code', 'instructions']) assert.ok(!(field in body));
  });
  await test('Missing Breeze key/voice and invalid language never send a request or reuse MiniMax key', async () => {
    let calls = 0; globalThis.fetch = async () => { calls++; return audio(); };
    assert.equal((await synthesizeBreeze('x', { ...cfg, breezeApiKey: '', minimaxApiKey: 'sk_other_provider' }, opts)).code, 'no-key');
    assert.equal((await synthesizeBreeze('x', { ...cfg, breezeVoice: '' }, opts)).code, 'no-voice');
    assert.equal((await synthesizeBreeze('x', { ...cfg, breezeLanguageCode: 'Chinese' }, opts)).code, 'bad-language');
    assert.equal(calls, 0);
  });
  await test('Credential precedence: config > custom environment > defaults > deployment .env', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'breeze-secrets-'));
    try {
      await writeFile(join(dir, '.env'), `BREEZE_API_KEY=${key}\n`);
      assert.equal(resolveBreezeApiKey({}, { botDir: dir }).from, '.env:BREEZE_API_KEY');
      process.env.BREEZE_API_KEY = 'brz_env_fake';
      assert.equal(resolveBreezeApiKey({}, { botDir: dir }).key, 'brz_env_fake');
      process.env.BREEZE_TEST_KEY = 'brz_custom_fake';
      assert.equal(resolveBreezeApiKey({ breezeApiKeyEnv: 'BREEZE_TEST_KEY' }, { botDir: dir }).key, 'brz_custom_fake');
      assert.equal(resolveBreezeApiKey({ breezeApiKey: key }, { botDir: dir }).key, key);
    } finally { delete process.env.BREEZE_API_KEY; delete process.env.BREEZE_TEST_KEY; await rm(dir, { recursive: true, force: true }); }
    assert.ok(!redact(`xi-api-key: ${key} unknown brz_hidden_fake_key`, [key]).includes('hidden_fake'));
    assert.ok(!redact(key, [key]).includes(key));
  });
  await test('A credential pasted in the variable-name field never appears in diagnostics', () => {
    const result = resolveBreezeApiKey({ breezeApiKeyEnv: key }, opts);
    assert.ok(!JSON.stringify(result.tried).includes(key));
    assert.ok(!JSON.stringify(breezeKeyStatus({ breezeApiKeyEnv: key }, opts)).includes(key));
  });
  for (const status of [401, 403, 404, 422, 429, 503, 504]) {
    await test(`HTTP ${status}: classification and error redaction`, async () => {
      globalThis.fetch = async () => json({ ok: false, code: 'TEST_ERROR', detail: `bad ${key}` }, status);
      const result = await synthesizeBreeze('x', cfg, opts);
      assert.equal(result.ok, false); assert.equal(result.retryable, status === 429 || status >= 500);
      assert.ok(!result.error.includes(key));
    });
  }
  await test('HTML gateway error, unexpected JSON, empty audio and 202 job are handled', async () => {
    for (const response of [new Response('<html>bad gateway</html>', { status: 502 }), json({ data: { audio: 'ff' } }), new Response(new Uint8Array()), json({ generation_job_id: 'job' }, 202)]) {
      globalThis.fetch = async () => response;
      assert.equal((await synthesizeBreeze('x', cfg, opts)).ok, false);
    }
  });
  await test('Network failures are returned and redacted', async () => {
    globalThis.fetch = async () => { throw new Error(`network ${key}`); };
    const result = await synthesizeBreeze('x', cfg, opts);
    assert.equal(result.code, 'network'); assert.ok(!result.error.includes(key));
  });
  await test('Timeout remains active during response body download', async () => {
    globalThis.fetch = async (url, init) => ({ ok: true, status: 200,
      arrayBuffer: () => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })),
    });
    const result = await synthesizeBreeze('x', { ...cfg, breezeTimeoutMs: 2000 }, opts);
    assert.equal(result.code, 'timeout');
  });
  await test('Voice listing uses authenticated GET and preserves pagination', async () => {
    let seen;
    globalThis.fetch = async (url, init) => { seen = { url, init }; return json({ voices: [{ voice_id: 'voc_one', name: 'One' }], has_more: true, next_page_token: 'next' }); };
    const result = await listBreezeVoices(cfg, opts, { language: 'zh', pageToken: 'a/b' });
    assert.equal(result.voices[0].voice_id, 'voc_one'); assert.equal(result.nextPageToken, 'next');
    const url = new URL(seen.url); assert.equal(url.searchParams.get('language_code'), 'zh'); assert.equal(url.searchParams.get('next_page_token'), 'a/b');
    assert.equal(seen.init.method, 'GET'); assert.equal(seen.init.headers['xi-api-key'], key);
  });
  await test('Router plays Breeze WAV; cloud failures trip breaker; provider change clears breaker', async () => {
    let current = { ...cfg }; let networkCalls = 0; let systemCalls = 0; let playCalls = 0;
    globalThis.fetch = async () => { networkCalls++; return audio(); };
    const speech = createSpeech({ getConfig: () => current, opts, engines: {
      speakSapi: async () => { systemCalls++; return { ok: true }; },
      playWav: async () => { playCalls++; return { ok: true, ms: 100 }; },
    } });
    assert.equal((await speech.speak('你好')).engine, 'breeze'); assert.equal(playCalls, 1); assert.equal(systemCalls, 0);
    globalThis.fetch = async () => { networkCalls++; return json({ detail: 'limited' }, 429); };
    for (let i = 0; i < 3; i++) assert.equal((await speech.speak('失败')).fallbackReason, 'cloud-failed');
    assert.equal((await speech.speak('熔断')).fallbackReason, 'cooldown'); assert.equal(networkCalls, 4);
    current = { ...current, cloudProvider: 'minimax', minimaxApiKey: 'sk_fake_other' };
    globalThis.fetch = async (url, init) => {
      assert.ok(url.startsWith('https://api.minimax.cn/')); assert.equal(init.headers['xi-api-key'], undefined);
      return json({ base_resp: { status_code: 0 }, data: { audio: wav.toString('hex') } });
    };
    assert.equal((await speech.speak('切换')).engine, 'minimax');
  });
  await test('Missing configuration, disabled cloud and system-only mode never access network', async () => {
    let current = { ...cfg, breezeVoice: '' }; let calls = 0;
    globalThis.fetch = async () => { calls++; return audio(); };
    const speech = createSpeech({ getConfig: () => current, opts, engines: { speakSapi: async () => ({ ok: true }) } });
    assert.equal((await speech.speak('x')).fallbackReason, 'no-voice');
    current = { ...cfg, breezeApiKey: '' };
    assert.equal((await speech.speak('x')).fallbackReason, 'no-key');
    current = { ...cfg, fallback: 'sapi' }; assert.equal((await speech.speak('x')).engine, 'sapi');
    assert.equal(speech.status().mode, 'sapi');
    current = { ...cfg, breezeEnabled: false }; assert.equal((await speech.speak('x')).engine, 'sapi');
    assert.equal(calls, 0);
  });
  await test('Failed playback falls back once; queue counts Breeze as cloud speech', async () => {
    globalThis.fetch = async () => audio(); let systemCalls = 0;
    const speech = createSpeech({ getConfig: () => cfg, opts, engines: { playWav: async () => { throw new Error('device failed'); }, speakSapi: async () => { systemCalls++; return { ok: true }; } } });
    assert.equal((await speech.speak('x')).fallbackReason, 'cloud-failed'); assert.equal(systemCalls, 1);
    let done;
    const completed = new Promise((resolve) => { done = resolve; });
    const speaker = createSpeaker({ speak: async () => ({ ok: true, engine: 'breeze' }), onEvent: done });
    speaker.say('test'); await completed;
    assert.equal(speaker.stats().cloudSpoken, 1); speaker.stop();
  });
} finally {
  globalThis.fetch = realFetch;
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

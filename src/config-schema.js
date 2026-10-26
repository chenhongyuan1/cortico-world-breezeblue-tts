/**
 * 这个 World 在控制台里的配置表单（WebUI 用 JSON Schema 生成表单）。
 *
 * 键是配置里的点分路径，值就是 worlds.breezeblue-tts.* 下的字段，和 src/index.js 的 defaults()
 * 一一对应。'x-hot': true 表示改完立刻生效（这个 World 每次用都现读 ctx.cfg，所以都是热改）。
 *
 * 音色下拉用 'x-options'：框架会去 /api/config/options/<kind> 现取选项，
 * 由 src/index.js 的 configOptions() 给出（系统音色是扫本机得到，不是写死的）。
 */
import { MINIMAX_MODELS, CHINESE_VOICES, EMOTIONS, AUDIO_FORMATS } from './cloud.js';

/** World 自己的 id，也是配置段名（worlds.breezeblue-tts）。 */
export const WORLD_ID = 'breezeblue-tts';

const K = `worlds.${WORLD_ID}`;

/** 动态下拉的 kind 名，index.js 的 configOptions() 按它返回选项。 */
export const OPTION_KINDS = {
  systemVoice: 'breezeblue-tts-system-voice',
  minimaxVoice: 'breezeblue-tts-minimax-voice',
};

/**
 * 按界面语言给配置组。这里只做中英两种标题，其余语言回退中文。
 */
export function petVoiceConfigGroups(language = 'zh') {
  const en = language === 'en';
  const t = (zh, eng) => (en ? zh && eng : zh);

  return [
    {
      id: `world:${WORLD_ID}`,
      owner: `world:${WORLD_ID}`,
      schema: {
        type: 'object',
        title: t('气泡朗读', 'Bubble speech'),
        description: t(
          '朗读桌宠气泡：可选 BreezeBlue 或 MiniMax 云端语音，缺少配置或失败时回退 Windows 系统语音。默认关。',
          'Reads pet bubbles using BreezeBlue or MiniMax, falling back to Windows speech on missing configuration or failure. Off by default.',
        ),
        properties: {
          [`${K}.cloudProvider`]: {
            type: 'string', title: t('云端服务', 'Cloud provider'),
            description: t('breeze = BreezeBlue；minimax = 原 MiniMax。两家的密钥和音色分开配置。', 'breeze = BreezeBlue; minimax = MiniMax. Each uses its own key and voice ID.'),
            enum: ['breeze', 'minimax'], 'x-hot': true,
          },
          [`${K}.enabled`]: {
            type: 'boolean',
            title: t('开启朗读', 'Read bubbles aloud'),
            description: t('打开后，桌宠每说一句都会念出来。', 'When on, every line the pet shows in a bubble is spoken.'),
            'x-hot': true,
          },
          [`${K}.fallback`]: {
            type: 'string',
            title: t('声音来源', 'Voice source'),
            description: t(
              'auto：能用云端就用云端，失败自动换系统语音；sapi：只用系统自带语音，不联网。',
              'auto: use the cloud when possible and fall back to the system voice; sapi: never go online, system voice only.',
            ),
            enum: ['auto', 'sapi'],
            'x-hot': true,
          },
          [`${K}.readAsk`]: {
            type: 'boolean',
            title: t('也念提问气泡', 'Read question bubbles too'),
            description: t('pet_ask 的提问与选项也念出来。', 'Speak pet_ask questions and their options as well.'),
            'x-hot': true,
          },
          [`${K}.minChars`]: {
            type: 'integer',
            title: t('最短朗读字数', 'Shortest line to read'),
            description: t('比这更短的句子（例如“嗯。”）不念，免得吵。', 'Lines shorter than this are skipped.'),
            minimum: 0,
            maximum: 20,
            'x-hot': true,
          },
        },
      },
    },
    {
      id: `world:${WORLD_ID}:breeze`,
      owner: `world:${WORLD_ID}`,
      schema: {
        type: 'object',
        title: t('BreezeBlue 云端语音', 'BreezeBlue cloud speech'),
        description: t('密钥放到部署目录 .env：BREEZE_API_KEY=...；在下方填写账户可用的音色 ID。选择 breeze 后使用本组设置。', 'Put BREEZE_API_KEY=... in the deployment .env and enter an accessible voice ID below. Used when the provider is breeze.'),
        properties: {
          [`${K}.breezeEnabled`]: {
            type: 'boolean', title: t('启用 BreezeBlue', 'Enable BreezeBlue'), 'x-hot': true,
          },
          [`${K}.breezeVoice`]: {
            type: 'string', title: t('BreezeBlue 音色 ID', 'BreezeBlue voice ID'),
            description: t('从 BreezeBlue 的音色库或 breeze-probe.mjs --voices 获取，通常形如 voc_...；不能使用 MiniMax 音色 ID。', 'Use an ID from BreezeBlue voices or breeze-probe.mjs --voices, usually voc_...; MiniMax voice IDs do not work.'), 'x-hot': true,
          },
          [`${K}.breezeModel`]: {
            type: 'string', title: t('模型', 'Model'),
            description: t('默认 breeze-tts-2；留空由服务端自动选择。', 'Default: breeze-tts-2. Leave empty for automatic selection.'), 'x-hot': true,
          },
          [`${K}.breezeLanguageCode`]: {
            type: 'string', title: t('语言代码', 'Language code'),
            description: t('留空自动识别；中文填 zh，英文填 en。', 'Empty for automatic detection; zh for Chinese, en for English.'), 'x-hot': true,
          },
          [`${K}.breezeInstructions`]: {
            type: 'string', title: t('演绎指令', 'Performance instructions'),
            description: t('用与朗读文字相同的语言描述语气、情绪，例如：温柔自然，像在和朋友聊天。留空使用默认演绎。', 'Describe tone and emotion in the same language as the text. Empty uses default delivery.'), 'x-hot': true,
          },
          [`${K}.breezeSpeed`]: {
            type: 'number', title: t('语速', 'Speed'), minimum: 0.5, maximum: 2, multipleOf: 0.05, 'x-hot': true,
          },
          [`${K}.breezeVolume`]: {
            type: 'number', title: t('音量', 'Volume'), minimum: 0.01, maximum: 2, multipleOf: 0.01, 'x-hot': true,
          },
          [`${K}.breezeGuidanceScale`]: {
            type: 'number', title: t('演绎指令强度', 'Guidance scale'), minimum: 1, maximum: 10, multipleOf: 0.1, 'x-hot': true,
          },
          [`${K}.breezeSpeakerBoost`]: {
            type: 'boolean', title: t('增强音色相似度', 'Speaker boost'),
            description: t('有演绎指令且强度大于 1 时服务端会忽略此开关。', 'Ignored by the service when instructions are non-empty and guidance scale exceeds 1.'), 'x-hot': true,
          },
          [`${K}.breezeTimeoutMs`]: {
            type: 'integer', title: t('云端超时', 'Cloud timeout'), minimum: 2000, maximum: 120000, 'x-suffix': 'ms', 'x-hot': true,
          },
          [`${K}.breezeApiKeyEnv`]: {
            type: 'string', title: t('密钥变量名（不是密钥本身）', 'Key variable name (not the API key)'),
            description: t('建议留空。此处只能填 BREEZE_API_KEY 这样的变量名称，不能粘贴 brz_ 开头的密钥。实际密钥写到部署目录 .env：BREEZE_API_KEY=你的密钥。', 'Leave empty normally. Enter a variable name such as BREEZE_API_KEY, never the brz_ credential. Put the actual key in the deployment .env: BREEZE_API_KEY=your_key.'), 'x-hot': true,
          },
        },
      },
    },
    {
      id: `world:${WORLD_ID}:minimax`,
      owner: `world:${WORLD_ID}`,
      schema: {
        type: 'object',
        title: t('MiniMax 云端语音', 'MiniMax cloud speech'),
        description: t(
          'API key 不在这里填：放到部署目录的 .env 里（MINIMAX_API_KEY=...），或设成同名环境变量。改动后下一句朗读就会用上。',
          'The API key is not entered here: put it in .env in the deployment directory (MINIMAX_API_KEY=...), or set that environment variable. The next spoken line picks it up.',
        ),
        properties: {
          [`${K}.minimaxEnabled`]: {
            type: 'boolean',
            title: t('启用云端语音', 'Enable cloud speech'),
            description: t('关掉＝完全不联网，直接走系统语音。', 'Off means never going online: system voice only.'),
            'x-hot': true,
          },
          [`${K}.minimaxEndpoint`]: {
            type: 'string',
            title: t('接口站点', 'API site'),
            description: t('cn = api.minimax.cn（国内），io = api.minimax.io（国际）。key 要和站点是一家的。', 'cn = api.minimax.cn, io = api.minimax.io. The key must belong to that site.'),
            enum: ['cn', 'io'],
            'x-hot': true,
          },
          [`${K}.minimaxModel`]: {
            type: 'string',
            title: t('模型', 'Model'),
            description: t('turbo 更快更便宜，hd 音质更好。桌宠短句建议 turbo。', 'turbo is faster and cheaper, hd sounds better. Turbo suits short pet lines.'),
            enum: [...MINIMAX_MODELS],
            'x-hot': true,
          },
          [`${K}.minimaxVoice`]: {
            type: 'string',
            title: t('音色', 'Voice'),
            description: t('官方系统音色 ID；复刻/自建音色也能直接填它的 ID。', 'A system voice ID; cloned or designed voice IDs work here too.'),
            'x-options': OPTION_KINDS.minimaxVoice,
            'x-hot': true,
          },
          [`${K}.minimaxSpeed`]: {
            type: 'number',
            title: t('语速', 'Speed'),
            description: t('0.5 最慢，1 正常，2 最快。', '0.5 slowest, 1 normal, 2 fastest.'),
            minimum: 0.5,
            maximum: 2,
            multipleOf: 0.05,
            'x-hot': true,
          },
          [`${K}.minimaxVolume`]: {
            type: 'number',
            title: t('音量', 'Volume'),
            description: t('0.1～10，1 为正常。', '0.1 to 10, 1 is normal.'),
            minimum: 0.1,
            maximum: 10,
            multipleOf: 0.1,
            'x-hot': true,
          },
          [`${K}.minimaxPitch`]: {
            type: 'integer',
            title: t('音调', 'Pitch'),
            description: t('-12～12，0 为原调。', '-12 to 12, 0 is the original pitch.'),
            minimum: -12,
            maximum: 12,
            'x-hot': true,
          },
          [`${K}.minimaxEmotion`]: {
            type: 'string',
            title: t('情绪', 'Emotion'),
            description: t('留空＝让模型按文本自己决定（推荐）。fluent/whisper 只有 2.6 系列支持。', 'Empty lets the model decide from the text (recommended). fluent/whisper need the 2.6 series.'),
            enum: [...EMOTIONS],
            'x-hot': true,
          },
          [`${K}.minimaxTimeoutMs`]: {
            type: 'integer',
            title: t('云端超时', 'Cloud timeout'),
            description: t('超过这个时间没回来就改用系统语音，免得气泡等太久。', 'Past this, the line switches to the system voice so a bubble never waits long.'),
            minimum: 2000,
            maximum: 120000,
            'x-suffix': 'ms',
            'x-hot': true,
          },
          [`${K}.minimaxApiKeyEnv`]: {
            type: 'string',
            title: t('key 的环境变量名', 'Key environment variable'),
            description: t('留空＝按 MINIMAX_API_KEY、MINIMAX_KEY、MINIMAX_TTS_API_KEY 依次找。', 'Empty tries MINIMAX_API_KEY, MINIMAX_KEY, MINIMAX_TTS_API_KEY in order.'),
            'x-hot': true,
          },
          [`${K}.minimaxSampleRate`]: {
            type: 'string',
            title: t('采样率', 'Sample rate'),
            description: t('一般不用改。', 'Rarely worth changing.'),
            enum: ['16000', '22050', '24000', '32000', '44100'],
            'x-hot': true,
          },
          [`${K}.minimaxLanguageBoost`]: {
            type: 'string',
            title: t('语言倾向', 'Language boost'),
            description: t('auto 自动识别；中文夹杂英文时可显式选 Chinese。', 'auto detects it; pick Chinese when the text mixes Chinese and English.'),
            enum: ['auto', 'Chinese', 'English', 'Chinese,Yue', 'Japanese', 'Korean'],
            'x-hot': true,
          },
          [`${K}.minimaxFormat`]: {
            type: 'string',
            title: t('音频格式', 'Audio format'),
            description: t('固定 wav：本地播放器按 WAV 播，换格式可能没声音。', 'Keep wav: the local player plays WAV; another format may stay silent.'),
            enum: [...AUDIO_FORMATS],
            'x-hot': true,
          },
        },
      },
    },
    {
      id: `world:${WORLD_ID}:sapi`,
      owner: `world:${WORLD_ID}`,
      schema: {
        type: 'object',
        title: t('系统语音（回退）', 'System voice (fallback)'),
        description: t('云端失败或没配 key 时用它；也可把「声音来源」设为 sapi 只用它。', 'Used when the cloud fails or has no key; set Voice source to sapi to use only this.'),
        properties: {
          [`${K}.sapiVoice`]: {
            type: 'string',
            title: t('系统音色', 'System voice'),
            description: t('留空＝第一个可用音色；可只写一部分（如 Huihui）。', 'Empty uses the first available voice; a fragment works too (e.g. Huihui).'),
            'x-options': OPTION_KINDS.systemVoice,
            'x-hot': true,
          },
          [`${K}.sapiRate`]: {
            type: 'integer',
            title: t('系统语速', 'System rate'),
            description: t('-10 最慢，0 正常，10 最快。', '-10 slowest, 0 normal, 10 fastest.'),
            minimum: -10,
            maximum: 10,
            'x-hot': true,
          },
          [`${K}.sapiVolume`]: {
            type: 'integer',
            title: t('系统音量', 'System volume'),
            minimum: 0,
            maximum: 100,
            'x-suffix': '%',
            'x-hot': true,
          },
        },
      },
    },
    {
      id: `world:${WORLD_ID}:advanced`,
      owner: `world:${WORLD_ID}`,
      schema: {
        type: 'object',
        title: t('朗读：高级', 'Bubble speech: advanced'),
        description: t('一般不用改。事件目录留空表示自动找（Coopanion 里框架会直接给出正确路径）。', 'Usually nothing to change. Leave the data directory empty to auto-detect.'),
        properties: {
          [`${K}.dataDir`]: {
            type: 'string',
            title: t('事件目录（部署目录）', 'Data directory (deployment)'),
            description: t('扩展从这里读 events.jsonl；密钥文件 .env 也在这一层。', 'events.jsonl is read from here; the .env with the key sits in this same directory.'),
            'x-path': { kind: 'directory' },
            'x-hot': false,
          },
          [`${K}.replayExisting`]: {
            type: 'boolean',
            title: t('启动时补念已有事件', 'Replay existing lines on start'),
            description: t('默认只念扩展启动之后新冒出来的气泡。', 'By default only bubbles that appear after the extension starts are spoken.'),
            'x-hot': false,
          },
          [`${K}.maxChars`]: {
            type: 'integer',
            title: t('单句字数上限', 'Characters per line'),
            description: t('超长的句子截断后再念；云端按字符计费，也能顺手省钱。', 'Longer lines are cut before being spoken; the cloud bills per character, so this also saves money.'),
            minimum: 40,
            maximum: 500,
            'x-hot': true,
          },
          [`${K}.playTimeoutSec`]: {
            type: 'integer',
            title: t('单句播放上限', 'Playback cap'),
            description: t('一句最多等这么久，防止某个音频文件卡住队列。', 'Never wait longer than this for one line, so a bad file cannot stall the queue.'),
            minimum: 3,
            maximum: 600,
            'x-suffix': 's',
            'x-hot': true,
          },
          [`${K}.verbose`]: {
            type: 'boolean',
            title: t('写详细日志', 'Verbose logging'),
            description: t('把每一次朗读、回退、丢弃、失败都写进运行日志，排错用。', 'Log every spoken line, fallback, drop and failure into the run log.'),
            'x-hot': true,
          },
        },
      },
    },
  ];
}

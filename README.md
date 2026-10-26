# BreezeBlue 气泡朗读

Coopanion BreezeBlue / MiniMax 气泡朗读，支持演绎控制和 Windows 系统语音回退，使用云端api连接

包名为 `cortico-world-breezeblue-tts`，默认关闭。适用 Windows；需要 Coopanion 支持 World API 6。

作者与维护者：**星云** · [npm 安装包](https://www.npmjs.com/package/cortico-world-breezeblue-tts) · [反馈问题](https://github.com/chenhongyuan1/cortico-world-breezeblue-tts/issues) · [MIT 许可](LICENSE)

## 与 Coopanion 的关系

本项目是 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) 的第三方 World 扩展。Coopanion 是由 Pal-AI-Lab 开源的 AI 桌宠应用，负责对话、桌宠展示及扩展管理；本扩展为桌宠气泡提供语音朗读。

- **Coopanion 官方仓库**：[Pal-AI-Lab/Coopanion](https://github.com/Pal-AI-Lab/Coopanion)
- **Coopanion 中文说明**：[README_zh.md](https://github.com/Pal-AI-Lab/Coopanion/blob/main/README_zh.md)
- **Coopanion 安装包**：[官方 Releases](https://github.com/Pal-AI-Lab/Coopanion/releases/latest)
- **扩展市场索引**：[Pal-AI-Lab/cortico-extensions](https://github.com/Pal-AI-Lab/cortico-extensions)

连接流程：Coopanion 生成气泡 → 本扩展在本机读取 `desktop-pet.self` 事件 → 将朗读文字发送到所选 BreezeBlue / MiniMax API → 在 Windows 播放返回的 WAV；云端失败时自动切换系统语音。

请先安装并配置 Coopanion，再通过它的扩展页安装本包。Coopanion 本身支持多个系统；本扩展当前的音频播放和系统语音回退依赖 Windows。扩展按 World API 6 接入，已在 Coopanion 0.2.11 验证。

本项目由星云独立维护，保留上游代码来源与许可说明。Coopanion 官方项目以其自身许可证为准，本扩展采用 MIT 许可。

## 安装

在 Coopanion 扩展页搜索 `cortico-world-breezeblue-tts` 并安装，随后重启 Coopanion。
控制台 → World →「BreezeBlue 气泡朗读」，激活并开启朗读。

独立 World ID 为 `breezeblue-tts`，配置段为 `worlds.breezeblue-tts`。
若同时装有原 `cortico-world-pet-voice`，请只启用其中一个朗读扩展，避免同一句被朗读两次。

## BreezeBlue 配置

### 1. 获取 API Key

1. 打开 [BreezeBlue 平台首页](https://breezeblue.ai/app/home)，注册或登录账号。
2. 打开 [API Keys 管理页](https://breezeblue.ai/app/developer/api-keys)，点击 **Create API key**。
3. 为密钥填写一个便于识别的名称，例如 `Coopanion TTS`，创建后立即复制并保存完整 API Key。官方只在创建或轮换时显示完整密钥，之后无法再次查看。
4. 语音合成会消耗账户额度；如果设置了密钥预算，也需要确保该预算允许合成。额度和价格以平台当前页面为准。

操作依据：[官方快速开始](https://docs.breezeblue.ai/quickstart)、[API Key 与鉴权说明](https://docs.breezeblue.ai/authentication)。

### 2. 在 Coopanion 中使用密钥

1. 在当前部署目录（含 `config.json` 的目录）创建或编辑 `.env`，合并 `breeze.env.example` 中的变量：

   ```dotenv
   BREEZE_API_KEY=你的实际密钥
   ```

2. 云端服务选 `breeze`，启用 BreezeBlue，填写账户可访问的音色 ID，通常为 `voc_...`。
3. 模型默认 `breeze-tts-2`；语言留空自动识别，也可填 `zh` 或 `en`。

「密钥变量名」通常留空。它只接收 `BREEZE_API_KEY` 这样的名称；不要在该栏粘贴密钥本身。
`.env` 和表单参数每次朗读重新读取；新增或修改系统环境变量后通常需要重启 Coopanion。

### 3. 获取音色 ID

API Key 和音色 ID 分别填写：API Key 放入 `.env`，音色 ID 填入扩展配置页的「BreezeBlue 音色 ID」。在包目录中查询账户可用音色，`--data` 指向你的部署目录：

```powershell
node scripts/breeze-probe.mjs --data "<部署目录>" --voices --language zh
```

从返回的列表中选择一个音色，将其 `id`（通常形如 `voc_...`）复制到配置页。去掉 `--language zh` 查所有语言。返回下一页标记时，使用 `--page-token` 传入 `nextPageToken`。

密钥和音色配置完成后，可运行离线状态检查：

```powershell
node scripts/breeze-probe.mjs --data "<部署目录>"
```

`configured: true` 表示已读到密钥，`ready: true` 表示密钥和音色 ID 均已填写；它们不代表已验证服务端授权，真实试听命令见下方「测试与诊断」。

## 参数

| 参数（`worlds.breezeblue-tts.*`） | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 朗读总开关 |
| `cloudProvider` | `breeze` | `breeze` / `minimax` |
| `fallback` | `auto` | `auto` 云端优先；`sapi` 仅系统语音 |
| `breezeEnabled` | `true` | BreezeBlue 开关 |
| `breezeVoice` | 空 | 账户可访问的音色 ID |
| `breezeModel` | `breeze-tts-2` | 留空由服务端选模型 |
| `breezeLanguageCode` | 空 | 两字母代码，例如 `zh` / `en` |
| `breezeInstructions` | 空 | 与输入同语言的语气、情绪描述 |
| `breezeSpeed` | `1` | 0.5–2 |
| `breezeVolume` | `1` | 0.01–2 |
| `breezeGuidanceScale` | `1` | 1–10；演绎指令强度 |
| `breezeSpeakerBoost` | `false` | 增强音色相似度；有指令且强度 > 1 时由服务端忽略 |
| `breezeTimeoutMs` | `15000` | 包含合成与音频下载 |
| `breezeApiKeyEnv` | 空 | 自定义密钥变量名 |
| `maxChars` | `220` | 单句字符上限，最多 500 |
| `verbose` | `false` | 本机详细日志，可能包含朗读文字 |

密钥查找：兼容明文配置 `breezeApiKey` → 自定义环境变量 → `BREEZE_API_KEY`、`BREEZEBLUE_API_KEY`、`BREEZE_BLUE_API_KEY` → 部署 `.env`。推荐使用 `.env`。

MiniMax 使用独立的 `MINIMAX_API_KEY`、`minimax*` 配置和音色 ID；在云端服务选择 `minimax` 后生效。两家密钥不会互相代用。

## 回退与限制

缺少密钥或音色、网络超时、接口失败、播放失败均回退 Windows 系统语音。云端连续失败三次后暂停 120 秒，再尝试恢复。切换服务会清除旧服务的熔断状态。

BreezeBlue 使用同步文字转语音接口，固定请求 WAV，由 Windows Media.SoundPlayer 播放。若服务端返回 202 后台任务，本句回退系统语音；此版不轮询后台任务、不支持流式播放或时间戳对齐。

事件监听依赖 `desktop-pet.self` 事件格式；升级 Coopanion 后若格式变化，需要重新验证。此扩展不向模型提供工具。

## 测试与诊断

克隆开源仓库后运行离线测试，开发环境需安装 Node.js 20.19 或更高版本：

```powershell
git clone https://github.com/chenhongyuan1/cortico-world-breezeblue-tts.git
cd cortico-world-breezeblue-tts
npm test
```

扩展的运行代码没有额外 npm 依赖。以下诊断命令在仓库根目录执行，`--data` 指向你自己的 Coopanion 部署目录：

```powershell
# 离线自动测试，不发起真实合成
npm test

# 检查配置状态，不输出密钥
node scripts/breeze-probe.mjs --data "<部署目录>"

# 完整自检，包含本机语音及播放器探测
node scripts/selftest.mjs --data "<部署目录>"

# 真实生成并播放，会消耗少量合成额度
node scripts/breeze-probe.mjs --data "<部署目录>" --speak --play --text "你好。"
```

测试用假密钥均为离线固定样例。历史 `selftest.mjs --cloud` 和 `minimax-probe.mjs` 专门验证 MiniMax，BreezeBlue 使用 `breeze-probe.mjs`。

## 数据与许可

开启云端朗读后，朗读文字会发送至所选语音服务；系统语音模式不发送云端请求。没有开发者遥测端点。详见 [PRIVACY.md](PRIVACY.md)。

本派生版作者与维护者：**星云**。MIT 许可，派生自杠精大队委的 `cortico-world-pet-voice@0.2.1`；保留原作者署名，来源及修改说明见 [NOTICE.md](NOTICE.md) 和 [LICENSE](LICENSE)。本包使用新建 SVG 图标，不分发原图标或任何音频样本。

接口参考：[BreezeBlue TTS](https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech)、[音色列表](https://docs.breezeblue.ai/api-reference/voices/list-voices)、[输出格式](https://docs.breezeblue.ai/concepts/output-format)。

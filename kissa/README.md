# 喫茶マクロ 同声传译 PWA（课堂高准确修正版）

日语课堂 → 实时日文字幕 + 中文字幕 + 全程录音备份。宏观经济学术语表(383 词)已内置。

## 一、部署到 Vercel(10 分钟)

1. 把这个文件夹推到 GitHub 仓库(或直接 `npx vercel` 上传)。
2. Vercel → New Project → 导入仓库,Framework 选 **Other**,不需要 build 命令。
3. Settings → Environment Variables 添加:

| 变量 | 必填 | 说明 |
|---|---|---|
| `OPENAI_API_KEY` | ✅ | 你的 key,只存在服务端 |
| `ASR_MODEL` | 可选 | 默认 `gpt-4o-transcribe`（推荐）;省钱可填 `gpt-4o-mini-transcribe` |
| `ASR_MODE` | 可选 | 默认 `accurate` 高准确整句模式;只有特别追求最低延迟时才填 `realtime` |
| `ASR_DELAY` | 可选 | 仅 `ASR_MODE=realtime` 时生效;默认 `high` |
| `TRANSLATE_MODEL` | 可选 | 翻译模型,默认 `gpt-4o-mini`;想用你说的那个 mini 模型,把它的**正式 API 模型名**填进来即可 |
| `TRANSLATE_PROVIDER` | 可选 | `openai`(默认)/ `anthropic` / `gemini` |
| `ASR_PROVIDER` | 可选 | `openai`(默认)/ `deepgram`(骨架已留) |

4. 部署完成后用手机浏览器打开域名 → 分享 → **添加到主屏幕**,就是一个 App 了。

⚠️ 安全:API key 永远不进前端。默认模式只把短音频片段发给自己的 `/api/transcribe` 服务端函数,再由服务端调用 OpenAI。

## 二、上课流程

1. 提前 5 分钟:打开 App → 术语表确认选中「宏观经济学」→ 点**开始同传**(允许麦克风)。
2. 手机尽量靠近老师,屏幕会自动保持常亮(仍建议带充电宝)。
3. 页面显示「正在精听」时代表一段完整语句正在识别;通常比声音慢约 5–12 秒,换取明显更高的准确度。
4. 下课:点**停止** → 依次导出。

## 三、数据保存与导出(都在本机,不经过服务器)

- **字幕**:每来一句就自动存进浏览器 localStorage,App 崩了重开也在。导出按钮:
  - **TXT** — 带时间戳的日中对照,复习用
  - **SRT** — 标准字幕格式,可配着录音在播放器里对照看
  - **JSON** — 结构化数据,以后喂给 AI 做重点总结用这个
  - **复制全部** — 直接进剪贴板,粘到备忘录/微信
- **录音**:每 10 秒一片自动写入 IndexedDB(手机浏览器给网站的存储空间,90 分钟约 30–50MB,足够)。点**导出录音**合并成一个 `.webm`(iPhone 上可能是 `.m4a`),iPhone 存到"文件",安卓进下载目录。
- **清空缓存**只清本机暂存,已导出的文件不受影响。换下一节课前记得先导出再清空。

课后杀手锏:把导出的录音 + JSON 字幕一起丢给 AI,让它出"本节课期末重点清单"。

## 四、以后各科术语表怎么加

三种方式,都在 App 内「术语表」面板:

1. **新学科 + 手动粘贴**:点"新学科"起名(如"计量经济学"),文本框里每行一条 `日语=中文=英语`(英语可省),保存。
2. **导入文件**:支持三种格式,自动识别——
   - GPT 给你做的 `app_lexicon_import.json`(本项目内置的宏观表就是它转的)
   - CSV(表头含 `term_ja` / `term_zh` / `term_en` / `priority` 即可,`macro_voice_terms.csv` 那种直接扔进来)
   - 纯文本 `日语=中文`
3. **让 GPT 照样再产一包**:你那个提取流程对新学科的讲义再跑一遍,导出 json 扔进来就行。

术语表会做两次保护：高优先级词会直接放进 `gpt-4o-transcribe` 的转写提示；翻译时再把**当前整句命中的术语**（最多 40 条）交给中文模型统一译名。

## 五、换模型 / 换供应商(接口都留好了)

- **换翻译模型**:改环境变量 `TRANSLATE_MODEL`,重新部署,完事。
- **换翻译供应商**:`TRANSLATE_PROVIDER=anthropic` 或 `gemini`,配上对应的 `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`。三家的调用代码都写好了。
- **切回最低延迟模式**:设置 `ASR_MODE=realtime`;会改用 `gpt-realtime-whisper`,但课堂远距离准确度通常不如默认高准确模式。
- **换转写供应商**:`api/session.js` 里 Deepgram 的临时令牌函数已写好,前端 `providers.js` 里有 `DeepgramTranscriber` 骨架,照着 OpenAI 那个类补 4 步注释即可。Soniox 同理。

## 六、故障排查

| 现象 | 处理 |
|---|---|
| 点开始后一直"连接中" | 打开 Vercel 的 Functions 日志看 `/api/session`;多半是 key 没配 |
| 出现 `beta_api_shape_disabled` | 说明浏览器仍缓存旧版。关闭已安装的 PWA,在浏览器里重新打开网址并刷新一次;本包已经彻底移除 Beta 接口 |
| 页面提示“高准确转写失败” | 查看 Vercel `/api/transcribe` 日志;确认 API key 有余额且可用 `gpt-4o-transcribe` |
| 有日文字幕但中文一直"…" | 看 `/api/translate` 日志,通常是 `TRANSLATE_MODEL` 模型名写错 |
| iPhone 锁屏后没声音了 | 正常限制。开着屏幕放桌上,App 已申请常亮 |
| 教室 WiFi 烂 | 直接用流量,90 分钟音频上行大约 100–200MB 级别 |

## 七、高准确修正版做了什么

- 默认恢复到准确度更高、支持术语 prompt 的 `gpt-4o-transcribe`。
- 不再把零碎单词逐个翻译：按自然停顿聚合为 4–12 秒完整语句，再进行日中翻译。
- 每一段都会带上课程术语和上一段日语，保持专有词、句意和上下文连续。
- 麦克风音频可靠重采样为 16kHz PCM16 WAV；断网时每段自动重试一次。
- PWA 改为代码优先联网更新并升级缓存版本,以后部署修复后不会长期卡在旧 JS。

默认成本约为：转写 $0.36/小时，加上文字翻译约 $0.04–0.12/小时。模型价格以 OpenAI Pricing 页面为准。

# 喫茶マクロ 同声传译 PWA（Realtime GA 修正版）

日语课堂 → 实时日文字幕 + 中文字幕 + 全程录音备份。宏观经济学术语表(383 词)已内置。

## 一、部署到 Vercel(10 分钟)

1. 把这个文件夹推到 GitHub 仓库(或直接 `npx vercel` 上传)。
2. Vercel → New Project → 导入仓库,Framework 选 **Other**,不需要 build 命令。
3. Settings → Environment Variables 添加:

| 变量 | 必填 | 说明 |
|---|---|---|
| `OPENAI_API_KEY` | ✅ | 你的 key,只存在服务端 |
| `ASR_MODEL` | 可选 | 实时转写默认 `gpt-realtime-whisper`;一般不要填写。若 Vercel 残留旧的 `gpt-4o-transcribe`/mini 值,程序会自动迁移到新模型 |
| `ASR_DELAY` | 可选 | `minimal`/`low`/`medium`/`high`/`xhigh`,默认 `low`;越高通常越偏准确、越慢 |
| `TRANSLATE_MODEL` | 可选 | 翻译模型,默认 `gpt-4o-mini`;想用你说的那个 mini 模型,把它的**正式 API 模型名**填进来即可 |
| `TRANSLATE_PROVIDER` | 可选 | `openai`(默认)/ `anthropic` / `gemini` |
| `ASR_PROVIDER` | 可选 | `openai`(默认)/ `deepgram`(骨架已留) |

4. 部署完成后用手机浏览器打开域名 → 分享 → **添加到主屏幕**,就是一个 App 了。

⚠️ 安全:API key 永远不进前端。浏览器拿到的是 `/api/session` 发的**短时效临时令牌**,泄露也只有几分钟寿命。

## 二、上课流程

1. 提前 5 分钟:打开 App → 术语表确认选中「宏观经济学」→ 点**开始同传**(允许麦克风)。
2. 手机尽量靠近老师,屏幕会自动保持常亮(仍建议带充电宝)。
3. 断网/断线会自动重连,状态灯:🟢同传中 🟡重连中 🔴出错。
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

省钱设计:术语表再大也不怕——翻译时只把**当前这句话里命中的术语**(按优先级最多 40 条)塞进 prompt。当前 GA 的 `gpt-realtime-whisper` 不接受转写 prompt,所以术语表主要在中文翻译阶段纠正识别错字并统一译名。

## 五、换模型 / 换供应商(接口都留好了)

- **换翻译模型**:改环境变量 `TRANSLATE_MODEL`,重新部署,完事。
- **换翻译供应商**:`TRANSLATE_PROVIDER=anthropic` 或 `gemini`,配上对应的 `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`。三家的调用代码都写好了。
- **换转写供应商**:`api/session.js` 里 Deepgram 的临时令牌函数已写好,前端 `providers.js` 里有 `DeepgramTranscriber` 骨架,照着 OpenAI 那个类补 4 步注释即可。Soniox 同理。

## 六、故障排查

| 现象 | 处理 |
|---|---|
| 点开始后一直"连接中" | 打开 Vercel 的 Functions 日志看 `/api/session` 报错;多半是 key 没配或模型名不对 |
| 出现 `beta_api_shape_disabled` | 说明浏览器仍缓存旧版。关闭已安装的 PWA,在浏览器里重新打开网址并刷新一次;本包已经彻底移除 Beta 接口 |
| `/api/session` 报 GA 创建会话失败 | 确认 `OPENAI_API_KEY` 有效;若手工设置过 `ASR_MODEL`,先删除该变量再重新部署 |
| 有日文字幕但中文一直"…" | 看 `/api/translate` 日志,通常是 `TRANSLATE_MODEL` 模型名写错 |
| iPhone 锁屏后没声音了 | 正常限制。开着屏幕放桌上,App 已申请常亮 |
| 教室 WiFi 烂 | 直接用流量,90 分钟音频上行大约 100–200MB 级别 |

## 七、这次修复了什么

- 彻底删除停用的 Realtime Beta 端点、header、subprotocol 和 `intent=transcription`。
- 切换到 GA 流式模型 `gpt-realtime-whisper` 与 `/v1/realtime/client_secrets`。
- 麦克风音频可靠重采样为 24kHz PCM16,按 100ms 打包,自动静音断句且最长 6 秒提交一次。
- PWA 改为代码优先联网更新并升级缓存版本,以后部署修复后不会长期卡在旧 JS。

模型能力和价格会变化,请以 OpenAI 官方实时转写文档与 Pricing 页面为准。

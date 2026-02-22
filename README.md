# openclaw-tavern-chat

[English](#english) | [中文](#中文)

An OpenClaw plugin for managing character cards, worldbooks, and regex rules through chat commands.

---

## English

## Install

```bash
openclaw plugins install openclaw-tavern-chat
```

## Update

```bash
openclaw plugins update openclaw-tavern-chat
```

## Configuration

No additional configuration required. The plugin works out of the box once installed.

Character cards, worldbooks, and regex rules are stored under the OpenClaw state directory:

```text
~/.openclaw/
├── characters/          # Character card files (.png, .json)
├── worldbooks/          # Worldbook files (.json)
└── regex-rules.json     # Regex rules
```

## Features

- Character Cards: Import `.png` / `.json` character cards. Auto-injects persona, system_prompt, example dialogue, etc.
- Worldbooks: Keyword-based lore injection with constant entries, sticky turns, and embedded character_book support.
- Regex Rules: Apply regex replacements to AI output (e.g., strip tags, reformat text).
- Placeholder Replacement: Auto-replaces `{{char}}`, `{{user}}`, `{{<user>}}` and other common card macros.
- Attachment Auto-Import: Send a PNG to auto-detect character cards; send a JSON to auto-detect worldbooks or regex rules.

## Chat Commands

### Character Cards

| Command | Description |
|---------|-------------|
| `/character list` | List all character cards |
| `/character set <filename\|name>` | Switch character card |
| `/character show` | Show current character card |
| `/character clear` | Clear current character card |
| `/character mode <full\|minimal>` | Switch injection mode |

**Injection modes:**
- `full` (default): Inject all fields including scenario, first_message, example_dialogue
- `minimal`: Inject only core persona, without opener and scenario

### Worldbooks

| Command | Description |
|---------|-------------|
| `/worldbook list` | List all worldbooks |
| `/worldbook set <filename>` | Switch worldbook |
| `/worldbook show` | Show current worldbook |
| `/worldbook clear` | Clear current worldbook |

### Regex Rules

| Command | Description |
|---------|-------------|
| `/regex list` | List all rules |
| `/regex add <pattern> => <replacement>` | Add a rule |
| `/regex remove <index\|name>` | Remove a rule |
| `/regex enable <index\|name>` | Enable a rule |
| `/regex disable <index\|name>` | Disable a rule |
| `/regex clear` | Remove all rules |

## Attachment Import

Send files directly in chat for auto-import:

- PNG: Detects embedded character data (tEXt/iTXt `chara` chunk) and imports to `characters/`.
- JSON: Auto-detects worldbook or regex rules and imports accordingly. Worldbooks are auto-activated for the current session.
- Note: Some channels may not respond to image messages. If a character card PNG is not recognized, send it as a file/document attachment instead of an image message.

## MiniMax TTS (Voice Synthesis)

Add to `openclaw.json5` under `plugins`:

```json5
{
  plugins: {
    "openclaw-tavern-chat": {
      minimaxTts: {
        enabled: true,
        apiToken: "your-minimax-api-token",  // or set MINIMAX_API_TOKEN env var
        voiceId: "female-shaonv-jingpin",    // optional, change voice
      },
    },
  },
}
```

Chat commands to control TTS read-aloud:

| Command | Description |
|---------|-------------|
| `/tavern-tts on` or `开启朗读` | Enable TTS read-aloud prompt |
| `/tavern-tts off` or `关闭朗读` | Disable TTS read-aloud prompt |
| `/tavern-tts status` or `朗读状态` | Show TTS status |
| `/minimax-tts <text>` | Test voice synthesis |

---

## 中文

OpenClaw 插件，通过聊天命令管理角色卡、世界书和正则规则。

### 安装

```bash
openclaw plugins install openclaw-tavern-chat
```

### 更新

```bash
openclaw plugins update openclaw-tavern-chat
```

### 配置

安装后无需额外配置，插件开箱即用。

角色卡、世界书和正则规则存储在 OpenClaw 状态目录下：

```text
~/.openclaw/
├── characters/          # 角色卡文件 (.png, .json)
├── worldbooks/          # 世界书文件 (.json)
└── regex-rules.json     # 正则规则
```

### 功能

- 角色卡：导入 `.png` / `.json` 角色卡，切换后自动注入人设、system_prompt、示例对话等。
- 世界书：基于关键词匹配的 lore 注入，支持 constant 条目、sticky 机制、嵌入式 character_book。
- 正则规则：对 AI 输出进行正则替换（如过滤特定标签、格式化文本）。
- 占位符替换：自动替换 `{{char}}`、`{{user}}`、`{{<user>}}` 等常见占位符。
- 附件自动导入：发送 PNG 文件自动识别角色卡，发送 JSON 文件自动识别世界书或正则规则。

### 聊天命令

#### 角色卡

| 命令 | 说明 |
|------|------|
| `切换角色卡 <名称>` | 切换到指定角色卡 |
| `角色卡列表` / `查看角色卡` / `列出角色卡` | 列出所有角色卡 |
| `清空角色卡` / `取消角色卡` | 取消当前角色卡 |
| `/character list` | 列出所有角色卡 |
| `/character set <filename\|name>` | 切换角色卡 |
| `/character show` | 查看当前角色卡 |
| `/character clear` | 清空角色卡 |
| `/character mode <full\|minimal>` | 切换注入模式 |

**角色卡注入模式：**
- `full`（默认）：注入全部字段，含 scenario、first_message、example_dialogue
- `minimal`：只注入核心人设，不注入开场白与场景等

#### 世界书

| 命令 | 说明 |
|------|------|
| `切换世界书 <名称>` | 切换到指定世界书 |
| `世界书列表` / `查看世界书` | 列出所有世界书 |
| `清空世界书` / `取消世界书` | 取消当前世界书 |
| `/worldbook list` | 列出所有世界书 |
| `/worldbook set <filename>` | 切换世界书 |
| `/worldbook show` | 查看当前世界书 |
| `/worldbook clear` | 清空世界书 |

#### 正则规则

| 命令 | 说明 |
|------|------|
| `/regex list` | 列出所有规则 |
| `/regex add <pattern> => <replacement>` | 添加规则 |
| `/regex remove <index\|name>` | 删除规则 |
| `/regex enable <index\|name>` | 启用规则 |
| `/regex disable <index\|name>` | 禁用规则 |
| `/regex clear` | 清空所有规则 |

### 附件导入

直接在聊天中发送文件即可自动导入：

- PNG 文件：检测是否包含角色卡数据（tEXt/iTXt `chara` chunk），有则导入到 `characters/` 目录。
- JSON 文件：自动判断是世界书还是正则规则文件并导入，世界书会自动切换到当前会话。
- 注意：某些渠道对图片消息可能没有反应。若角色卡 PNG 未被识别，请用"文件/文档附件"方式发送，不要用图片消息发送。

### MiniMax TTS（语音合成）

在 `openclaw.json5` 的 `plugins` 中添加配置：

```json5
{
  plugins: {
    "openclaw-tavern-chat": {
      minimaxTts: {
        enabled: true,
        apiToken: "your-minimax-api-token",  // 或设置环境变量 MINIMAX_API_TOKEN
        voiceId: "female-shaonv-jingpin",    // 可选，更换音色
      },
    },
  },
}
```

语音朗读控制命令：

| 命令 | 说明 |
|------|------|
| `/tavern-tts on` 或 `开启朗读` | 开启语音朗读提示 |
| `/tavern-tts off` 或 `关闭朗读` | 关闭语音朗读提示 |
| `/tavern-tts status` 或 `朗读状态` | 查看语音状态 |
| `/minimax-tts <文本>` | 测试语音合成 |

## License

MIT



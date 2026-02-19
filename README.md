# openclaw-tavern-chat

An [OpenClaw](https://github.com/nicepkg/openclaw) plugin for managing character cards, worldbooks, and regex rules through chat commands.

[OpenClaw](https://github.com/nicepkg/openclaw) 插件，通过聊天命令管理角色卡、世界书和正则规则。

---

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

```
~/.openclaw/
├── characters/          # Character card files (.png, .json)
├── worldbooks/          # Worldbook files (.json)
└── regex-rules.json     # Regex rules
```

安装后无需额外配置，插件开箱即用。角色卡、世界书和正则规则存储在 OpenClaw 状态目录下。

---

## English

Manage character cards, worldbooks, and regex rules through chat commands. Works across all OpenClaw channels (Discord, Feishu, Telegram, QQ, etc.).

### Features

- Character Cards — Import `.png` / `.json` character cards. Auto-injects persona, system_prompt, example dialogue, etc.
- Worldbooks — Keyword-based lore injection with constant entries, sticky turns, and embedded character_book support.
- Regex Rules — Apply regex replacements to AI output (e.g., strip tags, reformat text).
- Placeholder Replacement — Auto-replaces `{{char}}`, `{{user}}`, `{{<user>}}` and other common card macros.
- Attachment Auto-Import — Send a PNG to auto-detect character cards; send a JSON to auto-detect worldbooks or regex rules.

### Chat Commands

#### Character Cards

| Command | Description |
|---------|-------------|
| `/character list` | List all character cards |
| `/character set <filename\|name>` | Switch character card |
| `/character show` | Show current character card |
| `/character clear` | Clear current character card |

#### Worldbooks

| Command | Description |
|---------|-------------|
| `/worldbook list` | List all worldbooks |
| `/worldbook set <filename>` | Switch worldbook |
| `/worldbook show` | Show current worldbook |
| `/worldbook clear` | Clear current worldbook |

#### Regex Rules

| Command | Description |
|---------|-------------|
| `/regex list` | List all rules |
| `/regex add <pattern> => <replacement>` | Add a rule |
| `/regex remove <index\|name>` | Remove a rule |
| `/regex enable <index\|name>` | Enable a rule |
| `/regex disable <index\|name>` | Disable a rule |
| `/regex clear` | Remove all rules |

### Attachment Import

Send files directly in chat for auto-import:

- PNG — Detects embedded character data (tEXt/iTXt `chara` chunk) and imports to `characters/`.
- JSON — Auto-detects worldbook or regex rules and imports accordingly. Worldbooks are auto-activated for the current session.

---

## 中文

通过聊天命令管理角色卡、世界书和正则规则。支持所有 OpenClaw 渠道（Discord、飞书、Telegram、QQ 等）。

### 功能

- 角色卡 — 导入 `.png` / `.json` 角色卡，切换后自动注入人设、system_prompt、示例对话等
- 世界书 — 基于关键词匹配的 lore 注入，支持 constant 条目、sticky 机制、嵌入式 character_book
- 正则规则 — 对 AI 输出进行正则替换（如过滤特定标签、格式化文本）
- 占位符替换 — 自动替换 `{{char}}`、`{{user}}`、`{{<user>}}` 等常见占位符
- 附件自动导入 — 发送 PNG 文件自动识别角色卡，发送 JSON 文件自动识别世界书/正则规则

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

- PNG 文件 — 检测是否包含角色卡数据（tEXt/iTXt `chara` chunk），有则导入到 `characters/` 目录
- JSON 文件 — 自动判断是世界书还是正则规则文件并导入，世界书会自动切换到当前会话

---

## License

MIT

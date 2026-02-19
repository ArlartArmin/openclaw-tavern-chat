# openclaw-tavern-chat

[English](./README.md) | [中文](./README.zh.md)

OpenClaw 插件，通过聊天命令管理角色卡、世界书和正则规则。

---

## 安装

```bash
openclaw plugins install openclaw-tavern-chat
```

## 更新

```bash
openclaw plugins update openclaw-tavern-chat
```

## 配置

安装后无需额外配置，插件开箱即用。

角色卡、世界书和正则规则存储在 OpenClaw 状态目录下：

```text
~/.openclaw/
├── characters/          # 角色卡文件 (.png, .json)
├── worldbooks/          # 世界书文件 (.json)
└── regex-rules.json     # 正则规则
```

## 功能

- 角色卡：导入 `.png` / `.json` 角色卡，切换后自动注入人设、system_prompt、示例对话等。
- 世界书：基于关键词匹配的 lore 注入，支持 constant 条目、sticky 机制、嵌入式 character_book。
- 正则规则：对 AI 输出进行正则替换（如过滤特定标签、格式化文本）。
- 占位符替换：自动替换 `{{char}}`、`{{user}}`、`{{<user>}}` 等常见占位符。
- 附件自动导入：发送 PNG 文件自动识别角色卡，发送 JSON 文件自动识别世界书或正则规则。

## 聊天命令

### 角色卡

| 命令 | 说明 |
|------|------|
| `切换角色卡 <名称>` | 切换到指定角色卡 |
| `角色卡列表` / `查看角色卡` / `列出角色卡` | 列出所有角色卡 |
| `清空角色卡` / `取消角色卡` | 取消当前角色卡 |
| `/character list` | 列出所有角色卡 |
| `/character set <filename\|name>` | 切换角色卡 |
| `/character show` | 查看当前角色卡 |
| `/character clear` | 清空角色卡 |

### 世界书

| 命令 | 说明 |
|------|------|
| `切换世界书 <名称>` | 切换到指定世界书 |
| `世界书列表` / `查看世界书` | 列出所有世界书 |
| `清空世界书` / `取消世界书` | 取消当前世界书 |
| `/worldbook list` | 列出所有世界书 |
| `/worldbook set <filename>` | 切换世界书 |
| `/worldbook show` | 查看当前世界书 |
| `/worldbook clear` | 清空世界书 |

### 正则规则

| 命令 | 说明 |
|------|------|
| `/regex list` | 列出所有规则 |
| `/regex add <pattern> => <replacement>` | 添加规则 |
| `/regex remove <index\|name>` | 删除规则 |
| `/regex enable <index\|name>` | 启用规则 |
| `/regex disable <index\|name>` | 禁用规则 |
| `/regex clear` | 清空所有规则 |

## 附件导入

直接在聊天中发送文件即可自动导入：

- PNG 文件：检测是否包含角色卡数据（tEXt/iTXt `chara` chunk），有则导入到 `characters/` 目录。
- JSON 文件：自动判断是世界书还是正则规则文件并导入，世界书会自动切换到当前会话。

## 许可证

MIT


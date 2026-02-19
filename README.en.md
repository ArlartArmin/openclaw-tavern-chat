# openclaw-tavern-chat

[English](./README.md) | [中文](./README.zh.md)

An OpenClaw plugin for managing character cards, worldbooks, and regex rules through chat commands.

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

## License

MIT


# ReDraft — SillyTavern Message Refinement Extension

Refines AI-generated messages by sending them (with configurable quality rules) to an LLM for improvement, then writes the refined version back into chat.

## Install

Paste this URL into SillyTavern's **Extensions > Install Extension** dialog:

```
https://github.com/MeowCatboyMeow/ReDraft
```

Works immediately using your current ST connection. No extra setup needed.

### Separate LLM (optional)

To use a **different API/model only for refinement** (e.g. a faster or cheaper model while your main chat uses another):

1. **One-time:** Install the ReDraft server plugin — see **[INSTALL_PLUGIN.md](INSTALL_PLUGIN.md)** for exact commands and troubleshooting. (That doc also explains [when you need to reinstall](INSTALL_PLUGIN.md#when-to-reinstall-the-server-plugin) after updates.)
2. Restart SillyTavern.
3. In ReDraft settings → **Connection** → choose **Separate LLM (server plugin)** → enter API URL, Key, and Model → **Save Connection** → **Test Connection**.

Credentials are stored on the SillyTavern server (not in the browser).

**Multi-user:** Extension settings are per user. The server plugin supports per-user Separate LLM credentials when SillyTavern passes user context to plugins — see [INSTALL_PLUGIN.md](INSTALL_PLUGIN.md#multi-user-setups).

## Features

- **Zero config (default)**: Uses your existing SillyTavern API connection — nothing extra to install
- **Separate LLM (optional)**: One-time server plugin install lets you use a different model for refinement; see [INSTALL_PLUGIN.md](INSTALL_PLUGIN.md)
- **Four triggers**: `/redraft` slash command, per-message button, floating popout, auto-refine
- **8 built-in rules**: Grammar, echo removal, repetition, character voice, prose cleanup, formatting, crafted endings, lore consistency
- **Custom rules**: Add your own refinement rules with drag-to-reorder and import/export
- **Undo**: One-click restore of original message
- **Diff view**: Visual word-level diff with changelog showing which rules triggered each change
- **Point of view**: Auto-detect or manually set PoV to prevent perspective shifts
- **Native UI**: Matches SillyTavern's design — no custom colors, no emoji

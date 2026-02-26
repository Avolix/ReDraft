# ReDraft Changelog

All notable user-facing changes to ReDraft are documented here.

---

## 2.3.0

**Configurable Timeout & Stop Drafting** — better support for thinking models and slow APIs.

- **Configurable request timeout** in Advanced settings — choose 60s, 90s, 120s, 180s, or 300s depending on your model. Default is 120s, up from the previous hard-coded 60s.
- **Stop drafting** — click the message button or the floating popout trigger while a refinement is in progress to cancel it immediately.
- Timeout error messages now suggest adjusting the timeout setting instead of just retrying.
- (Server plugin update required)

---

## 2.2.2

### Fixes

- Fixed auto-refine triggering on the card's greeting message when starting a new chat — greetings are now skipped since no user message has been sent yet.

---

## 2.2.1

### Fixes

- Fixed enhanced user messages not appearing in the chat — the message bubble now updates to show the enhanced text instead of staying blank.
- Fixed "already has an original stored, skipping" on brand new messages — the pre-send interceptor now correctly identifies each message by its timestamp rather than just its position, so stale metadata from a previous message at the same index no longer blocks enhancement.
- Fixed the pre-send interceptor failing to find the user message when SillyTavern passes cloned objects — message lookup now uses `send_date` matching instead of object reference comparison.

---

## 2.2.0

**User Message Enhancement** — ReDraft can now enhance your messages before or after they're sent.

- **New "Enhance (User Messages)" section** in settings with its own set of built-in rules: grammar, persona voice, prose improvement, formatting, scene continuity, and expand brevity.
- **Pre-send mode** — your message is automatically enhanced *before* the AI sees it. Adds a few seconds of latency but the AI always receives your polished text.
- **Post-send mode** — enhances your message after it's been sent (existing behavior, still the default).
- **Separate custom rules** for user messages — import, export, and drag-reorder independently from AI refine rules.
- **Custom system prompt** for user enhancement, separate from the AI refine system prompt.
- Undo and diff viewing work in both modes.

---

## 2.1.0

**User Message Basics** — first pass at enhancing user messages.

- Added the ability to enhance user-authored messages (grammar, persona matching).
- Auto-enhance option for user messages after sending.

---

## 2.0.0

**Plugin Mode & Server Plugin** — use a separate, cheaper LLM for refinement.

- **Server plugin** lets you configure an external API (e.g. GPT-4o-mini) for refinement instead of using your main chat model.
- Per-user credential support for multi-user SillyTavern instances.
- Test Connection button and clear status indicators.
- Auto-update mechanism — when ReDraft updates in SillyTavern, the server plugin updates too.
- Retry with exponential backoff for API requests.
- Model selector dropdown fetched from your configured API.
- Extension and server plugin versions displayed in settings.

---

## 1.x

**Foundation** — core refinement features.

- One-click AI message refinement with configurable rules.
- Built-in rules for common prose issues (repetition, purple prose, pacing, etc.).
- Custom rules with import/export and drag-reorder.
- Point of View detection and enforcement.
- Diff viewer showing what changed, with auto-show option.
- LLM-generated changelogs explaining each refinement.
- Protected block handling — code fences, HTML tags, `<details>`, `<timeline>`, bracket-delimited blocks, and optionally `<font>` tags are preserved through refinement.
- Configurable character context and previous-response tail length.
- Popout panel for reviewing refinements.
- Slash commands: `/redraft` and `/enhance`.

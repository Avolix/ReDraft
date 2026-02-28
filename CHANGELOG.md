# ReDraft Changelog

All notable user-facing changes to ReDraft are documented here.

---

## 3.0.0

**Swarm Mode** — multi-agent refinement strategies that produce better results than a single LLM pass. Each strategy orchestrates multiple focused LLM calls instead of one do-everything call.

### Swarm Strategies

- **Pipeline** — multi-pass sequential refinement. Each stage focuses on a narrow rule set (e.g., Grammar & Formatting, then Prose & Voice, then Continuity & Flow) and passes its output to the next. Stages are reorderable and individually toggleable.
- **Council** — multiple agents refine the same message in parallel with different emphases (preserving voice, tightening prose, narrative flow), then a judge agent synthesizes the best result or picks the strongest candidate. Configurable council size (2–4) and judge mode.
- **Review + Refine** — a two-step approach where a reviewer agent produces a structured critique (what to preserve, what to fix, what to leave alone), then a refiner agent applies the critique precisely.

### Swarm Tab (Workbench)
- New **Swarm** tab in the Workbench sidebar for all swarm configuration.
- **Enable/disable toggle** — swarm mode applies to AI messages only; user messages always use single-pass.
- **Strategy picker** with live description.
- **Pipeline config** — drag-reorder stages, toggle stages on/off.
- **Council config** — set council size, judge mode (synthesize or pick best), per-agent model overrides (plugin mode only).
- **Live progress** — during execution, see per-agent status with running/done/queued indicators and a progress bar.

### Per-Agent Model Routing
- In plugin mode, each council member and the judge can use a different model via the model override fields.
- Model override is passed as an optional `model` field in the plugin `/refine` request body (backward-compatible).
- ST mode uses the globally configured model for all agents (noted in the UI).

### Architecture
- New `lib/swarm/` module: `agents.js` (role definitions, system prompts, `callAgent()` wrapper), `strategies.js` (strategy schemas, presets, validation), `executor.js` (orchestration engine with parallel/sequential execution and progress events).
- New `_refineMessageSwarm()` in `index.js` mirrors the `_refineMessageCore()` pattern — save original, strip protected blocks, run swarm, restore blocks, update message, persist metadata.
- `redraftMessage()` and `bulkRedraft()` automatically route through swarm when enabled.

---

## 2.8.0

**ReDraft Workbench** — the floating popout panel is replaced by a full-featured sidebar that slides in from the right edge of the screen.

### Workbench Sidebar
- **Sidebar replaces popout** — one unified UI surface for all ReDraft controls. Slides in/out with a smooth animation; no more floating panel.
- **Quick controls** — the sidebar header absorbs all former popout controls: auto-refine toggle, PoV selector, user auto-enhance, user PoV, enhance mode, and action buttons.
- **Resizable** — drag the left edge to adjust width (280–600px). Width is persisted across sessions.
- **Persistent state** — open/closed state, active tab, and width are saved and restored on page load.
- **ESC to close** — press Escape to close the sidebar (diff popup takes priority if open).
- **`/workbench` slash command** — toggle the sidebar from the chat input.

### Bulk Refine (Refine Tab)
- **Message picker** — scrollable list of all chat messages with checkboxes. Filter by All / AI / User / Unrefined. Quick-select and deselect controls.
- **Per-batch overrides** — collapsible section to override PoV and system prompt for a specific run without changing global settings.
- **Bulk processing** — sequential refinement with progress bar, per-message status updates, configurable delay between messages, and cancel support.
- **Batch summary** — after a run, see how many succeeded/failed with an "Undo All" button to revert the entire batch.

### History Tab
- **Refinement log** — reverse-chronological list of all refinements with timestamps, type badges, and single/batch indicators.
- **Per-entry actions** — view diff or undo individual refinements directly from the history.
- **Batch cards** — batch runs are grouped with an "Undo Batch" button.

### Stats Tab
- **Chat statistics dashboard** — total messages, AI/user breakdown, refined/enhanced counts with percentages, word delta, average/min/max refine time, and undo-available count.

### Internal
- **`_refineMessageCore()`** — extracted core refinement pipeline used by both single and bulk refine. Supports overrides and abort signals.
- **Metadata expansion** — `redraft_history[]` and `redraft_batches{}` in chatMetadata for tracking refinement history and batch runs.
- **Concurrency guards** — `isBulkRefining` flag blocks single-refine, auto-refine, and pre-send interceptor during batch operations.

---

## 2.7.0

**In-Place Enhancement** — enhance your message while it's still in the text box, review and edit before sending.

- **New enhancement mode: In-place** — a third option alongside Post-send and Pre-send. Enhances the text in the textarea without sending it, so you can review, tweak, and send on your terms.
- **Textarea enhance button** — when In-place mode is selected, a sparkle button appears next to the send area. Click it to enhance your draft.
- **Popout support** — the popout panel gains an "Enhance Textarea" button when In-place mode is active.
- Works with all existing enhancement rules, persona voice matching, and PoV settings.

---

## 2.6.0

**Floating Panel Rework** — the popout panel is now draggable, resizable, and has more quick controls.

- **Draggable** — grab the header to move the panel anywhere on screen. Position is remembered across sessions.
- **Resizable** — drag the bottom-left corner grip to resize. Size is remembered across sessions.
- **Snap-to-edge** — when dragged near a screen edge, the panel snaps into place with a small margin.
- **Auto-enhance toggle** — the popout now includes a quick toggle for user message auto-enhancement.
- **User PoV selector** — change the user message Point of View directly from the popout.
- **Enhance mode selector** — switch between Pre-send and Post-send enhancement mode without opening full settings.
- **Visual overhaul** — new sectioned layout with drag handle, resize grip, and improved spacing.

---

## 2.5.0

**Reasoning Context** — ReDraft can now read the generating model's Chain of Thought to extract scene settings.

- **New setting: Include reasoning context** — when enabled, ReDraft reads the collapsed thinking/reasoning content from the message being refined.
- **Tag extraction mode** (default) — pulls structured XML tags (`<society>`, `<power_dynamic>`, `<conviction>`, `<language_output>`) from the reasoning and passes them as scene context to the refinement LLM. Token-efficient.
- **Raw pass-through mode** — passes truncated reasoning text for non-structured CoT. Configurable character limit (500–4000).
- **Fallback option** — in tag extraction mode, automatically falls back to raw pass-through if no structured tags are found.
- New settings UI controls with show/hide behavior when the feature is toggled.

---

## 2.4.1

### Fixes

- Fixed server plugin auto-update never triggering — version comparison now uses semantic versioning instead of unreliable file timestamps.
- Fixed `install.js` failing to run — the installer was ESM while its directory's `package.json` forced CommonJS, causing a syntax error on every install attempt. The installer is now CommonJS.

---

## 2.4.0

**Separate User Message PoV** — user message enhancement now has its own Point of View setting.

- **Decoupled PoV controls** — the global PoV setting in Advanced now only applies to AI message refinement. User message enhancement has its own PoV dropdown in the Enhance section, defaulting to 1st person.
- **User-specific PoV instructions** — the perspective rules sent to the LLM for user messages now use wording appropriate for user-written text (e.g., "the user's character") instead of reusing the AI-narration instructions.

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

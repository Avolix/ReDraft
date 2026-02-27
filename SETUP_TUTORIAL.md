# ReDraft — Setup & Usage Tutorial

A friendly guide to installing ReDraft, understanding what everything does, and getting the most out of it. No technical knowledge required.

---

## What Is ReDraft?

ReDraft is a SillyTavern extension that proofreads AI-generated messages. After the AI writes a response, ReDraft sends it through a second LLM pass with a set of quality rules — things like "remove echo," "fix repetition," "clean up prose" — and writes the improved version back into chat.

Think of it as an editor that reads every response right after it arrives and fixes the common problems LLMs tend to produce.

It can also enhance your own messages before or after you send them — fixing grammar, matching your persona's voice, expanding brief inputs, and more.

---

## Step 1: Install ReDraft

1. In SillyTavern, click the **Extensions** panel (the puzzle piece icon in the top bar).
2. At the top, you'll see **Install Extension** with a text field.
3. Paste this URL into the field:

```
https://github.com/MeowCatboyMeow/ReDraft
```

4. Click **Install** (or press Enter).
5. ReDraft will appear in your extensions list.

That's it — ReDraft is installed and working. It uses your current SillyTavern API connection by default, so there's nothing else to configure unless you want to.

---

## Step 2: Find the Settings

1. Open the **Extensions** panel (puzzle piece icon).
2. Find **ReDraft** in the list.
3. Click the header to expand it.

You'll see several collapsible sections:
- **Connection** — how ReDraft talks to the LLM
- **Rules (AI Refine)** — what to check when refining AI messages
- **Enhance (User Messages)** — settings for improving your own messages
- **Advanced** — point of view, timeouts, reasoning context, and more

---

## How to Use ReDraft

ReDraft gives you four ways to trigger a refinement:

### Auto-Refine
Turn this on and every AI response gets refined automatically as soon as it arrives. Toggle it in:
- The **floating popout** (the small pen icon in the bottom-right corner of your screen), or
- ReDraft settings under the Connection section

### Per-Message Button
Every AI message gets a small ReDraft button in its action bar (the row of icons at the bottom of each message bubble). Click it to refine that specific message.

### Floating Popout
Click the pen icon in the bottom-right corner of SillyTavern. This opens a small panel where you can:
- Refine the last AI message
- Enhance the last user message
- Toggle auto-refine
- Change the point of view
- Open full settings

### Slash Command
Type `/redraft` in the chat input to refine the last AI message. Type `/enhance` to enhance the last user message.

---

## Understanding the Rules

### Built-in Rules (AI Refine)

These are ready to go out of the box. Toggle them on or off in **Rules (AI Refine)**:

| Rule | What it does |
|------|-------------|
| **Fix grammar & spelling** | Catches typos, grammar errors, and awkward phrasing. Preserves intentional dialect and character speech patterns. |
| **Remove echo & restatement** | Removes sentences where the AI restates or paraphrases what you just said instead of advancing the scene. |
| **Reduce repetition** | Catches repeated gestures, sentence structures, and emotional beats within the response (and compared to the previous one). |
| **Maintain character voice** | Ensures each character's dialogue stays distinct and consistent with their personality. |
| **Clean up prose** | Fixes common AI writing problems: somatic cliches ("breath hitching"), purple prose, filter words, telling over showing. |
| **Fix formatting** | Fixes orphaned formatting marks, inconsistent style, and dialogue punctuation errors. |
| **Fix crafted endings** | Removes theatrical "dismount" endings — those crafted landing lines that make every response feel like a chapter conclusion. |
| **Maintain lore consistency** | Flags glaring contradictions with established character and world information. |

### Custom Rules

Custom rules are where things get powerful. You can write your own rules, import rule sets that other people have made, and reorder them by priority.

Custom rules appear below the built-in rules in the **Rules (AI Refine)** section.

---

## How to Import Custom Rules

This is the most common question, so here's the step-by-step:

1. Open the **Extensions** panel (puzzle piece icon) and expand **ReDraft**.
2. Open the **Rules (AI Refine)** section.
3. Scroll down past the built-in rule checkboxes until you see **Custom Rules (ordered by priority)**. Next to that label, there are three small buttons.
4. Click the first button — the **Import** icon (a page with an arrow pointing in). It looks like this: `[file-import icon]`
5. A file picker will open. Select the `.json` file containing the rules you want to import.
6. A confirmation dialog will appear showing the rule set name and how many rules it contains.
   - **If you have no existing custom rules:** it imports them directly.
   - **If you already have custom rules:** click **OK** to replace your existing rules with the imported ones, or click **Cancel** to append the new rules after your existing ones.
7. You'll see a success toast message confirming how many rules were imported.

The imported rules will appear in the Custom Rules list. Each rule has:
- A **checkbox** to enable/disable it
- A **label** (the rule name)
- A **drag handle** to reorder it (higher = checked first)
- An **expand arrow** to view/edit the rule text

### Exporting Your Rules

Click the **Export** button (the page with an arrow pointing out — second button next to "Custom Rules") to download your current custom rules as a JSON file. Useful for sharing or backing up.

### Writing Your Own Rules

Click the **+** button (third button next to "Custom Rules") to add a blank rule. Give it a label and write your instruction in the text area. Rules are plain English instructions telling the LLM what to look for and how to fix it.

---

## User Message Enhancement

ReDraft can also improve your messages — not just the AI's. Open the **Enhance (User Messages)** section to configure it.

1. Check **Enable user message enhancement** to turn it on.
2. Choose a mode:
   - **Post-send** (default) — your message is sent as-is, then enhanced afterward. The AI sees your original text.
   - **Pre-send** — your message is enhanced *before* the AI sees it. Adds a few seconds of latency, but the AI always gets your polished version.
3. Set the **Point of View** for your messages (defaults to 1st person).

### User Enhancement Built-in Rules

| Rule | What it does |
|------|-------------|
| **Fix grammar & spelling** | Catches errors in your writing while respecting your character's voice. |
| **Match persona voice** | Adjusts your writing to match your persona description's speech patterns. |
| **Improve prose** | Smooths out clunky phrasing and adds vividness without changing your meaning. |
| **Fix formatting** | Fixes formatting marks and ensures consistent conventions. |
| **Check scene continuity** | Checks that your actions match the established scene. |
| **Expand brief messages** | If you write a 1-2 sentence message, expands it with sensory detail, body language, and interiority. |

User messages also have their own custom rules section (separate from the AI refine rules) with the same import/export/add buttons.

---

## Advanced Settings

Open the **Advanced** section for these options:

### Point of View (AI Messages)
Controls what perspective ReDraft enforces when refining AI responses. Options:
- **Auto** — no PoV instruction sent (use this if your preset handles PoV)
- **Detect** — ReDraft reads the message and figures out the PoV
- **1st / 1.5th / 2nd / 3rd person** — explicitly enforce a perspective

### Character Context
How much of the character description to include when refining (500, 1000, or 2000 characters). More context helps ReDraft maintain character voice but uses more tokens.

### Previous Response Tail
How many characters of the previous AI response to include (100, 200, or 400). Helps catch cross-message repetition.

### Request Timeout
How long to wait for the refinement LLM to respond (60–300 seconds). If you use a thinking model or a slow API, increase this. Default is 120 seconds.

### Protect Font/Color Tags
If your messages use `<font>` tags for colored text, enable this to prevent ReDraft from stripping them.

### Include Reasoning Context
If your AI model uses extended thinking (Chain of Thought), enabling this lets ReDraft read the model's reasoning and extract useful context from it.

- **Extract tags** (default) — pulls structured XML tags from the thinking content and passes them as scene context. Token-efficient.
- **Raw pass-through** — passes the truncated reasoning text directly. Use this if the model doesn't use structured tags.
- **Fall back to raw** — in tag mode, automatically switches to raw if no tags are found.

### System Prompt Override
Replace ReDraft's default system prompt with your own. Leave blank to use the default (recommended unless you know what you're doing).

---

## Viewing Changes

After ReDraft refines a message, you can see exactly what changed:

- **Diff view** — click the message's ReDraft button to see a word-level diff highlighting additions (green) and removals (red).
- **Changelog** — ReDraft generates a brief explanation of which rules triggered and what was changed.
- **Undo** — one click restores the original message. Available on any refined message.

---

## Optional: Using a Separate LLM

By default, ReDraft uses whatever API SillyTavern is already connected to. If you want to use a different model specifically for refinement — for example, a faster or cheaper model like `gpt-4o-mini` — you can set up the server plugin.

This is completely optional. ReDraft works perfectly fine with your existing connection.

### Quick Setup

1. Open a terminal.
2. Navigate to your SillyTavern folder.
3. Run the installer:

**Windows:**

```
cd C:\Path\To\Your\SillyTavern
node data\default-user\extensions\third-party\redraft\server-plugin\install.js
```

**Linux / macOS:**

```
cd /path/to/your/SillyTavern
node data/default-user/extensions/third-party/redraft/server-plugin/install.js
```

4. Restart SillyTavern.
5. In ReDraft settings, under **Connection**, choose **Separate LLM (server plugin)**.
6. Enter your **API URL** (e.g. `https://api.openai.com/v1`), **API Key**, and **Model**.
7. Click **Save Key**, then **Test** to confirm it works.
8. Click **Models** to load a dropdown list of available models from your API.

For detailed instructions (Docker, reverse proxy, multi-user setups, troubleshooting), see [INSTALL_PLUGIN.md](INSTALL_PLUGIN.md).

---

## Stopping a Refinement

If a refinement is taking too long or you changed your mind, click the ReDraft message button (or the floating popout trigger) while refinement is in progress to cancel it immediately.

---

## Troubleshooting

**"Nothing happens when I click the ReDraft button."**
Make sure at least one rule is enabled (built-in or custom). ReDraft won't run if there are no active rules.

**"The import button doesn't open a file picker."**
Try clicking it again — sometimes the file picker opens behind the SillyTavern window. Make sure you're clicking the import icon (page with arrow pointing in), not the export icon (page with arrow pointing out).

**"Import says 'Invalid file: must contain a non-empty rules array.'"**
The file you selected isn't a ReDraft rules file. Rules files are JSON with a specific format (a `rules` array). Make sure you're not importing a preset JSON, lorebook JSON, or some other file by mistake.

**"Refinement keeps timing out."**
Go to **Advanced** and increase the **Request timeout**. Thinking models and slower APIs may need 180 or 300 seconds.

**"ReDraft says 'already has an original stored, skipping.'"**
This can happen with message states from before a recent update. Try sending a new message — it should work on fresh messages.

**"My responses are really slow now."**
ReDraft adds a second LLM call after each AI response. This roughly doubles response time when auto-refine is on. To speed things up:
- Use the **Separate LLM** option with a fast, cheap model for refinement.
- Turn off auto-refine and use ReDraft manually (message button or `/redraft` command) only when you want to.

**"I see a 502 Bad Gateway error."**
If you're using the Separate LLM through a reverse proxy, the proxy is probably timing out before the refinement finishes. Increase your proxy's read/send timeout to at least 60 seconds for `/api/` routes. See [INSTALL_PLUGIN.md](INSTALL_PLUGIN.md#reverse-proxy-nginx-caddy-etc) for details.

**"How do I update ReDraft?"**
Update through SillyTavern: **Extensions** panel → find ReDraft → click **Update**. If you're using the Separate LLM server plugin, it auto-updates on the next SillyTavern restart (after the first manual install).

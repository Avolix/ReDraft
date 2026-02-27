# Simulacra + ReDraft — Setup Tutorial

Everything you need to go from a fresh SillyTavern install to a working Simulacra setup. No coding required.

---

## What You're Installing

**Simulacra** is a completion preset — a big JSON file that tells the AI *how* to write. It handles narrative style, point of view, pacing, romance difficulty, NSFW behavior, Chain of Thought reasoning, and a lot more. You load it once and it runs in the background.

**ReDraft** is a SillyTavern extension that proofreads every AI response after it's generated. It catches repetition, echo, slop, and other common LLM failures, then fixes them automatically. Think of it as a second pass that cleans up what the AI wrote.

**Simulacra ReDraft Rules** are a set of custom rules specifically built for Simulacra. They teach ReDraft what to look for in Simulacra's output (e.g., environmental padding, interiority spirals, NSFW stalling). You import them into ReDraft as a JSON file.

**NSFW Tags Lorebook** is an optional world info book that gives the AI detailed instructions for specific NSFW dynamics and acts. It activates automatically based on keywords in your messages — you don't need to manage it.

---

## Prerequisites

- **SillyTavern** installed and running (any recent version)
- **An AI API** connected and working (OpenAI, Claude, OpenRouter, a local model, etc.)
- A model that supports **extended thinking** is strongly recommended (Simulacra is built around Chain of Thought reasoning)
- A model with a **large context window** (Simulacra is configured for up to 2M tokens)

If you can already chat with a character in SillyTavern, you're good to go.

---

## Step 1: Download the Files

Go to the [Simulacra GitHub releases page](https://github.com/MeowCatboyMeow/Simulacra/releases) or download directly from the repo. You need:

| File | What it is | Required? |
|------|-----------|-----------|
| `Simulacra_v10.4.json` | The preset | Yes |
| `Special Sections/Simulacra ReDraft Rules V4.json` | Custom rules for ReDraft | Yes (if using ReDraft) |
| `Special Sections/Simulacra NSFW Tags V3.json` | NSFW lorebook | Optional |

Save them somewhere you can find them (Desktop, Downloads, wherever).

---

## Step 2: Import the Simulacra Preset

1. In SillyTavern, look at the top bar and click the **AI Response Configuration** icon (looks like sliders/bars).
2. At the top of the panel that opens, you'll see a dropdown for selecting presets, and next to it a row of small buttons.
3. Click the **Import** button (the upload icon — arrow pointing up into a tray).
4. Navigate to where you saved `Simulacra_v10.4.json` and select it.
5. It should now appear in your preset dropdown as **Simulacra_v10.4**. Select it if it isn't already selected.

That's it for the preset. Simulacra is now active.

### Quick sanity check

Open the preset and scroll through the prompt list. You should see sections like "Primers (Loom)," "State," "PoVs," "Length," "Relationship Difficulty," and many more. If you see all of that, the import worked.

---

## Step 3: Import the NSFW Tags Lorebook (Optional)

Skip this step if you don't want NSFW content or prefer to handle it yourself.

1. In SillyTavern, open the **World Info** panel (the globe icon in the top bar).
2. Click **Import** (the upload icon).
3. Select `Simulacra NSFW Tags V3.json`.
4. The lorebook will appear in your world info list. Make sure it's **enabled** (toggled on).

The lorebook is keyword-activated. When your chat messages contain trigger words (like specific kinks, dynamics, or acts), the matching entries automatically inject genre conventions into the AI's context. You don't need to edit or manage it — just leave it on.

**Tip:** If you want to see what's in the lorebook, open it and browse the entries. Each one describes camera angles, pacing, key beats, and what to avoid for that particular dynamic or act.

---

## Step 4: Install the ReDraft Extension

1. In SillyTavern, click the **Extensions** panel (the puzzle piece icon in the top bar).
2. At the top, you'll see **Install Extension** with a text field.
3. Paste this URL into the field:

```
https://github.com/MeowCatboyMeow/ReDraft
```

4. Click **Install** (or press Enter).
5. SillyTavern will download and install ReDraft. You should see it appear in your extensions list.

ReDraft works immediately using your current SillyTavern API connection — no extra setup needed. If you want to use a separate (cheaper/faster) model just for refinement, see the "Optional: Separate LLM" section at the end.

---

## Step 5: Import the Simulacra ReDraft Rules

This is the step where you load Simulacra's custom rules into ReDraft. It's a JSON import — here's exactly how:

1. In SillyTavern, open the **Extensions** panel (puzzle piece icon).
2. Find **ReDraft** in the list and expand it to open its settings.
3. Scroll down until you see the **Custom Rules** section. It has a header that says "Custom Rules (ordered by priority)" with some small buttons next to it.
4. Click the **Import** button (the file-import icon — a page with an arrow). It's the first of the small buttons next to the "Custom Rules" label.
5. A file picker will open. Navigate to where you saved `Simulacra ReDraft Rules V4.json` and select it.
6. A confirmation dialog will appear saying something like *'Import "Simulacra ReDraft Rules" (17 rules)?'*
   - If you have no existing custom rules: it will just import them.
   - If you already have custom rules: click **OK** to replace them, or **Cancel** to append the Simulacra rules after your existing ones.
7. You should see a success toast message: *"Imported 17 rules from Simulacra ReDraft Rules."*

You'll now see 17 rules listed in the Custom Rules section. Some are enabled by default and some are disabled — that's intentional. The enabled ones cover the most common issues; the disabled ones are situational (NSFW-specific, anthro characters, etc.) and you can toggle them on as needed.

### Disable Overlapping Built-in Rules

The Simulacra custom rules replace some of ReDraft's built-in rules. To avoid double-processing:

1. Scroll up in ReDraft's settings to the **Built-in Rules** section (above Custom Rules).
2. **Disable** these three built-in rules:
   - **Echo** (the Simulacra "Echo Ban" custom rule replaces this)
   - **Prose** (the Simulacra "Anti-Slop" custom rule replaces this)
   - **Ending** (the Simulacra "Response Ending Enforcement" custom rule replaces this)
3. **Keep the built-in PoV rule enabled** — it covers different things than the Simulacra PoV rule, and they work well together.

### Enable Reasoning Context (Recommended)

If your model supports extended thinking (most models Simulacra is designed for do), turn this on so ReDraft can read the AI's Chain of Thought:

1. In ReDraft settings, look for **Include reasoning context** (in the Advanced section).
2. Toggle it **on**.
3. Leave it on **Tag extraction** mode (the default) — this pulls Simulacra's structured tags from the AI's thinking and passes them to ReDraft for smarter rule enforcement.

This helps rules like Society Consistency, NSFW Scene Integrity, Conviction Enforcement, and NSFW Prose Quality work much better, because they can see the AI's scene analysis instead of guessing from the text alone.

---

## Step 6: You're Done — Start Chatting

Load any character card and send a message. Simulacra handles the rest:

- The preset tells the AI how to think and write.
- The lorebook (if enabled) adds NSFW conventions when relevant keywords appear.
- ReDraft automatically proofreads and fixes the AI's response after it arrives.

You'll see a small ReDraft indicator when refinement is happening. After it finishes, you can click the message to see a diff of what changed, and undo if you don't like the changes.

---

## Configuring Simulacra's Settings

Simulacra has a bunch of toggleable options organized as radio groups (pick one per group). You configure these in the preset's prompt list. Here's what you can tweak:

| Setting | What it controls | Default |
|---------|-----------------|---------|
| **Point of View** | Narrative perspective (1st, 1.5th hybrid, 2nd, 3rd limited, 3rd omni) | Hybrid 1.5th Person |
| **Length** | Response length behavior, plus optional length modifiers (+150, +300) | Adaptive Beat-Responsive |
| **Relationship Difficulty** | How easily romance develops (Don Juan → Slow-Burn → NTR) | In-Lore |
| **Sex Difficulty** | NSFW threshold (Effortless → Fade to Black) | In-Lore |
| **Power Dynamic** | Default dominance dynamics in intimate scenes | In-Lore |
| **Society** | World-level social dynamics (Patriarchal / Egalitarian / Matriarchal) | In-Lore |
| **Character Conviction** | How firmly characters hold their opinions | In-Character |
| **Pacing / Difficulty / Canon / Language / Agency** | Various other narrative controls | Check the preset |

"In-Lore" means "follow whatever the character card and world info say" — it's the neutral default that doesn't override anything.

To change a setting: open the preset, find the section (they're labeled with `===` headers like `===PoVs===`), and enable the option you want. **Only enable one option per group** — they're radio buttons, not checkboxes.

---

## Optional: Using a Separate LLM for ReDraft

By default, ReDraft uses whatever API connection SillyTavern is already using. If you want to use a different (usually cheaper or faster) model specifically for refinement — for example, `gpt-4o-mini` while your main chat uses Claude — you can set that up with a one-time server plugin install.

This is completely optional. ReDraft works fine with your existing connection.

1. Open a terminal (PowerShell, CMD, or your OS terminal).
2. Navigate to your SillyTavern folder:

```
cd C:\Path\To\Your\SillyTavern
```

3. Run the installer:

```
node data\default-user\extensions\third-party\redraft\server-plugin\install.js
```

4. Restart SillyTavern.
5. In ReDraft settings, under **Connection**, choose **Separate LLM (server plugin)**.
6. Enter your API URL, API Key, and Model name.
7. Click **Save Connection**, then **Test Connection** to confirm it works.

For more details and troubleshooting (Docker, reverse proxy, multi-user setups), see the full [INSTALL_PLUGIN.md](https://github.com/MeowCatboyMeow/ReDraft/blob/main/INSTALL_PLUGIN.md) in the ReDraft repo.

---

## Troubleshooting

**"I imported the preset but nothing changed."**
Make sure the preset is actually selected in the dropdown (not just imported). Click it in the preset list to activate it.

**"I don't see any Custom Rules section in ReDraft."**
Scroll down further in ReDraft's settings panel — it's below the built-in rules and the system prompt sections.

**"The import button doesn't do anything."**
Try clicking it again — sometimes the file picker opens behind the SillyTavern window. Also make sure you're clicking the import icon next to "Custom Rules," not the export icon (which looks similar).

**"I imported the rules but the file picker says 'invalid file.'"**
Make sure you're importing the `Simulacra ReDraft Rules V4.json` file, not the preset JSON or the lorebook JSON. They're different files with different formats.

**"ReDraft says 'already has an original stored, skipping.'"**
This is a known quirk with certain message states. Try sending a new message — it should work on fresh messages.

**"My responses are really slow."**
If ReDraft is enabled, it adds a second LLM call after each response (the refinement pass). This roughly doubles response time. You can use the "Separate LLM" option with a fast model to speed this up, or disable auto-refine and only use ReDraft manually (via the `/redraft` command or the message button) when you want to.

**"I want to update Simulacra to a newer version."**
Just re-import the new preset JSON (Step 2) — it will replace the old one. For new ReDraft rules, re-import those too (Step 5) and click OK to replace when prompted. Check the changelog to see if the lorebook also needs updating.

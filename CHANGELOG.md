# Changelog

Changelogs here are written for **end users**. We use this file to record what changed in each release.

---

## ReDraft 2.1 — Enhance your own messages

ReDraft can now enhance **your** messages, not just the AI's. Fix grammar, match your character's voice using your persona page, and keep lore consistent — all with one click.

---

### Highlights

**User message enhancement is ready to use**

- **Enhance button on your messages** — A ✨ wand button appears on every user message. Click it to enhance your writing: fix grammar, match your persona's voice, and check lore consistency.
- **Persona-aware** — ReDraft reads your persona page and uses it to match your character's speech patterns, vocabulary, and personality. The more detailed your persona, the better the voice matching.
- **Auto-enhance** — Optionally auto-enhance your messages right after you send them (off by default). Toggle it in ReDraft settings under "Auto-enhance after sending."
- **Same rules, different lens** — The same built-in rules (grammar, voice, formatting, lore, etc.) apply. The system prompt is tailored for user-written content — it preserves your intent and treats every line as intentional role-playing.
- **Separate system prompt** — You can override the system prompt for user messages independently from the AI refinement prompt (Advanced → System Prompt Override for user messages).
- **`/enhance` slash command** — Type `/enhance` to enhance your last user message, or `/enhance [index]` for a specific message.
- **Popout button** — The floating popout panel now has an "Enhance Last User Message" button alongside the existing "Refine Last AI Message."

---

### New features

- **Enhance user messages** — Click the ✨ button on any of your messages to enhance it. Fixes grammar, matches your persona voice, checks lore. Uses the same connection (ST or plugin) and rules as AI refinement.
- **Auto-enhance after sending** — New toggle: "Auto-enhance after sending." When enabled, your messages are automatically enhanced right after you send them.
- **`/enhance` slash command** — Enhance your last user message (or a specific one by index). Works like `/redraft` but targets user messages.
- **Persona integration** — Your persona description is sent as context so the LLM can match your character's voice and personality.
- **User system prompt override** — Customize the system prompt used for user message enhancement separately from AI refinement (in Advanced settings).

---

### How it works

1. **Turn it on** — "Enhance user messages" is on by default. You'll see a ✨ wand icon on your messages.
2. **Fill out your persona** — The more detail on your persona page, the better ReDraft matches your character's voice.
3. **Click enhance** — Click the ✨ on any of your messages, or use the popout's "Enhance Last User Message" button, or type `/enhance`.
4. **Review** — Diff and undo work exactly like AI refinement. You can always restore your original.

---

## ReDraft 2.0 — Separate LLM & connection overhaul

This release is all about **Separate LLM**: you can use a different API and model *only* for refinement (e.g. a fast, cheap model for polish while your main chat uses something bigger). Your API key is stored on the server, and the connection flow works properly with reverse proxies and Docker.

---

### Highlights

**Separate LLM is ready to use**

- **Server plugin** — ReDraft can store your API URL, key, and model on the SillyTavern server. Your key never lives in the browser.
- **One-time setup** — From the ReDraft folder, run `node server-plugin/install.js`, restart SillyTavern, then in ReDraft → Connection choose “Separate LLM (server plugin)”, enter your API details, click Save, then Test. Full steps are in [INSTALL_PLUGIN.md](INSTALL_PLUGIN.md).
- **Works with reverse proxies and Docker** — If you use SillyTavern at a custom URL or subpath (e.g. `yoursite.com/tavern`), the plugin connection now works without extra config. The install guide includes examples for Caddy and nginx.
- **Save/Test work on secured SillyTavern instances** — If you access ST through a tunnel or proxy (e.g. Cloudflare), Save Connection and Test Connection no longer get blocked; the extension talks to the server in the way SillyTavern expects.
- **Change model without re-entering your key** — After you’ve saved your connection once, you can change the model (or API URL) and click Save again. Your existing API key is kept; you don’t have to paste it every time.
- **Models button** — A new **Models** button fetches the list of models from your API and fills the Model dropdown so you can pick from what your provider actually offers.

---

### New features

- **Separate LLM (server plugin)** — Use a different API and model only for refinement. Set it up in ReDraft → Connection; credentials are stored on the server in the plugin’s config file.
- **Fetch models** — The **Models** button loads available models from your API and populates the Model field so you can choose from a list instead of typing the name.
- **Clearer connection errors** — When something goes wrong (e.g. wrong URL or plugin not installed), you get a clear message and the exact URL that was tried, so you can fix it or share it when asking for help.

---

### Improvements

- **Connection section layout** — Shorter button labels (Save, Test, Models), better spacing, and connection status on its own line so the row isn’t cramped.
- **Reverse proxy / subpath** — If SillyTavern is served at a subpath (e.g. `yoursite.com/tavern`), plugin requests now use the right path automatically.
- **Install and docs** — The installer works when run from the ReDraft folder (including in Docker). [INSTALL_PLUGIN.md](INSTALL_PLUGIN.md) now covers Docker, custom install paths, Caddy/nginx reverse proxy, and when you need to reinstall the server plugin.

---

### Fixes

- **“Cannot find module install.js”** — You now get clear instructions: run the installer from the folder that actually contains the ReDraft extension (and use `ST_ROOT` if your SillyTavern root is elsewhere). See the install guide.
- **“require is not defined” when running the installer** — The install script was updated so it runs correctly under SillyTavern’s Node setup.
- **Plugin not loading (404 on connection)** — The server plugin is now loaded correctly by SillyTavern. If you had already run the installer and still saw “Not found,” reinstalling and restarting ST should fix it.
- **“Forbidden” (403) when saving or testing connection** — The extension now sends the right security headers so Save and Test work on secured instances (e.g. when using a tunnel or proxy).
- **“Unexpected token '<'” / “is not valid JSON”** — When the server returned a web page instead of API data (e.g. a 404 or login page), you now get a plain-language error and the URL that was called instead of a JSON parse error.

---

### Security (server plugin)

- **Safer API URL** — The plugin only allows normal web API URLs (http/https). It blocks localhost and private network addresses so the plugin can’t be misused to reach internal services.
- **Config file permissions** — The file that stores your API key on the server is now created so only the user running SillyTavern can read it.
- **Max tokens limit** — The max tokens setting is capped at 128,000 so a misclick can’t trigger an unexpectedly huge (and expensive) request.

*To get these security updates, reinstall the server plugin and restart SillyTavern. See the install guide for when reinstall is needed.*

---

### When to reinstall the server plugin

Reinstall (run the installer again, then restart SillyTavern) when the **server plugin** has been updated—for example after updating to this release. The rest of ReDraft (buttons, rules, UI) updates when you reload the SillyTavern page. [INSTALL_PLUGIN.md](INSTALL_PLUGIN.md) has the full “when to reinstall” section.

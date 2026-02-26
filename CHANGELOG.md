# Changelog

Changelogs here are written for **end users**. We use this file to record what changed in each release. *(Internally we treat the release below as ReDraft 2.0.)*

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

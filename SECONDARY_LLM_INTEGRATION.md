# ReDraft: Secondary LLM Without CLI Server Plugin

## Summary

**LumiverseHelper** ([prolix-oc/SillyTavern-LumiverseHelper](https://github.com/prolix-oc/SillyTavern-LumiverseHelper)) shows how to build a SillyTavern extension that **uses React and requires no server plugin** — but it does **not** implement a separate/secondary LLM. It uses SillyTavern’s existing connection (`generateRaw` / `generateQuietPrompt`) for any LLM use. The “no server plugin” part is about **architecture**: React + Webpack bundle, install via Extensions panel only.

To get a **secondary LLM** (e.g. cheaper/faster model for refinement) without asking users to run a CLI installer, we need either a SillyTavern core feature (proxy or second connection) or a way to install the ReDraft server plugin without the command line.

---

## How LumiverseHelper Works (Relevant Parts)

- **Stack:** React + Webpack. Entry `src/index.js` → bundle `dist/index.js`. Dependencies (React, Fuse, etc.) are bundled; no separate server.
- **Install:** Via SillyTavern Extensions panel (Git URL or manual clone). No server plugin, no CLI.
- **Backend access:** Everything goes through `SillyTavern.getContext()`:
  - `getGenerateRaw()` / `getGenerateQuietPrompt()` for LLM calls.
  - `getRequestHeaders()` for authenticated requests to the ST backend.
- **API calls:** When it needs the “backend,” it uses `fetch('/api/...', { headers: getRequestHeaders() })` — i.e. **same origin** (SillyTavern server). So no CORS; no external API is called directly from the browser.
- **ST context module:** `stContext.js` centralizes all ST API access (macros, slash commands, generateRaw, chat, etc.) so the rest of the app doesn’t depend on ST internals.

So LumiverseHelper is a good reference for:

- Building a **React-based extension** with no server plugin.
- **Not** for “secondary LLM without a plugin” — it only uses the single, current ST connection.

---

## Why “Secondary LLM” Usually Needs a Backend

- **Browser → external API:** Calling OpenAI/OpenRouter/etc. from the extension with `fetch()` would send the request from the **browser**. Most of these APIs **do not allow CORS** from arbitrary origins, so the browser blocks the request. Letting the browser send the API key is also discouraged (ST docs: don’t store secrets in extension settings).
- **So:** A “second” LLM call with its own URL/key must be made from a **backend** (same origin or a proxy). Today that backend is the ReDraft **server plugin** (runs inside SillyTavern’s Node process). The only “CLI” part is installing that plugin (copy files + enable server plugins in config).

---

## Options for Secondary LLM Without CLI Plugin Install

### 1. Rely on SillyTavern (ideal long term)

- **Connection profile override:** If ST’s `generateRaw()` (or equivalent) could accept a “use connection profile X,” then the user could have two profiles (e.g. “Main” and “Refinement”). ReDraft would call `generateRaw(..., { profile: 'Refinement' })`. No ReDraft server plugin. **Requires a SillyTavern core change** (expose profile/connection override to extensions).
- **Built-in “extension proxy” or “refinement” endpoint:** ST could add e.g. `POST /api/extensions/proxy-completion` or “Refinement API” in API Connections that extensions use with a second URL/key. Keys stay on the server. **Requires a SillyTavern core change.**

### 2. Keep ReDraft plugin, improve install UX

- **Enable “Separate LLM” in the UI** (remove “Coming Soon” and `disabled` on the plugin option in ReDraft’s settings). Users who want a secondary LLM run the **one-time** plugin installer (`node server-plugin/install.js` or similar).
- **Improve docs:** Single, clear “Secondary LLM setup” section: install steps, where to put API URL/key/model, and that it’s optional (ST mode still works with one connection).
- **Possible future:** If SillyTavern adds “Install server plugin from UI” (e.g. marketplace or “Install ReDraft plugin” button that runs the same steps as the install script), then “no CLI” would be satisfied from the user’s perspective.

### 3. Direct browser fetch (not recommended)

- Use a “Custom API” mode where the user enters URL + key in the extension and the extension calls the API from the browser. This only works if the API allows CORS from the page origin; most do not. ST docs also say not to store API keys in extension settings. **Not recommended.**

### 4. Third-party CORS proxy / serverless

- User (or ReDraft) deploys a small serverless function that forwards requests and holds the key. Extension calls that proxy (same-origin or a CORS-allowing endpoint). Works without the ReDraft plugin but adds deployment and key-handling complexity. **Possible but heavy for most users.**

---

## Recommended Direction

1. **Short term (ReDraft only)** ✅ **Done**  
   - **Enabled** the “Separate LLM (server plugin)” option in the UI; added connection hint, “Plugin not detected” block with install link, **Test Connection** button, and clear status copy.  
   - **INSTALL_PLUGIN.md** — full install steps, verify, troubleshooting; install script supports `ST_ROOT` and finds ST root from script or cwd.  
   - Refine errors (503, timeout, plugin unavailable) show actionable toasts.  
   - Optionally, **adopt a LumiverseHelper-style setup** (React + Webpack) for the settings/connection UI later; not required for Option 2.

2. **Medium term (SillyTavern)**  
   - **Propose** a “secondary connection” or “extension refinement API” in ST (profile override for `generateRaw` or a dedicated proxy endpoint) so extensions like ReDraft can use a second LLM without any per-extension server plugin.  
   - Or **propose** a way to install server plugins from the UI so “no CLI” is achieved while still using the existing ReDraft plugin.

3. **Clarify in docs**  
   - In SIMULACRA_MAP / POTENTIAL_IMPROVEMENTS, note that LumiverseHelper is the reference for “React extension, no server plugin,” and that **secondary LLM without a plugin** currently requires either the ReDraft server plugin (one-time install) or a future ST feature (second connection / proxy).

---

## References

- [LumiverseHelper](https://github.com/prolix-oc/SillyTavern-LumiverseHelper) — React + Webpack, `stContext.js`, no server plugin.  
- [SillyTavern UI Extensions](https://docs.sillytavern.app/for-contributors/writing-extensions) — “Extensions that have a server plugin requirement to function will not be accepted”; `generateRaw` from `getContext()`; no profile override documented.  
- [Connection Profiles](https://docs.sillytavern.app/usage/core-concepts/connection-profiles) — Multiple profiles exist; extension API for “use profile X” for a single call is the missing piece.  
- POTENTIAL_IMPROVEMENTS.md § “Enable Plugin mode (separate LLM)” — enable UI, document install.  
- SIMULACRA_MAP.md § “ReDraft Architecture” — ST mode vs plugin mode.

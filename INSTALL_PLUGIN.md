# ReDraft Server Plugin — One-Time Install

The **Separate LLM** option lets you use a different API and model for refinement (e.g. a faster or cheaper model like `gpt-4o-mini`) while your main chat uses another model. Credentials are stored **on the SillyTavern server**, not in the browser.

You only need to do this **once** per SillyTavern installation.

---

## Prerequisites

- **Node.js** (same as SillyTavern; you already have it if ST runs).
- SillyTavern installed (local or server).

---

## Step 1: Run the installer

Open a terminal and run the install script **from your SillyTavern root directory**, or from the ReDraft extension folder.

### Option A — From SillyTavern root (recommended)

First `cd` to your SillyTavern folder, then run the installer.

**Linux / macOS:**

```bash
cd /path/to/your/SillyTavern
node data/default-user/extensions/third-party/redraft/server-plugin/install.js
```

- **Current user only:** `data/default-user/extensions/third-party/redraft/...`  
- If your SillyTavern uses a different user folder, replace `default-user` with that folder name.

**Windows (PowerShell or CMD):**

```powershell
cd C:\Path\To\Your\SillyTavern
node data\default-user\extensions\third-party\redraft\server-plugin\install.js
```

- **Current user only:** `data\default-user\extensions\third-party\redraft\server-plugin\install.js`
- **All users (shared install):** `public\scripts\extensions\third-party\redraft\server-plugin\install.js`

### Option B — From the ReDraft extension folder

If you’re already in the ReDraft extension directory, you can run the script there; it will search **upward** for the SillyTavern root (looks for `server.js` and `package.json` with name `sillytavern`).

**Linux / macOS:**

```bash
cd /path/to/your/SillyTavern/data/default-user/extensions/third-party/redraft
node server-plugin/install.js
```

**Windows:**

```powershell
cd C:\Path\To\Your\SillyTavern\data\default-user\extensions\third-party\redraft
node server-plugin\install.js
```

(For “all users” installs, use `public\scripts\extensions\third-party\redraft` instead of `data\default-user\extensions\third-party\redraft`.)

---

## Step 2: Restart SillyTavern

Restart SillyTavern so the plugin loads. You only need to do this once after installing.

---

## Step 3: Configure in ReDraft settings

1. In SillyTavern, open **Extensions** → **ReDraft**.
2. Under **Connection**, choose **Separate LLM (server plugin)**.
3. Enter:
   - **API URL** — e.g. `https://api.openai.com/v1` (no trailing slash).
   - **API Key** — your key for that API.
   - **Model** — e.g. `gpt-4o-mini`, `claude-3-haiku`.
4. Click **Save Connection**.
5. Click **Test Connection** to confirm it shows “Connection OK”.

Credentials are saved on the server (in the plugin’s `config.json`), not in the browser.

---

## Verify

- **Status dot** (next to “Connection” in ReDraft): green = using ST connection (ST mode) or plugin configured (Separate LLM mode).
- **Test Connection**: should say “Connection OK — &lt;model&gt; ready for refinement”.
- Refine a message: it should go to the model you configured for Separate LLM.

---

## When to reinstall the server plugin

You **must** re-run the installer and restart SillyTavern when the **server plugin** code changes (e.g. after updating ReDraft and the changelog or release notes say “server plugin update required”). The running plugin lives in `plugins/redraft/`; the installer copies the latest `index.js` (and `config.json.example`) from the extension into that folder.

You **do not** need to reinstall when only the **extension** (client) changes — e.g. UI, connection logic, or base-path/proxy fixes. Reload the SillyTavern tab to pick those up. You also do not need to reinstall when only the **install script** (`install.js`) changes; that only affects the next run of the installer.

When in doubt, re-running the installer and restarting ST is safe and only takes a moment.

---

## Docker / custom install paths

If you see **"Cannot find module '.../redraft/server-plugin/install.js'"**, the ReDraft extension is not at the default path inside your container (e.g. `data/default-user/extensions/third-party/redraft/` may not exist or may be elsewhere).

**Do this instead:**

1. Run the installer **from the folder that actually contains the ReDraft extension** (where `server-plugin/install.js` exists), e.g. if ReDraft is at `/home/node/app/ReDraft`:
   ```bash
   cd /home/node/app/ReDraft
   node server-plugin/install.js
   ```
2. The script will walk up to find the SillyTavern root (looks for `server.js` + `package.json`). If your app root is different, set it explicitly:
   ```bash
   export ST_ROOT=/home/node/app
   node server-plugin/install.js
   ```
3. If the ReDraft extension is only in your project and not inside ST's `data/.../extensions/`, you still only need to run the script from the folder that contains `server-plugin/`; the installer copies the plugin into `plugins/redraft` at the ST root.

**Docker:** The plugin must run in the **same** container that serves the SillyTavern UI. Run the installer inside that container (e.g. `docker exec -it <container> sh` then `node server-plugin/install.js` from the ReDraft folder). Ensure `plugins/redraft/` exists in the container and that `config.yaml` has `enableServerPlugins: true`, then restart the container.

---

## Troubleshooting

| Issue | What to do |
|-------|------------|
| **"Server returned a web page instead of JSON" (including on localhost)** | The plugin is not installed or not loaded. Run the installer from the ReDraft extension folder (see [Step 1](#step-1-run-the-installer)), ensure `plugins/redraft/index.js` exists in your SillyTavern folder, set `enableServerPlugins: true` in `config.yaml`, then **restart SillyTavern**. Open the URL from the error in a new tab to confirm you get a 404 or HTML page. |
| **"Cannot find module '.../install.js'"** | The extension isn't at that path. Use Option B: `cd` to the folder that contains `server-plugin/` and run `node server-plugin/install.js` (set `ST_ROOT` if needed). See [Docker / custom install paths](#docker--custom-install-paths) above. |
| **"Could not locate SillyTavern root"** | Run the script from the ST root, or from inside the ReDraft extension folder so it can find `server.js` above. Or set `ST_ROOT` to your SillyTavern root. |
| **“Plugin unavailable” / Test fails** | Restart SillyTavern after installing. Ensure server plugins are enabled (installer sets `enableServerPlugins: true` in `config.yaml`). |
| **“Not configured” after save** | Click **Save Connection** again. Check that API URL has no trailing slash and that the key and model are correct. |
| **503 when refining** | Plugin is reachable but credentials aren’t saved. Enter URL, Key, and Model in ReDraft settings and click **Save Connection**, then **Test Connection**. |
| **502 / timeout when refining** | API or model problem (wrong URL, key, or model name). Check the SillyTavern server console for the plugin’s error message. |

---

## Uninstall (optional)

To remove the plugin:

1. Delete the folder `plugins/redraft` inside your SillyTavern directory.
2. Restart SillyTavern.
3. In ReDraft settings, switch back to **Use current ST connection**.

You can re-run the install script anytime to reinstall.

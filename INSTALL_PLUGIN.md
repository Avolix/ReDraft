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

```bash
cd /path/to/your/SillyTavern
node data/default-user/extensions/third-party/redraft/server-plugin/install.js
```

- **Windows (current user):**  
  `node data\default-user\extensions\third-party\redraft\server-plugin\install.js`

- **Windows (all users):**  
  `node public\scripts\extensions\third-party\redraft\server-plugin\install.js`

- If your SillyTavern uses a different user folder, replace `default-user` with that folder name.

### Option B — From the ReDraft extension folder

If you’re already in the ReDraft extension directory:

```bash
cd data/default-user/extensions/third-party/redraft
node server-plugin/install.js
```

The script will search **upward** for the SillyTavern root (looks for `server.js` and `package.json` with name `sillytavern`). So you can run it from inside the extension folder and it will still find ST.

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

## Troubleshooting

| Issue | What to do |
|-------|------------|
| **“Could not locate SillyTavern root”** | Run the script from the ST root, or from inside the ReDraft extension folder so it can find `server.js` above. |
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

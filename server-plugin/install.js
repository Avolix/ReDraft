#!/usr/bin/env node

/**
 * ReDraft Server Plugin Installer
 *
 * Copies the server plugin files to SillyTavern's plugins directory
 * and enables server plugins in config.yaml if needed.
 *
 * Usage:
 *   From SillyTavern root:
 *     node data/default-user/extensions/third-party/redraft/server-plugin/install.js
 *   From ReDraft extension folder (script finds ST root by walking up):
 *     node server-plugin/install.js
 *   With explicit root (optional):
 *     set ST_ROOT=C:\Path\To\SillyTavern  (Windows)
 *     export ST_ROOT=/path/to/SillyTavern (Linux/macOS)
 *     node server-plugin/install.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PLUGIN_NAME = 'redraft';
const scriptDir = __dirname;

// 1. Explicit env 2. Walk up from script 3. Walk up from cwd
const stRoot = process.env.ST_ROOT
    ? path.resolve(process.env.ST_ROOT)
    : findSTRoot(scriptDir) || findSTRoot(process.cwd());

if (!stRoot) {
    console.error('ERROR: Could not locate SillyTavern root directory.');
    console.error('');
    console.error('Run this script either:');
    console.error('  - From your SillyTavern root: node data/default-user/extensions/third-party/redraft/server-plugin/install.js');
    console.error('  - From the ReDraft extension folder: node server-plugin/install.js');
    console.error('  - Or set ST_ROOT to your SillyTavern path and run from anywhere.');
    process.exit(1);
}

const pluginsDir = path.join(stRoot, 'plugins');
const targetDir = path.join(pluginsDir, PLUGIN_NAME);

console.log('');
console.log('ReDraft Server Plugin Installer');
console.log('==============================');
console.log('SillyTavern root: ' + stRoot);
console.log('Target:           ' + targetDir);
console.log('');

// Create plugins directory if it doesn't exist
if (!fs.existsSync(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true });
    console.log(`Created plugins directory: ${pluginsDir}`);
}

// Create target directory
if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
}

// Copy plugin files (everything except install.js itself)
const filesToCopy = ['index.js', 'config.json.example'];
let copied = 0;

for (const file of filesToCopy) {
    const src = path.join(scriptDir, file);
    const dest = path.join(targetDir, file);

    if (!fs.existsSync(src)) {
        console.warn(`  SKIP: ${file} (not found in bundle)`);
        continue;
    }

    fs.copyFileSync(src, dest);
    console.log(`  Copied: ${file}`);
    copied++;
}

// Write a package.json that forces CJS so index.js works even when ST's root has "type": "module"
const pluginPkg = path.join(targetDir, 'package.json');
const pluginPkgContent = JSON.stringify({ type: 'commonjs' }, null, 2) + '\n';
fs.writeFileSync(pluginPkg, pluginPkgContent, 'utf-8');
console.log('  Created: package.json (type: commonjs)');
copied++;

console.log(`\n${copied} file(s) installed to ${targetDir}`);

// Check and update config.yaml
const configPath = path.join(stRoot, 'config.yaml');
const defaultConfigPath = path.join(stRoot, 'default', 'config.yaml');

if (fs.existsSync(configPath)) {
    let config = fs.readFileSync(configPath, 'utf-8');
    if (config.includes('enableServerPlugins: false')) {
        config = config.replace('enableServerPlugins: false', 'enableServerPlugins: true');
        fs.writeFileSync(configPath, config, 'utf-8');
        console.log('\nEnabled server plugins in config.yaml');
    } else if (config.includes('enableServerPlugins: true')) {
        console.log('\nServer plugins already enabled in config.yaml');
    } else {
        console.log('\nWARNING: Could not find enableServerPlugins in config.yaml.');
        console.log('Please manually set "enableServerPlugins: true" in your config.yaml');
    }
} else {
    // No config.yaml yet — copy from default and enable plugins
    if (fs.existsSync(defaultConfigPath)) {
        let config = fs.readFileSync(defaultConfigPath, 'utf-8');
        config = config.replace('enableServerPlugins: false', 'enableServerPlugins: true');
        fs.writeFileSync(configPath, config, 'utf-8');
        console.log('\nCreated config.yaml from defaults with server plugins enabled');
    } else {
        console.log('\nWARNING: No config.yaml found. Please create one and set "enableServerPlugins: true"');
    }
}

console.log('');
console.log('==============================');
console.log('Installation complete.');
console.log('');
console.log('Next steps:');
console.log('  1. Restart SillyTavern so the plugin loads.');
console.log('  2. In SillyTavern: Extensions → ReDraft → Connection.');
console.log('  3. Choose "Separate LLM (server plugin)".');
console.log('  4. Enter API URL, Key, and Model, then click Save Connection.');
console.log('  5. Click Test Connection to verify.');
console.log('');
console.log('See INSTALL_PLUGIN.md in the ReDraft folder for full instructions.');
console.log('');

/**
 * Walk up from the script location to find the ST root
 * (identified by the presence of server.js or package.json with "sillytavern").
 */
function findSTRoot(startDir) {
    let dir = path.resolve(startDir);
    const root = path.parse(dir).root;

    while (dir !== root) {
        const serverJs = path.join(dir, 'server.js');
        const packageJson = path.join(dir, 'package.json');

        if (fs.existsSync(serverJs) && fs.existsSync(packageJson)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf-8'));
                if (pkg.name === 'sillytavern' || pkg.name === 'silly-tavern-server') {
                    return dir;
                }
            } catch { /* ignore parse errors */ }
        }

        dir = path.dirname(dir);
    }

    return null;
}

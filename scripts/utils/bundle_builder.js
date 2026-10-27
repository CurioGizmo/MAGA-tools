/**
 * BundleBuilder - Unified parameterized bundler for Antigravity browser UI modules.
 * Zero external dependencies. Uses Node vm.Script for syntax verification.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/**
 * Strips CommonJS export blocks from modular source files for browser bundling.
 * Handles:
 * - if (typeof module !== 'undefined' && module.exports) { ... }
 * - if (typeof module !== 'undefined') { ... }
 * - if (typeof exports !== 'undefined') { ... }
 * - standalone module.exports = ...;
 */
function stripCommonJsExports(code) {
  let cleaned = code;
  cleaned = cleaned.replace(/if\s*\(\s*typeof\s+module\s*!==\s*['"]undefined['"]\s*&&\s*module\.exports\s*\)\s*\{[\s\S]*?\n\s*\}/g, '');
  cleaned = cleaned.replace(/if\s*\(\s*typeof\s+module\s*!==\s*['"]undefined['"]\s*\)\s*\{[\s\S]*?\n\s*\}/g, '');
  cleaned = cleaned.replace(/if\s*\(\s*typeof\s+exports\s*!==\s*['"]undefined['"]\s*\)\s*\{[\s\S]*?\n\s*\}/g, '');
  cleaned = cleaned.replace(/^module\.exports\s*=[\s\S]*?;$/gm, '');
  return cleaned.trim();
}

/**
 * Builds a single bundled JavaScript file from a list of submodules and optional CSS.
 *
 * @param {Object} options
 * @param {string} options.entryDir - Directory containing source modules
 * @param {string[]} options.modules - Ordered list of module file names
 * @param {string} [options.cssFile] - Optional CSS file name relative to entryDir
 * @param {Function|string} options.iifeWrapper - Wrapper function or template
 * @param {string} options.targetFile - Destination path for the bundle
 * @returns {{ outputFile: string, size: number }}
 */
function buildBundle({ entryDir, modules, cssFile, iifeWrapper, targetFile }) {
  if (!entryDir || !fs.existsSync(entryDir)) {
    throw new Error(`[BundleBuilder] Invalid entryDir: ${entryDir}`);
  }
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new Error('[BundleBuilder] modules must be a non-empty array of file names');
  }
  if (!targetFile) {
    throw new Error('[BundleBuilder] targetFile must be specified');
  }

  // 1. Read CSS if specified
  let cssContent = '';
  if (cssFile) {
    const cssPath = path.isAbsolute(cssFile) ? cssFile : path.join(entryDir, cssFile);
    if (fs.existsSync(cssPath)) {
      cssContent = fs.readFileSync(cssPath, 'utf8').trim();
    }
  }

  // 2. Read and strip submodules in strict order
  let assembledModules = '';
  for (const modName of modules) {
    const modPath = path.isAbsolute(modName) ? modName : path.join(entryDir, modName);
    if (!fs.existsSync(modPath)) {
      throw new Error(`[BundleBuilder] Required module not found: ${modPath}`);
    }
    const rawContent = fs.readFileSync(modPath, 'utf8');
    const cleanContent = stripCommonJsExports(rawContent);
    assembledModules += `\n  // --- Submodule: ${path.basename(modName)} ---\n  ${cleanContent.split('\n').join('\n  ')}\n`;
  }

  // 3. Assemble final content via iifeWrapper
  let bundleContent = '';
  const cssJson = JSON.stringify(cssContent);

  if (typeof iifeWrapper === 'function') {
    if (iifeWrapper.length >= 2) {
      bundleContent = iifeWrapper(assembledModules, cssJson, cssContent);
    } else {
      const payload = {
        modulesCode: assembledModules,
        assembledModules,
        cssContent,
        cssJson,
        toString() { return assembledModules; },
        valueOf() { return assembledModules; }
      };
      bundleContent = iifeWrapper(payload);
    }
  } else if (typeof iifeWrapper === 'string') {
    bundleContent = iifeWrapper
      .replace(/__CSS__/g, cssJson)
      .replace(/__MODULES__/g, assembledModules);
  } else {
    throw new Error('[BundleBuilder] iifeWrapper must be a function or a template string');
  }

  // 4. Validate syntax before writing to disk
  try {
    new vm.Script(bundleContent);
  } catch (syntaxErr) {
    throw new Error(`[BundleBuilder] Syntax error in assembled bundle (${targetFile}): ${syntaxErr.message}`);
  }

  // 5. Ensure target directory exists and write file
  const outDir = path.dirname(targetFile);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  fs.writeFileSync(targetFile, bundleContent, 'utf8');
  return { outputFile: targetFile, size: bundleContent.length };
}

module.exports = {
  buildBundle,
  stripCommonJsExports
};

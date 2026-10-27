/**
 * mime_types.js
 * Single Source of Truth for BYOK supportedMimeTypes maps.
 *
 * Frontend Antigravity gates media sending on `supportedMimeTypes`
 * (bundle fn PKa: a.some(c => !b.get(c.mimeType))), NOT on supportsImages.
 * A BYOK model with supportsImages=true must therefore advertise image
 * mime types in its ClientModelConfig, or chat blocks the send with
 * "Your model does not support this media".
 *
 * Dual export (mirrors patches/byok/presets.js):
 *  - globalThis guard survives bundle_builder's stripCommonJsExports
 *    and exposes the helper inside the concatenated IIFE bundle;
 *  - module.exports works in Node (main process byok_manager.js, tests).
 * Declared as a function (not a const arrow) so it hoists within the
 * shared IIFE scope of byok_manager_ui.js regardless of module order.
 */

/**
 * Builds a supportedMimeTypes map for a BYOK model variant.
 *
 * MUST return a FRESH object literal on every call (never a shared
 * constant): the map lands in multiple configs and Map wrappers;
 * a shared reference invites cross-config mutation/aliasing.
 * Values are strictly boolean `true` (never the string "true") —
 * protojson map<string,bool> rejects non-boolean values.
 *
 * @param {boolean} supportsImages - Vision capability of the model.
 * @returns {Record<string, boolean>} plain-object mime map (Map in the
 *   renderer is built by the frontend mapper via
 *   `new Map(Object.entries(...))`; protojson path requires plain object:
 *   JSON.stringify(new Map()) === '{}' would silently drop all keys).
 */
function buildSupportedMimeTypes(supportsImages) {
    const map = { 'text/plain': true, 'text/markdown': true };
    if (supportsImages) {
        map['image/png'] = true;
        map['image/jpeg'] = true;
        map['image/gif'] = true;
        map['image/webp'] = true;
    }
    return map;
}

if (typeof globalThis !== 'undefined') {
    globalThis.__agyByokMimeTypes = { buildSupportedMimeTypes };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildSupportedMimeTypes };
}

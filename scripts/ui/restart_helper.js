/**
 * restart_helper.js
 * Universal restart helper for browser / Electron UI components.
 * Safely calls controller.restartApp() or window.agyBridge.restartApp().
 */

async function restartAppSafe(controller) {
    if (controller && typeof controller.restartApp === "function") {
        try {
            await controller.restartApp();
            return true;
        } catch (e) {
            console.error("[RestartHelper] controller.restartApp error:", e);
        }
    } else if (typeof window !== "undefined" && window.agyBridge && typeof window.agyBridge.restartApp === "function") {
        try {
            await window.agyBridge.restartApp();
            return true;
        } catch (e) {
            console.error("[RestartHelper] window.agyBridge.restartApp error:", e);
        }
    }
    return false;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { restartAppSafe };
}

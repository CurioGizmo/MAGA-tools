const assert = require("assert");

const registry = {};

class MockClassList {
    constructor() { this.classes = new Set(); }
    add(...cls) { cls.forEach(c => this.classes.add(c)); }
    remove(...cls) { cls.forEach(c => this.classes.delete(c)); }
    contains(c) { return this.classes.has(c); }
}

class MockElement {
    constructor(tagName = "div") {
        this.tagName = tagName.toUpperCase();
        this._id = "";
        this.className = "";
        this.classList = new MockClassList();
        this.style = {};
        this.attributes = {};
        this.children = [];
        this.parentElement = null;
        this.textContent = "";
        this._innerHTML = "";
    }
    get id() { return this._id; }
    set id(val) {
        if (this._id && registry[this._id] === this) {
            delete registry[this._id];
        }
        this._id = val;
        if (val) {
            registry[val] = this;
            this.attributes["id"] = String(val);
        } else {
            delete this.attributes["id"];
        }
    }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(val) {
        this._innerHTML = val;
        if (val === "") {
            for (const child of this.children) {
                if (child.id && registry[child.id] === child) {
                    delete registry[child.id];
                }
                child.parentElement = null;
            }
            this.children = [];
        }
    }
    setAttribute(name, val) {
        this.attributes[name] = String(val);
        if (name === "id") {
            this.id = String(val);
        }
    }
    getAttribute(name) { return this.attributes[name] || null; }
    appendChild(child) {
        if (child.parentElement) child.parentElement.removeChild(child);
        child.parentElement = this;
        this.children.push(child);
        return child;
    }
    insertBefore(child, ref) {
        if (child.parentElement) child.parentElement.removeChild(child);
        child.parentElement = this;
        const idx = this.children.indexOf(ref);
        if (idx === -1) this.children.push(child);
        else this.children.splice(idx, 0, child);
        return child;
    }
    removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx !== -1) {
            this.children.splice(idx, 1);
            child.parentElement = null;
        }
        return child;
    }
    querySelector(sel) {
        if (sel === "[data-agy-restart-banner]") {
            return this.children.find(c => c.getAttribute("data-agy-restart-banner") === "true") || null;
        }
        if (sel === "button") {
            return this.children.find(c => c.tagName === "BUTTON") || null;
        }
        return null;
    }
    querySelectorAll(sel) {
        const res = [];
        function walk(n) {
            for (const c of n.children) {
                if (sel === "[data-agy-restart-banner]" && c.getAttribute("data-agy-restart-banner") === "true") res.push(c);
                walk(c);
            }
        }
        walk(this);
        return res;
    }
}

global.document = {
    createElement: (tag) => new MockElement(tag),
    getElementById: (id) => registry[id] || null
};

const { renderRestartBanner } = require("../ui/restart_banner");

console.log("=== Starting Restart Banner Unit Tests ===\n");

console.log("1. Testing tailwind variant idempotency & neighbor retention...");
const tailwindContainer = new MockElement("div");
const neighborSpan = new MockElement("span");
neighborSpan.textContent = "Keep me alive";
tailwindContainer.appendChild(neighborSpan);

renderRestartBanner(tailwindContainer, { styleVariant: "tailwind", bannerId: "agy-tw-restart-banner", message: "First notice" });
assert.strictEqual(tailwindContainer.children.length, 2, "Must contain neighbor + 1 banner");
assert.strictEqual(tailwindContainer.querySelectorAll("[data-agy-restart-banner]").length, 1);

renderRestartBanner(tailwindContainer, { styleVariant: "tailwind", bannerId: "agy-tw-restart-banner", message: "Updated notice" });
assert.strictEqual(tailwindContainer.children.length, 2, "Double call must not create duplicate banner");
assert.strictEqual(tailwindContainer.querySelectorAll("[data-agy-restart-banner]").length, 1);
assert.strictEqual(tailwindContainer.children[0], neighborSpan, "Neighbor element must be preserved");
console.log("  [✓] Tailwind variant is idempotent and preserves container neighbors");

console.log("\n2. Testing css-class variant idempotency...");
const cssContainer = new MockElement("div");
renderRestartBanner(cssContainer, { styleVariant: "css-class", bannerId: "agy-css-restart-banner", message: "CSS notice 1" });
assert.strictEqual(cssContainer.querySelectorAll("[data-agy-restart-banner]").length, 1);
renderRestartBanner(cssContainer, { styleVariant: "css-class", bannerId: "agy-css-restart-banner", message: "CSS notice 2" });
assert.strictEqual(cssContainer.querySelectorAll("[data-agy-restart-banner]").length, 1);
console.log("  [✓] CSS-class variant is idempotent");

console.log("\n3. Testing XSS message safety (textContent / text escaping)...");
const xssPayload = "<script>alert(1)</script><img src=x onerror=alert(2)>";
const testContainer = new MockElement("div");
const banner = renderRestartBanner(testContainer, { styleVariant: "tailwind", bannerId: "agy-xss-restart-banner", message: xssPayload });

function findNodeByText(node, text) {
    if (node.textContent === text) return node;
    for (const child of node.children) {
        const found = findNodeByText(child, text);
        if (found) return found;
    }
    return null;
}
const textNode = findNodeByText(banner, xssPayload);
assert.ok(textNode, "Node with exact textContent matching xssPayload must exist");

function checkNoOnAttributes(node) {
    for (const attrKey of Object.keys(node.attributes)) {
        assert.ok(!attrKey.toLowerCase().startsWith("on"), "Attribute " + attrKey + " must not start with on");
    }
    for (const child of node.children) {
        checkNoOnAttributes(child);
    }
}
checkNoOnAttributes(banner);
console.log("  [✓] Message text is treated strictly as textContent, XSS injection prevented");

console.log("\n4. Testing bannerId-reuse and cross-panel isolation (honest registry)...");
const reuseContainer = new MockElement("div");
const customBannerId = "agy-test-custom-banner";
const bannerFirst = renderRestartBanner(reuseContainer, { styleVariant: "tailwind", bannerId: customBannerId, message: "Initial" });
assert.strictEqual(document.getElementById(customBannerId), bannerFirst, "Banner must be registered in document by bannerId");

const bannerSecond = renderRestartBanner(reuseContainer, { styleVariant: "tailwind", bannerId: customBannerId, message: "Updated" });
assert.strictEqual(bannerSecond, bannerFirst, "Subsequent render in same container must reuse existing banner instance");

const containerA = new MockElement("div");
const containerB = new MockElement("div");
const sharedBannerId = "agy-shared-banner-id";

const bannerA = renderRestartBanner(containerA, { styleVariant: "tailwind", bannerId: sharedBannerId, message: "Panel A notice" });
assert.strictEqual(containerA.children[0], bannerA, "Panel A must contain banner A");
assert.strictEqual(bannerA.parentElement, containerA, "Banner A parent must be container A");

const bannerB = renderRestartBanner(containerB, { styleVariant: "tailwind", bannerId: sharedBannerId, message: "Panel B notice" });
assert.strictEqual(containerA.children[0], bannerA, "Panel A must retain its own banner A (no migration)");
assert.strictEqual(bannerA.parentElement, containerA, "Banner A must not be reparented");
assert.strictEqual(containerB.children[0], bannerB, "Panel B must contain its own banner B");
assert.strictEqual(bannerB.parentElement, containerB, "Banner B parent must be container B");
assert.notStrictEqual(bannerA, bannerB, "Panels A and B must have separate banner instances under container-first lookup");
console.log("  [✓] getElementById registry and cross-panel container-first isolation verified");

console.log("\n=== ALL RESTART BANNER TESTS PASSED! ✓ ===\n");

// Frontend tests: load sidebar.js and panel.js into the official Home Assistant
// demo (the real, current frontend) and check what people see.
//
//   cd tests/frontend && npm install && npm test
//
// Uses an installed Edge (or Chrome with BROWSER=chrome). The demo has no
// Glass Sidebar backend, so the websocket answers are faked in the page.
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const WWW = path.join(__dirname, "../../custom_components/glass_sidebar/www");
const VERSION = fs.readFileSync(path.join(__dirname, "../../custom_components/glass_sidebar/const.py"), "utf8").match(/VERSION = "([^"]+)"/)[1];
// The demo's root element is <ha-demo> instead of <home-assistant>.
const SIDEBAR = fs.readFileSync(path.join(WWW, "sidebar.js"), "utf8").replaceAll('document.querySelector("home-assistant")', 'document.querySelector("ha-demo")');
const PANEL = fs.readFileSync(path.join(WWW, "panel.js"), "utf8");
const OUT = path.join(__dirname, "out");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? "  — " + detail : ""}`);
};

const DEFAULTS = { floating: true, inset: 8, radius: 20, blur: 18, opacity: 74, tint: "theme", highlight: "soft", selected_shape: "pill",
  density: "normal", shadow: "soft", glow: false, icon_color: "theme", custom_accent: false, accent_color: [3, 169, 244],
  hover_motion: true, glass_cards: false, extend_background: true, quick_menu: true, mobile_width: 300, mobile_blur: true,
  mobile_text_size: 14, mobile_rounded: true, mobile_swipe: false, mobile_hide_header: false, categories: [], custom_styles: [], user_styles: {} };
const style = (tint, highlight, shape, extra = {}) => ({ floating: true, inset: 8, radius: 20, blur: 18, opacity: 70, tint, highlight,
  selected_shape: shape, density: "normal", shadow: "soft", glow: false, icon_color: "theme", custom_accent: false, accent_color: [3, 169, 244], ...extra });
const PRESETS = {
  frosted: style("light", "soft", "pill", { opacity: 62 }), midnight: style("dark", "soft", "pill", { shadow: "deep" }),
  aurora: style("dark", "vivid", "pill", { custom_accent: true, accent_color: [124, 92, 255], glow: true }),
  minimal: style("theme", "soft", "bar", { floating: false, inset: 0, radius: 0, blur: 0, opacity: 100, shadow: "none" }),
};
// The Frosted Glass theme's card-mod rules for the sidebar, which used to win.
const THEME_SIDEBAR = `:host { background: transparent; } :host::before { content: ''; position: absolute; inset: 0; background: rgba(254,244,242,.1); }`;
const THEME_DRAWER = `.sidebar-shell { background: rgb(230,215,200); border-inline-end: 0.5px solid #fff; } wa-drawer::part(dialog) { background: rgb(230,215,200); }`;

async function boot(page) {
  await page.goto("https://demo.home-assistant.io/", { waitUntil: "load", timeout: 90000 });
  await page.waitForFunction(() => document.querySelector("ha-demo")?.shadowRoot?.querySelector("home-assistant-main")
    ?.shadowRoot?.querySelector("ha-sidebar")?.shadowRoot?.querySelector("ha-list-item-button") && document.querySelector("ha-demo").hass?.connection,
    null, { timeout: 90000 });
  await page.evaluate(() => document.querySelector("ha-demo").dispatchEvent(new CustomEvent("hass-dock-sidebar", { detail: { dock: "docked" }, bubbles: true, composed: true })));
  await page.waitForTimeout(1500);
}

// Fake backend: settings, update, users, the live config push, and per-user storage.
async function installBackend(page, options = {}, people = []) {
  await page.evaluate(([defaults, presets, opts, version, persons]) => {
    const hass = document.querySelector("ha-demo").hass;
    Object.assign(window, { __calls: [], __options: { ...defaults, ...opts }, __user: null, __userSubs: [], __toasts: [] });
    window.addEventListener("hass-notification", (ev) => window.__toasts.push(ev.detail), true);
    const toConfig = (o) => ({ enabled: true, version: window.__serverVersion || version, ...o,
      accent: o.custom_accent ? `rgb(${o.accent_color.join(", ")})` : null });
    const result = () => ({ options: window.__options, defaults, presets, version });
    hass.mockWS("glass_sidebar/settings", () => result());
    hass.mockWS("glass_sidebar/users", () => persons);
    hass.mockWS("glass_sidebar/settings/update", (msg) => {
      window.__calls.push(msg.changes);
      window.__options = { ...window.__options, ...msg.changes };
      window.__push?.(toConfig(window.__options));
      return result();
    });
    const conn = hass.connection;
    const sub = conn.subscribeMessage.bind(conn);
    conn.subscribeMessage = (cb, msg, o) => {
      if (msg?.type === "glass_sidebar/subscribe") { window.__push = cb; setTimeout(() => cb(toConfig(window.__options)), 0); return Promise.resolve(() => {}); }
      if (msg?.type === "frontend/subscribe_user_data") { window.__userSubs.push(cb); setTimeout(() => cb({ value: window.__user }), 0); return Promise.resolve(() => {}); }
      return sub(cb, msg, o);
    };
    const send = conn.sendMessagePromise.bind(conn);
    conn.sendMessagePromise = (msg) => {
      if (msg?.type === "frontend/set_user_data") { window.__user = msg.value; window.__userSubs.forEach((cb) => cb({ value: msg.value })); return Promise.resolve(null); }
      return send(msg);
    };
    window.__set = (changes) => { window.__options = { ...window.__options, ...changes }; window.__push(toConfig(window.__options)); };
  }, [DEFAULTS, PRESETS, options, VERSION, people]);
}

const sidebar = (page, fn) => page.evaluate(`(${fn})(document.querySelector("ha-demo").shadowRoot.querySelector("home-assistant-main").shadowRoot.querySelector("ha-sidebar"))`);
const set = (page, changes) => page.evaluate((c) => window.__set(c), changes).then(() => page.waitForTimeout(500));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.BROWSER === "chrome" ? "chrome" : "msedge", headless: true });
  const errors = [];

  // ======================= Desktop sidebar =======================
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await boot(page);
  await page.evaluate(() => localStorage.removeItem("glass-sidebar-collapsed"));
  await installBackend(page, { categories: [{ name: "Kaarten", panels: ["energy", "map"], icon: "mdi:map" }] });
  await page.addScriptTag({ content: SIDEBAR });
  await page.waitForTimeout(1200);

  let s = await sidebar(page, (el) => {
    const shell = el.getRootNode().querySelector("ha-drawer").shadowRoot.querySelector(".sidebar-shell");
    return { radius: getComputedStyle(el).borderTopRightRadius, blur: getComputedStyle(el).backdropFilter,
      width: Math.round(el.getBoundingClientRect().width), shell: Math.round(shell.getBoundingClientRect().width), pad: getComputedStyle(shell).paddingTop };
  });
  check("Floating glass: rounded, blurred, inset", s.radius === "20px" && /blur\(18px\)/.test(s.blur) && s.pad === "8px" && s.shell === 272, JSON.stringify(s));

  s = await sidebar(page, (el) => {
    const h = el.shadowRoot.querySelector(".gs-section");
    return { name: h?.textContent.trim(), icon: h?.querySelector("ha-icon")?.getAttribute("icon"), role: h?.getAttribute("role") };
  });
  check("Category heading with icon, as a button", s.name === "Kaarten" && s.icon === "mdi:map" && s.role === "button", JSON.stringify(s));
  await sidebar(page, (el) => el.shadowRoot.querySelector(".gs-section").click());
  await page.waitForTimeout(400);
  s = await sidebar(page, (el) => el.shadowRoot.querySelector("#sidebar-panel-map").getBoundingClientRect().height);
  check("Tapping a heading folds the category in", s === 0, String(s));
  await sidebar(page, (el) => {
    el.shadowRoot.querySelectorAll(".selected").forEach((b) => b.classList.remove("selected"));
    el.shadowRoot.querySelector("#sidebar-panel-map").classList.add("selected");
  });
  await page.waitForTimeout(400);
  s = await sidebar(page, (el) => el.shadowRoot.querySelector("#sidebar-panel-map").getBoundingClientRect().height);
  check("The page you're on stays visible inside a folded category", s > 0, String(s));
  await sidebar(page, (el) => {
    el.shadowRoot.querySelector("#sidebar-panel-map").classList.remove("selected");
    el.shadowRoot.querySelector("#sidebar-panel-lovelace").classList.add("selected");
    el.shadowRoot.querySelector(".gs-section").click();
  });
  await page.waitForTimeout(400);

  for (const [changes, test, label] of [
    [{ selected_shape: "bar" }, (x) => x.beforeWidth === "4px", "Selected item as a bar"],
    [{ selected_shape: "outline", highlight: "vivid" }, (x) => /2px inset/.test(x.beforeShadow), "Selected item as an outline"],
    [{ selected_shape: "pill", highlight: "vivid" }, (x) => /linear-gradient/.test(x.beforeImage) && x.beforeZ === "-1", "Vivid pill behind the text"],
    [{ density: "compact" }, (x) => x.row === 34, "Compact spacing"],
    [{ shadow: "deep", glow: true }, (x) => /64px/.test(x.shadow) && /radial-gradient/.test(x.bg), "Deep shadow and accent glow"],
    [{ tint: "dark" }, (x) => x.text === "#ECEEF2", "Dark glass with light text"],
  ]) {
    await set(page, changes);
    s = await sidebar(page, (el) => {
      const sel = el.shadowRoot.querySelector("ha-list-item-button.selected");
      const other = el.shadowRoot.querySelector("ha-list-item-button:not(.selected)[id^=sidebar-panel-]");
      const b = getComputedStyle(sel, "::before");
      return { beforeWidth: b.width, beforeShadow: b.boxShadow, beforeImage: b.backgroundImage, beforeZ: b.zIndex,
        row: Math.round(other.getBoundingClientRect().height), shadow: getComputedStyle(el).boxShadow,
        bg: getComputedStyle(el).backgroundImage, text: getComputedStyle(el).getPropertyValue("--sidebar-text-color").trim() };
    });
    check(label, test(s), JSON.stringify(s).slice(0, 200));
  }
  await set(page, { ...DEFAULTS, categories: [] });

  // A theme that styles the sidebar with card-mod no longer wins.
  await page.evaluate(([a, b]) => {
    const main = document.querySelector("ha-demo").shadowRoot.querySelector("home-assistant-main");
    const add = (root, css) => { const st = new CSSStyleSheet(); st.replaceSync(css); root.adoptedStyleSheets = [...root.adoptedStyleSheets, st]; };
    add(main.shadowRoot.querySelector("ha-sidebar").shadowRoot, a);
    add(main.shadowRoot.querySelector("ha-drawer").shadowRoot, b);
  }, [THEME_SIDEBAR, THEME_DRAWER]);
  await set(page, { radius: 20 });
  s = await sidebar(page, (el) => ({ radius: getComputedStyle(el).borderTopRightRadius, before: getComputedStyle(el, "::before").content,
    shellBg: getComputedStyle(el.getRootNode().querySelector("ha-drawer").shadowRoot.querySelector(".sidebar-shell")).backgroundColor }));
  check("Sidebar themes (card-mod) can't undo the look", s.radius === "20px" && s.before === "none" && s.shellBg === "rgba(0, 0, 0, 0)", JSON.stringify(s));

  // Dashboard background runs under the sidebar.
  s = await page.evaluate(() => {
    const main = document.querySelector("ha-demo").shadowRoot.querySelector("home-assistant-main");
    const bg = main.shadowRoot.querySelector("partial-panel-resolver").firstElementChild.shadowRoot.querySelector("hui-root").shadowRoot.querySelector("hui-view-background");
    const r = bg.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right) };
  });
  check("Dashboard background runs under the sidebar", s.left === 0 && s.right === 1280, JSON.stringify(s));

  // Notifications open in the same glass panel.
  await sidebar(page, (el) => el.dispatchEvent(new CustomEvent("hass-show-notifications", { bubbles: true, composed: true })));
  await page.waitForTimeout(1500);
  s = await page.evaluate(() => {
    const nd = document.querySelector("ha-demo").shadowRoot.querySelector("notification-drawer");
    const body = nd?.shadowRoot?.querySelector("ha-drawer")?.shadowRoot?.querySelector("wa-drawer")?.shadowRoot?.querySelector('[part~="body"]');
    return body ? getComputedStyle(body).borderTopRightRadius : null;
  });
  check("Notifications in a rounded glass panel", s === "20px", String(s));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);

  // Quick menu: your own style by default.
  await sidebar(page, (el) => el.shadowRoot.querySelector(".gs-quick").click());
  await page.waitForTimeout(800);
  await page.evaluate(() => [...document.querySelector(".glass-sidebar-quick").shadowRoot.querySelectorAll(".style")].find((b) => b.textContent.includes("Aurora")).click());
  await page.waitForTimeout(600);
  s = await page.evaluate(() => ({ user: window.__user, calls: window.__calls.length }));
  check("Quick menu: a style becomes your own style", s.user?.use_own === true && s.user.values.tint === "dark" && s.calls === 0, JSON.stringify(s).slice(0, 160));
  s = await sidebar(page, (el) => getComputedStyle(el).getPropertyValue("--sidebar-selected-icon-color").trim());
  check("Your own style wins in the sidebar", s === "rgb(124, 92, 255)", s);
  await page.keyboard.press("Escape");

  // ---- After an update: a notice, never a reload by itself ----
  const loads = [];
  page.on("load", () => loads.push(Date.now()));
  await page.evaluate(() => { window.__marker = 1; window.__serverVersion = "99.0.0"; });
  await set(page, { radius: 18 });
  await set(page, { radius: 19 });
  await page.waitForTimeout(1500);
  s = await page.evaluate(() => ({ marker: window.__marker, toasts: window.__toasts.filter((t) => t.id === "glass-sidebar-update") }));
  check("New version: the page is NOT reloaded", s.marker === 1 && loads.length === 0, JSON.stringify({ loads: loads.length }));
  check("New version: one notice, even after several updates", s.toasts.length === 1, String(s.toasts.length));
  check("Notice stays until dismissed and has a Reload button", s.toasts[0]?.duration === -1 && s.toasts[0]?.dismissable === true
    && s.toasts[0]?.action?.text === "Herladen" && /nieuwe versie van Glass Sidebar/.test(s.toasts[0]?.message), JSON.stringify(s.toasts[0]));
  s = await page.evaluate(() => {
    // The toast's text sits a few shadow roots deep.
    const deepText = (node) => [...node.childNodes].map((n) => (n.nodeType === 3 ? n.textContent : deepText(n))).join("")
      + (node.shadowRoot ? deepText(node.shadowRoot) : "");
    const host = document.querySelector("ha-demo").shadowRoot.querySelector("notification-manager");
    return host ? deepText(host).includes("nieuwe versie van Glass Sidebar") : null;
  });
  check("Home Assistant shows the notice", s === true, String(s));
  await page.screenshot({ path: `${OUT}/update-notice.png` });
  await Promise.all([page.waitForEvent("load", { timeout: 30000 }), page.evaluate(() => window.__toasts.find((t) => t.id === "glass-sidebar-update").action.action())]);
  check("The Reload button reloads the page", loads.length === 1, String(loads.length));

  // ======================= Phone =======================
  const phone = await browser.newPage({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  phone.on("pageerror", (e) => errors.push("phone: " + e.message));
  await boot(phone);
  await installBackend(phone, { mobile_text_size: 18, mobile_swipe: true });
  await phone.addScriptTag({ content: SIDEBAR });
  await phone.waitForTimeout(1000);
  const cdp = await phone.context().newCDPSession(phone);
  const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
  await touch("touchStart", 5, 400);
  for (const x of [20, 40, 70, 110]) await touch("touchMove", x, 402);
  await touch("touchEnd");
  await phone.waitForTimeout(1300);
  s = await phone.evaluate(() => {
    const main = document.querySelector("ha-demo").shadowRoot.querySelector("home-assistant-main");
    const wa = main.shadowRoot.querySelector("ha-drawer").shadowRoot.querySelector("wa-drawer");
    const dialog = wa.shadowRoot.querySelector('[part="dialog"]');
    const sb = main.shadowRoot.querySelector("ha-sidebar");
    const item = sb.shadowRoot.querySelector("ha-list-item-button[id^=sidebar-panel-]");
    return { open: wa.hasAttribute("open"), width: Math.round(dialog.getBoundingClientRect().width), backdrop: getComputedStyle(dialog, "::backdrop").backdropFilter,
      radius: getComputedStyle(sb).borderTopRightRadius, row: Math.round(item.getBoundingClientRect().height), font: getComputedStyle(item.querySelector(".item-text")).fontSize };
  });
  check("Phone: swipe opens the drawer", s.open === true, JSON.stringify(s));
  check("Phone: 300 px rounded drawer over a blurred page", s.width === 300 && /blur/.test(s.backdrop) && s.radius === "20px", JSON.stringify(s));
  check("Phone: text size 18 px, rows 54 px", s.font === "18px" && s.row === 54, JSON.stringify(s));

  // ======================= Settings page =======================
  const sp = await browser.newPage({ viewport: { width: 1400, height: 1300 } });
  sp.on("pageerror", (e) => errors.push("panel: " + e.message));
  await boot(sp);
  await installBackend(sp, { categories: [{ name: "Kaarten", panels: ["map"] }] }, [
    { id: "u-joyce", name: "Joyce", is_admin: false, own_style: false, assigned: false },
    { id: "u-sam", name: "Sam", is_admin: false, own_style: true, assigned: false },
  ]);
  await sp.addScriptTag({ content: PANEL });
  const mount = (admin) => sp.evaluate((isAdmin) => {
    document.querySelector("glass-sidebar-panel")?.remove();
    const el = document.createElement("glass-sidebar-panel");
    el.style.cssText = "position: fixed; inset: 0; z-index: 10000; overflow: auto";
    const hass = document.querySelector("ha-demo").hass;
    el.hass = isAdmin ? hass : { ...hass, user: { ...hass.user, is_admin: false } };
    el.narrow = false;
    document.body.append(el);
    window.__panel = el;
  }, admin).then(() => sp.waitForTimeout(1200));
  const P = (fn) => sp.evaluate(`(${fn})(window.__panel.shadowRoot)`);
  await mount(true);

  s = await P((r) => ({ tabs: [...r.querySelectorAll(".tab")].map((t) => t.textContent).join("|"), scope: [...r.querySelectorAll('[data-action="scope"]')].length }));
  check("Page: tabs and the three 'who' choices", s.tabs === "Stijl|Kleuren|Vorm|Telefoon|Categorieën" && s.scope === 3, JSON.stringify(s));

  // Just for me.
  await P((r) => r.getElementById("tab-color").click());
  await sp.waitForTimeout(300);
  s = await P((r) => ({ circles: r.querySelectorAll(".circle").length, combos: r.querySelectorAll('[data-f^="sel-"]').length, tints: r.querySelectorAll('.choice[data-key="tint"]').length }));
  check("Colors: color circles, 6 selected-item examples, 3 glass tiles", s.circles === 10 && s.combos === 6 && s.tints === 3, JSON.stringify(s));
  await P((r) => r.querySelector('[data-f="sel-bar-soft"]').click());
  await sp.waitForTimeout(500);
  s = await sp.evaluate(() => ({ user: window.__user, calls: window.__calls.length }));
  check("Just for me: saved as your own style, not the standard", s.user?.use_own && s.user.values.selected_shape === "bar" && s.calls === 0, JSON.stringify(s).slice(0, 160));
  await sp.screenshot({ path: `${OUT}/settings-colors.png` });

  // For someone else.
  await P((r) => r.querySelector('[data-action="scope"][data-value="user"]').click());
  await sp.waitForTimeout(800);
  await P((r) => r.getElementById("tab-color").click());
  await P((r) => r.querySelector('[data-action="accent"][data-value="233,30,99"]').click());
  await sp.waitForTimeout(500);
  s = await sp.evaluate(() => window.__calls.at(-1));
  check("For someone else: saved for that person only", s?.user_styles?.["u-joyce"]?.values?.accent_color?.join() === "233,30,99" && !("accent_color" in s), JSON.stringify(s));
  await P((r) => { const sel = r.getElementById("person"); sel.value = "u-sam"; sel.dispatchEvent(new Event("change", { bubbles: true })); });
  await sp.waitForTimeout(400);
  s = await P((r) => r.querySelector(".note").classList.contains("warn"));
  check("For someone else: warning when they chose their own style", s === true);

  // Standard for everyone: drag a panel into a category.
  await P((r) => r.querySelector('[data-action="scope"][data-value="all"]').click());
  await P((r) => r.getElementById("tab-categories").click());
  await sp.waitForTimeout(500);
  const box = (sel) => sp.evaluate((q) => { const b = window.__panel.shadowRoot.querySelector(q).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, top: b.y }; }, sel);
  const from = await box('.zone.loose .panel-row[data-panel="energy"] .grip');
  const to = await box('.zone.cat[data-zone="0"] .panel-row[data-panel="map"]');
  await sp.mouse.move(from.x, from.y);
  await sp.mouse.down();
  for (let i = 1; i <= 10; i += 1) await sp.mouse.move(from.x + (to.x - from.x) * i / 10, from.y + (to.top + 4 - from.y) * i / 10);
  await sp.mouse.up();
  await sp.waitForTimeout(500);
  s = await sp.evaluate(() => window.__calls.at(-1)?.categories?.[0]?.panels);
  check("Categories: drag and drop", JSON.stringify(s) === '["energy","map"]', JSON.stringify(s));

  // Non-admin.
  await mount(false);
  s = await P((r) => r.querySelectorAll('[data-action="scope"]').length);
  check("Non-admin: only their own style", s === 0, String(s));

  check("No script errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error("TEST CRASH:", e); process.exit(1); });

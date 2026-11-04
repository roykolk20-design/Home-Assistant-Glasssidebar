// Regenerates the README screenshots that come from the live Home Assistant demo
// (everything in images/ except the mock-ups: compare, light, dark, vivid, collapsed, mobile).
//
//   cd tests/frontend && node screenshots.mjs [outDir]
//
// Runs in English (browser locale en-US, so the demo and Glass Sidebar are both English).
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const here = path.dirname(fileURLToPath(import.meta.url));
const WWW = path.join(here, "../../custom_components/glass_sidebar/www");
const VERSION = fs.readFileSync(path.join(here, "../../custom_components/glass_sidebar/const.py"), "utf8").match(/VERSION = "([^"]+)"/)[1];
const SIDEBAR = fs.readFileSync(path.join(WWW, "sidebar.js"), "utf8").replaceAll('document.querySelector("home-assistant")', 'document.querySelector("ha-demo")');
// panel.js hardcodes the Dutch word "Energie" in the selected-item examples; show it in English here.
const PANEL = fs.readFileSync(path.join(WWW, "panel.js"), "utf8").replaceAll(">Energie</span>", ">Energy</span>");
const OUT = path.resolve(process.argv[2] || path.join(here, "../../images"));

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
const CRIMSON = { custom_accent: true, accent_color: [196, 30, 88], highlight: "vivid" };

async function boot(page) {
  await page.goto("https://demo.home-assistant.io/", { waitUntil: "load", timeout: 90000 });
  await page.waitForFunction(() => document.querySelector("ha-demo")?.shadowRoot?.querySelector("home-assistant-main")
    ?.shadowRoot?.querySelector("ha-sidebar")?.shadowRoot?.querySelector("ha-list-item-button") && document.querySelector("ha-demo").hass?.connection,
    null, { timeout: 90000 });
  await page.evaluate(() => document.querySelector("ha-demo").dispatchEvent(new CustomEvent("hass-dock-sidebar", { detail: { dock: "docked" }, bubbles: true, composed: true })));
  await page.waitForTimeout(1500);
}

// Fake Glass Sidebar backend: settings, update, users, live config push, per-user storage.
async function installBackend(page, options = {}, people = []) {
  await page.evaluate(([defaults, presets, opts, version, persons]) => {
    const hass = document.querySelector("ha-demo").hass;
    Object.assign(window, { __options: { ...defaults, ...opts }, __user: null, __userSubs: [] });
    const toConfig = (o) => ({ enabled: true, version, ...o, accent: o.custom_accent ? `rgb(${o.accent_color.join(", ")})` : null });
    const result = () => ({ options: window.__options, defaults, presets, version });
    hass.mockWS("glass_sidebar/settings", () => result());
    hass.mockWS("glass_sidebar/users", () => persons);
    hass.mockWS("glass_sidebar/settings/update", (msg) => {
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
  }, [DEFAULTS, PRESETS, options, VERSION, people]);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.BROWSER === "chrome" ? "chrome" : "msedge", headless: true });
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => { try { localStorage.setItem("selectedLanguage", JSON.stringify("en")); } catch {} });
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + ".png") }).then(() => console.log("wrote", name));

  // ---- Desktop sidebar: personal style and quick menu ----
  const page = await context.newPage();
  await boot(page);
  await page.evaluate(() => localStorage.removeItem("glass-sidebar-collapsed"));
  await installBackend(page, { ...CRIMSON, glow: true, categories: [{ name: "Maps", panels: ["map", "energy"], icon: "mdi:map", collapsed: true }] });
  await page.addScriptTag({ content: SIDEBAR });
  await page.waitForTimeout(1500);
  // personal-style: the sidebar without categories, in the user's own colors
  await page.evaluate(() => { window.__options = { ...window.__options, categories: [] }; window.__push({ enabled: true, version: window.__options.version, ...window.__options, accent: "rgb(196, 30, 88)" }); });
  await page.waitForTimeout(800);
  await shot(page, "personal-style");

  // quick-menu: default style, a collapsed category, the quick menu open
  await page.evaluate(() => {
    const o = { ...window.__options, custom_accent: false, highlight: "soft", glow: false, categories: [{ name: "Maps", panels: ["map", "energy"], icon: "mdi:map", collapsed: true }] };
    window.__options = o;
    window.__push({ enabled: true, version: "", ...o, accent: null });
  });
  await page.waitForTimeout(800);
  await page.evaluate(`document.querySelector("ha-demo").shadowRoot.querySelector("home-assistant-main").shadowRoot.querySelector("ha-sidebar").shadowRoot.querySelector(".gs-quick").click()`);
  await page.waitForTimeout(900);
  await shot(page, "quick-menu");
  await page.close();

  // ---- Settings page ----
  const sp = await context.newPage();
  await boot(sp);
  await installBackend(sp, { categories: [{ name: "Maps", panels: ["energy"], icon: "mdi:map" }, { name: "Admin", panels: [], icon: "mdi:cog", collapsed: true }] }, [
    { id: "u-joyce", name: "Joyce", is_admin: false, own_style: false, assigned: false },
    { id: "u-sam", name: "Sam", is_admin: false, own_style: true, assigned: false },
  ]);
  await sp.addScriptTag({ content: PANEL });
  await sp.evaluate(() => { document.querySelector("ha-demo").style.visibility = "hidden"; });
  const P = (fn) => sp.evaluate(`(${fn})(window.__panel.shadowRoot)`);
  const panelShot = async (name, height, steps) => {
    await sp.setViewportSize({ width: 1400, height });
    await sp.evaluate(() => {
      document.querySelector("glass-sidebar-panel")?.remove();
      const el = document.createElement("glass-sidebar-panel");
      el.style.cssText = "position: fixed; inset: 0; z-index: 10000; overflow: auto";
      el.hass = document.querySelector("ha-demo").hass;
      el.narrow = false;
      document.body.append(el);
      window.__panel = el;
    });
    await sp.waitForTimeout(1200);
    await steps();
    await sp.waitForTimeout(600);
    await shot(sp, name);
  };
  const tab = (id) => async () => { await sp.evaluate((i) => window.__panel.shadowRoot.getElementById("tab-" + i).click(), id); await sp.waitForTimeout(400); };
  const setOptions = (changes) => sp.evaluate((c) => { window.__options = { ...window.__options, ...c }; }, changes);

  await panelShot("settings-style", 1200, tab("style"));
  await panelShot("settings-colors", 1300, tab("color"));
  await panelShot("settings-shape", 1300, tab("shape"));

  await setOptions({ ...CRIMSON, tint: "dark" });
  const all = async () => { await P((r) => r.querySelector('[data-action="scope"][data-value="all"]').click()); await sp.waitForTimeout(500); };
  await panelShot("settings-phone", 1000, async () => { await all(); await tab("phone")(); });
  await panelShot("settings-categories", 1000, async () => { await all(); await tab("categories")(); });

  await setOptions({ ...DEFAULTS, ...CRIMSON, tint: "theme", selected_shape: "outline", categories: [] });
  await panelShot("someone-else", 1300, async () => {
    await P((r) => r.querySelector('[data-action="scope"][data-value="user"]').click());
    await sp.waitForTimeout(800);
    await tab("color")();
    await P((r) => r.querySelector('[data-action="accent"][data-value="233,30,99"]').click());
    await sp.waitForTimeout(500);
    await P((r) => r.querySelector('[data-f="sel-outline-vivid"]').click());
  });

  await browser.close();
})().catch((e) => { console.error("CRASH:", e); process.exit(1); });

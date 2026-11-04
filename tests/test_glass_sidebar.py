"""Tests for Glass Sidebar, against a real Home Assistant core.

Run with pytest-homeassistant-custom-component (see requirements_test.txt).
"""

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from homeassistant import config_entries
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.setup import async_setup_component

from custom_components.glass_sidebar.config_flow import panel_choices, panel_label
from custom_components.glass_sidebar.const import (
    DOMAIN,
    JS_URL,
    PANEL_URL_PATH,
    PRESETS,
    VERSION,
    parse_categories,
    stored_categories,
)
from custom_components.glass_sidebar.settings import validate_changes

DEFAULT_EVENT = {
    "enabled": True,
    "version": VERSION,
    "floating": True,
    "inset": 8,
    "radius": 20,
    "blur": 18,
    "opacity": 74,
    "tint": "theme",
    "highlight": "soft",
    "selected_shape": "pill",
    "density": "normal",
    "shadow": "soft",
    "glow": False,
    "icon_color": "theme",
    "accent": None,
    "hover_motion": True,
    "glass_cards": False,
    "extend_background": True,
    "quick_menu": True,
    "mobile_width": 300,
    "mobile_blur": True,
    "mobile_text_size": 14,
    "mobile_rounded": True,
    "mobile_swipe": False,
    "mobile_hide_header": False,
    "categories": [],
}


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    yield


@pytest.fixture
def js_calls():
    """Record frontend JS registration (the frontend package itself isn't needed)."""
    calls = {"add": [], "remove": []}
    with patch(
        "custom_components.glass_sidebar.add_extra_js_url",
        side_effect=lambda hass, url: calls["add"].append(url),
    ), patch(
        "custom_components.glass_sidebar.remove_extra_js_url",
        side_effect=lambda hass, url: calls["remove"].append(url),
    ):
        yield calls


@pytest.fixture
async def setup_deps(hass: HomeAssistant):
    # Mark frontend and panel_custom as loaded so our dependencies are met
    # without the frontend's assets.
    hass.config.components.add("frontend")
    hass.config.components.add("panel_custom")
    hass.data["frontend_panels"] = {
        "lovelace": SimpleNamespace(sidebar_title=None),
        "energy": SimpleNamespace(sidebar_title="energy"),
        "map": SimpleNamespace(sidebar_title="map"),
        "media_browser": SimpleNamespace(sidebar_title="media_browser"),
        "dashboard-hoeki": SimpleNamespace(sidebar_title="Hoeki Dashboard"),
        "config": SimpleNamespace(sidebar_title="config"),
        "profile": SimpleNamespace(sidebar_title=None),
    }
    hass.data["frontend_panels_config"] = {"map": {"title": "Kaart"}}
    assert await async_setup_component(hass, "http", {})
    assert await async_setup_component(hass, "websocket_api", {})


async def _loaded_entry(hass, options=None):
    entry = MockConfigEntry(domain=DOMAIN, options=options or {})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def _subscribe(hass, hass_ws_client, token=None):
    ws = await (hass_ws_client(hass, token) if token else hass_ws_client(hass))
    await ws.send_json({"id": 1, "type": "glass_sidebar/subscribe"})
    assert (await ws.receive_json())["success"]
    return ws, (await ws.receive_json())["event"]


# ---- helpers ----


def test_parse_and_stored_categories():
    assert parse_categories("Dashboards: lovelace, energy ,map\n\n  Insight:logbook,,history  ") == [
        {"name": "Dashboards", "panels": ["lovelace", "energy", "map"]},
        {"name": "Insight", "panels": ["logbook", "history"]},
    ]
    for bad in ("no colon here", ": lovelace"):
        with pytest.raises(ValueError):
            parse_categories(bad)
    # 1.1 stored text; 1.2+ stores a list. Both read the same.
    assert stored_categories({"categories": "A: x, y"}) == [{"name": "A", "panels": ["x", "y"]}]
    assert stored_categories({"categories": "broken"}) == []
    assert stored_categories({"categories": [
        {"name": "A", "panels": ["x"], "icon": "mdi:sofa", "collapsed": True}, {"panels": []},
    ]}) == [{"name": "A", "panels": ["x"], "icon": "mdi:sofa", "collapsed": True}]
    assert stored_categories({}) == []


def test_panel_labels():
    assert panel_label("lovelace", None) == "Overview (/lovelace)"
    assert panel_label("media_browser", "media_browser") == "Media browser (/media_browser)"
    assert panel_label("dashboard-hoeki", "Hoeki Dashboard") == "Hoeki Dashboard (/dashboard-hoeki)"


async def test_panel_choices(hass, setup_deps):
    hass.data["frontend_panels"][PANEL_URL_PATH] = SimpleNamespace(sidebar_title=None)
    choices = {c["value"]: c["label"] for c in panel_choices(hass, ["old-panel"])}
    assert choices == {
        "energy": "Energy (/energy)",
        "dashboard-hoeki": "Hoeki Dashboard (/dashboard-hoeki)",
        "map": "Kaart (/map)",  # title renamed by the user in HA
        "media_browser": "Media browser (/media_browser)",
        "lovelace": "Overview (/lovelace)",
        "old-panel": "old-panel",  # kept so earlier choices stay visible
    }


def test_presets_are_valid_settings():
    assert len(PRESETS) == 12
    for name, values in PRESETS.items():
        assert validate_changes(dict(values)) == values, name


# ---- setup, serving, unload ----


async def test_user_flow_creates_single_entry(hass, setup_deps, js_calls):
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Glass Sidebar"
    await hass.async_block_till_done()
    assert hass.config_entries.async_entries(DOMAIN)[0].state is ConfigEntryState.LOADED
    assert js_calls["add"] == [JS_URL]

    again = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert again["type"] is FlowResultType.ABORT
    assert again["reason"] == "single_instance_allowed"


async def test_scripts_are_served(hass, setup_deps, js_calls, hass_client):
    await _loaded_entry(hass)
    client = await hass_client()
    for path, marker in (("/glass_sidebar/sidebar.js", "glass_sidebar/subscribe"),
                         ("/glass_sidebar/panel.js", "glass-sidebar-panel")):
        resp = await client.get(path)
        assert resp.status == 200
        assert marker in await resp.text()


def test_script_version_matches_integration():
    from pathlib import Path

    js = (Path(__file__).parents[1] / "custom_components/glass_sidebar/www/sidebar.js").read_text()
    assert f'const scriptVersion = "{VERSION}";' in js


def test_script_never_reloads_by_itself():
    """Reviewers asked: an update must not reload open browsers on its own."""
    from pathlib import Path

    js = (Path(__file__).parents[1] / "custom_components/glass_sidebar/www/sidebar.js").read_text()
    # The only reload is the action of the "new version" notice.
    assert js.count("location.reload()") == 1
    assert "action: { text: t.reload, action: () => location.reload() }" in js


async def test_brand_images_are_shipped(hass, setup_deps):
    from homeassistant.loader import async_get_custom_components

    assert (await async_get_custom_components(hass))[DOMAIN].has_branding


async def test_settings_page_registered_and_removed(hass, setup_deps, js_calls, hass_ws_client):
    entry = await _loaded_entry(hass)
    panel = hass.data["frontend_panels"][PANEL_URL_PATH]
    assert panel.config_panel_domain == DOMAIN  # the integration's Configure opens it
    assert panel.require_admin is False  # everyone may set their own style
    assert panel.sidebar_title is None  # not shown in the sidebar
    assert panel.config["_panel_custom"]["name"] == "glass-sidebar-panel"

    ws, event = await _subscribe(hass, hass_ws_client)
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert PANEL_URL_PATH not in hass.data["frontend_panels"]
    assert (await ws.receive_json())["event"] == {"enabled": False}
    assert js_calls["remove"] == [JS_URL]

    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert (await ws.receive_json())["event"]["enabled"] is True


# ---- config sent to browsers ----


async def test_defaults_over_websocket(hass, setup_deps, js_calls, hass_ws_client):
    await _loaded_entry(hass)
    _, event = await _subscribe(hass, hass_ws_client)
    assert event == DEFAULT_EVENT


async def test_upgrade_from_old_options(hass, setup_deps, js_calls, hass_ws_client):
    await _loaded_entry(hass, {
        "floating": True, "inset": 8, "radius": 20, "blur": 18,
        "categories": "Dashboards: lovelace, energy", "highlight": "neon", "tint": "neon",
    })
    _, event = await _subscribe(hass, hass_ws_client)
    assert event["categories"] == [{"name": "Dashboards", "panels": ["lovelace", "energy"]}]
    assert event["highlight"] == "soft" and event["tint"] == "theme"  # unknown values fall back


# ---- settings websocket ----


async def test_settings_and_update(hass, setup_deps, js_calls, hass_ws_client):
    entry = await _loaded_entry(hass)
    ws = await hass_ws_client(hass)
    await ws.send_json({"id": 1, "type": "glass_sidebar/settings"})
    res = await ws.receive_json()
    assert res["success"]
    assert set(res["result"]["presets"]) == set(PRESETS)
    assert "selected_shape" in res["result"]["personal_keys"]
    assert "categories" not in res["result"]["personal_keys"]
    assert res["result"]["user_data_key"] == "glass_sidebar"

    sub, _ = await _subscribe(hass, hass_ws_client)
    await ws.send_json({"id": 2, "type": "glass_sidebar/settings/update", "changes": {
        "radius": 28, "tint": "dark", "selected_shape": "bar", "density": "compact", "shadow": "deep",
        "glow": True, "icon_color": "accent",
        "categories": [{"name": "  Rooms ", "panels": ["map"], "icon": "mdi:sofa", "collapsed": True},
                       {"name": "Other", "panels": [], "icon": None}],
        "custom_styles": [{"name": "Mine", "values": {"radius": 12, "highlight": "vivid"}}],
    }})
    res = await ws.receive_json()
    assert res["success"], res
    assert entry.options["categories"] == [
        {"name": "Rooms", "panels": ["map"], "icon": "mdi:sofa", "collapsed": True},
        {"name": "Other", "panels": []},
    ]
    event = (await sub.receive_json())["event"]
    assert (event["radius"], event["tint"], event["selected_shape"], event["density"],
            event["shadow"], event["glow"], event["icon_color"]) == (28, "dark", "bar", "compact", "deep", True, "accent")

    for msg_id, changes in enumerate([
        {"radius": 99}, {"tint": "neon"}, {"selected_shape": "star"}, {"density": "huge"},
        {"shadow": "dark"}, {"icon_color": "red"}, {"accent_color": [1, 2]},
        {"categories": [{"name": "A"}, {"name": "a"}]}, {"categories": [{"name": ""}]},
        {"categories": [{"name": "A", "icon": "javascript:alert(1)"}]}, {"unknown_key": True},
        {"user_styles": {"abc": {"values": {"radius": 99}}}},
        {"user_styles": {"abc": {"values": {"categories": []}}}},
        {"user_styles": {"abc": {}}},
    ], start=10):
        await ws.send_json({"id": msg_id, "type": "glass_sidebar/settings/update", "changes": changes})
        res = await ws.receive_json()
        assert not res["success"], changes
        assert res["error"]["code"] == "invalid_format"
    assert entry.options["radius"] == 28


async def test_non_admin_reads_but_cannot_change(hass, setup_deps, js_calls, hass_ws_client, hass_read_only_access_token):
    await _loaded_entry(hass)
    ws = await hass_ws_client(hass, hass_read_only_access_token)
    await ws.send_json({"id": 1, "type": "glass_sidebar/settings"})
    assert (await ws.receive_json())["success"]
    for msg_id, msg in enumerate([
        {"type": "glass_sidebar/settings/update", "changes": {"radius": 1}},
        {"type": "glass_sidebar/users"},
    ], start=2):
        await ws.send_json({"id": msg_id, **msg})
        res = await ws.receive_json()
        assert not res["success"] and res["error"]["code"] == "unauthorized"


# ---- a style for someone else ----


async def test_style_for_someone_else(hass, setup_deps, js_calls, hass_ws_client, hass_read_only_user, hass_read_only_access_token):
    entry = await _loaded_entry(hass)
    admin_ws, _ = await _subscribe(hass, hass_ws_client)
    other_ws, other = await _subscribe(hass, hass_ws_client, hass_read_only_access_token)
    assert other["radius"] == 20

    await admin_ws.send_json({"id": 5, "type": "glass_sidebar/settings/update", "changes": {
        "user_styles": {hass_read_only_user.id: {"values": {
            "custom_accent": True, "accent_color": [236, 64, 122], "radius": 26, "density": "spacious"}}},
    }})
    msgs = [await admin_ws.receive_json(), await admin_ws.receive_json()]
    assert next(m for m in msgs if m.get("type") == "result")["success"]
    admin_event = next(m for m in msgs if m.get("type") == "event")["event"]
    assert admin_event["radius"] == 20 and admin_event["accent"] is None  # the admin keeps the standard

    other = (await other_ws.receive_json())["event"]
    assert other["radius"] == 26 and other["density"] == "spacious"
    assert other["accent"] == "rgb(236, 64, 122)"
    assert "user_styles" not in other and "user_styles" not in admin_event
    assert entry.options["user_styles"][hass_read_only_user.id]["values"]["radius"] == 26


async def test_people_list(hass, setup_deps, js_calls, hass_ws_client, hass_admin_user, hass_read_only_user):
    from homeassistant.components.frontend.storage import async_user_store

    await _loaded_entry(hass, {"user_styles": {hass_read_only_user.id: {"values": {"radius": 4}}}})
    store = await async_user_store(hass, hass_read_only_user.id)
    await store.async_set_item("glass_sidebar", {"use_own": True, "values": {"radius": 10}})

    ws = await hass_ws_client(hass)
    await ws.send_json({"id": 1, "type": "glass_sidebar/users"})
    res = await ws.receive_json()
    assert res["success"], res
    people = {p["id"]: p for p in res["result"]}
    assert people[hass_read_only_user.id]["own_style"] is True
    assert people[hass_read_only_user.id]["assigned"] is True
    assert people[hass_admin_user.id]["own_style"] is False


# ---- fallback options form ----


async def test_options_menu_saves_right_away(hass, setup_deps, js_calls, hass_ws_client):
    entry = await _loaded_entry(hass, {"categories": [{"name": "Rooms", "panels": ["map"], "icon": "mdi:sofa", "collapsed": True}]})
    ws, _ = await _subscribe(hass, hass_ws_client)
    opts = hass.config_entries.options
    menu = await opts.async_init(entry.entry_id)
    assert menu["menu_options"] == ["appearance", "mobile", "categories", "done"]
    flow_id = menu["flow_id"]

    await opts.async_configure(flow_id, {"next_step_id": "mobile"})
    await opts.async_configure(flow_id, {"mobile_width": 280.0, "mobile_text_size": 13.0, "mobile_blur": False,
                                         "mobile_rounded": False, "mobile_swipe": True, "mobile_hide_header": True})
    await hass.async_block_till_done()
    assert entry.options["mobile_width"] == 280.0
    assert (await ws.receive_json())["event"]["mobile_width"] == 280

    # Editing a category here keeps its icon and "start collapsed".
    await opts.async_configure(flow_id, {"next_step_id": "categories"})
    await opts.async_configure(flow_id, {"next_step_id": "category_pick"})
    await opts.async_configure(flow_id, {"category": "0"})
    await opts.async_configure(flow_id, {"name": "Kamers", "panels": ["map", "energy"], "position": 1, "remove": False})
    assert entry.options["categories"] == [
        {"name": "Kamers", "panels": ["map", "energy"], "icon": "mdi:sofa", "collapsed": True}
    ]
    await opts.async_configure(flow_id, {"next_step_id": "init"})
    done = await opts.async_configure(flow_id, {"next_step_id": "done"})
    assert done["type"] is FlowResultType.CREATE_ENTRY

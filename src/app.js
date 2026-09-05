/**
 * The page around the demos: connecting, identifying the board, and the raw
 * console.
 *
 * Everything product-specific lives in src/products/. This file never names a
 * product; it asks the board what it is and hands the link to whatever the
 * registry returns.
 */

import {
  SerialTransport, describePort, isSupported, requestPort,
} from "./serial.js";
import {BootControl, DEFAULT_PINS} from "./boot.js";
import {DeviceLink} from "./link.js";
import {hexdumpRow, parseHex, printableLine} from "./lines.js";
import {PRODUCTS, findProduct} from "./registry.js";
import {parseVersion} from "./version.js";
import {h} from "./ui.js";

const $ = (id) => document.getElementById(id);

const els = {
  connStatus: $("connStatus"),
  connText: $("connText"),
  btnConnect: $("btnConnect"),
  btnDisconnect: $("btnDisconnect"),
  btnReset: $("btnReset"),
  chkAnyPort: $("chkAnyPort"),
  deviceFacts: $("deviceFacts"),
  factPort: $("factPort"),
  factProduct: $("factProduct"),
  factFirmware: $("factFirmware"),
  tabDemo: $("tabDemo"),
  tabConsole: $("tabConsole"),
  panelDemo: $("panelDemo"),
  panelConsole: $("panelConsole"),
  productPanel: $("productPanel"),
  portState: $("portState"),
  portText: $("portText"),
  serialOut: $("serialOut"),
  monInput: $("monInput"),
  btnMonSend: $("btnMonSend"),
  btnMonClear: $("btnMonClear"),
  monStats: $("monStats"),
  monEcho: $("monEcho"),
  monTimestamps: $("monTimestamps"),
  monAutoscroll: $("monAutoscroll"),
  monSendHex: $("monSendHex"),
  btnResetSettings: $("btnResetSettings"),
  btnClearLog: $("btnClearLog"),
  log: $("log"),
};

const CONFIG_FIELDS = ["cfgBaud", "cfgParity", "cfgNrstLine", "cfgNrstInvert", "cfgBoot0Line", "cfgBoot0Invert", "cfgResetHold", "cfgBootDelay",];
for (const id of CONFIG_FIELDS) els[id] = $(id);

/*
 * Console settings persist like the rest of the form, but are deliberately
 * outside the Connection settings reset: they sit in plain view on the
 * Console tab, so unlike the fields behind the collapsed panel they cannot
 * get stuck somewhere the user is not looking.
 */
const CONSOLE_FIELDS = ["monEcho", "monTimestamps", "monAutoscroll", "monSendHex"];

const state = {
  io: null,
  link: null,
  boot: null,
  demo: null,
  portSettings: null,
  busy: false,
  tab: "demo",
};

/** Fixed for the life of the page: the API is either there or it is not. */
const WEB_SERIAL = isSupported();

/* ------------------------------------------------------------------ log --- */

function log(message, level = "info") {
  const stamp = new Date().toLocaleTimeString([], {hour12: false});
  const line = document.createElement("span");
  line.className = `line ${level}`;
  line.textContent = `[${stamp}] ${message}\n`;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

/* --------------------------------------------------------------- config --- */

const SETTINGS_KEY = "scalpelspace.demo.settings.v1";

function readPins() {
  return {
    ...DEFAULT_PINS,
    nrstLine: els.cfgNrstLine.value,
    nrstInvert: els.cfgNrstInvert.checked,
    boot0Line: els.cfgBoot0Line.value,
    boot0Invert: els.cfgBoot0Invert.checked,
    resetHoldMs: Number(els.cfgResetHold.value) || DEFAULT_PINS.resetHoldMs,
    bootDelayMs: Number(els.cfgBootDelay.value) || DEFAULT_PINS.bootDelayMs,
  };
}

function readPortSettings() {
  return {
    baudRate: Number(els.cfgBaud.value) || 115200, parity: els.cfgParity.value,
  };
}

function saveSettings() {
  const data = {};
  for (const id of [...CONFIG_FIELDS, ...CONSOLE_FIELDS]) {
    const el = els[id];
    data[id] = el.type === "checkbox" ? el.checked : el.value;
  }
  data.chkAnyPort = els.chkAnyPort.checked;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
  } catch {
    /* private mode: settings just do not persist */
  }
}

function loadSettings() {
  let data;
  try {
    data = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
  } catch {
    return;
  }
  if (!data) return;
  for (const [id, value] of Object.entries(data)) {
    const el = els[id];
    if (!el) continue;
    if (el.type === "checkbox") el.checked = Boolean(value); else el.value = value;
  }
}

/**
 * Restore the connection fields to the defaults written in index.html, then
 * drop just those keys from storage. Deleting rather than re-saving them means
 * a later change to a default reaches this browser instead of staying masked
 * by a saved copy of the old one.
 */
function resetSettings() {
  for (const id of CONFIG_FIELDS) {
    const el = els[id];
    if (el.type === "checkbox") {
      el.checked = el.defaultChecked;
    } else if (el.tagName === "SELECT") {
      const fallback = el.querySelector("option[selected]") || el.options[0];
      el.value = fallback.value;
    } else {
      el.value = el.defaultValue;
    }
  }

  let data = {};
  try {
    data = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {};
  } catch {
    data = {};
  }
  for (const id of CONFIG_FIELDS) delete data[id];
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
  } catch {
    /* private mode: nothing was persisted to begin with */
  }

  // Keep an open connection consistent with what the form now shows.
  if (state.boot) state.boot.pins = readPins();
  log("Connection settings reset to defaults", "ok");
}

/* ------------------------------------------------------------------- ui --- */

function setConnState(name, text) {
  els.connStatus.dataset.state = name;
  els.connText.textContent = text;
}

function setBusy(busy) {
  state.busy = busy;
  const connected = state.link !== null;
  els.btnConnect.disabled = busy || connected || !WEB_SERIAL;
  els.btnDisconnect.disabled = busy || !connected;
  els.btnReset.disabled = busy || !connected;
  els.monInput.disabled = busy || !connected;
  els.btnMonSend.disabled = busy || !connected;
}

function updatePortPill() {
  const open = state.portSettings !== null;
  els.portState.dataset.state = open ? "ok" : "idle";
  els.portText.textContent = open ? `${state.portSettings.baudRate} ${framingLabel(state.portSettings.parity)}` : "Port closed";
}

const framingLabel = (parity) => (parity === "even" ? "8E1" : "8N1");

function selectTab(name) {
  state.tab = name;
  for (const [tab, panel, key] of [[els.tabDemo, els.panelDemo, "demo"], [els.tabConsole, els.panelConsole, "console"],]) {
    tab.setAttribute("aria-selected", String(name === key));
    panel.hidden = name !== key;
  }
  // Canvases laid out inside a hidden panel measure zero, so anything drawn
  // while the Console tab was up has to be drawn again on the way back.
  if (name === "demo" && state.demo && state.demo.reflow) state.demo.reflow();
}

/* -------------------------------------------------------------- console --- */

/** Oldest lines are dropped past this; a chatty board would otherwise grow the
 *  DOM without bound. */
const MAX_CONSOLE_LINES = 2000;

function appendConsole(lines, kind) {
  if (!lines.length) return;
  const stamp = els.monTimestamps.checked ? `[${new Date().toLocaleTimeString([], {hour12: false})}] ` : "";
  for (const text of lines) {
    const el = document.createElement("span");
    el.className = `line ${kind}`;
    el.textContent = `${stamp}${text}\n`;
    els.serialOut.appendChild(el);
  }
  while (els.serialOut.childElementCount > MAX_CONSOLE_LINES) {
    els.serialOut.removeChild(els.serialOut.firstChild);
  }
  if (els.monAutoscroll.checked) {
    els.serialOut.scrollTop = els.serialOut.scrollHeight;
  }
}

function updateStats() {
  const {rxBytes = 0, txBytes = 0} = state.link || {};
  els.monStats.textContent = `${rxBytes} B in, ${txBytes} B out`;
}

async function sendConsoleInput() {
  if (!state.link || state.busy) return;
  const text = els.monInput.value;
  try {
    if (els.monSendHex.checked) {
      const bytes = parseHex(text);
      if (!bytes.length) return;
      await state.link.writeBytes(bytes, {echo: hexdumpRow(bytes, 0)});
    } else {
      // An empty line is still a line: it sends just the ending, which is how
      // you nudge a device that is mid-line.
      await state.link.send(text);
    }
  } catch (err) {
    appendConsole([`send failed: ${err.message}`], "error");
    return;
  }
  els.monInput.value = "";
}

function clearConsole() {
  els.serialOut.textContent = "";
}

/* -------------------------------------------------------- product panel --- */

/** What the Demo tab shows with nothing connected: what this page supports. */
function showPlaceholder() {
  const tile = (product) => h("div.repo", null, h("span.repo-name", null, product.id), h("p", null, product.summary), h("div.links", null, product.links.map(({
                                                                                                                                                                label,
                                                                                                                                                                href
                                                                                                                                                              }) => h("a.btn", {href}, label))));

  els.productPanel.replaceChildren(h("section.card", null, //
    h("div.card-head", null, h("h2", null, "No board connected")), //
    h("p.hint", null, "Connect a board to load its demo. The page identifies it by the name " + "its own firmware reports, so there is nothing to choose here."), //
    h("div.repos", null, PRODUCTS.map(tile))));
}

/**
 * The board is connected but there is no demo to show: either it named itself
 * and nothing in the registry answers to that name, or it never answered at
 * all. The two cases need different words - one is a gap in this page, the
 * other is a board that is not talking - so `identity` may be null.
 *
 * @param {{product: string, version: string} | null} identity
 */
function showUnknown(identity) {
  const explanation = identity ? [h("p.hint", null, "The board reports itself as ", h("code", null, identity.product), " firmware ", h("code", null, identity.version), ". This page has no demo for it, but the Console tab talks to it just " + "the same."), h("p.hint", null, "Demos live in ", h("code", null, "src/products/"), " of the ", h("a", {href: "https://github.com/scalpelspace/demo"}, "demo repository"), "; adding one is a module and a line in the registry.")] : [h("p.hint", null, "The port is open but the board did not answer ", h("code", null, "version"), ". It may still be in the bootloader, or the boot lines may be mapped " + "differently - see Connection settings, then Reset device. The " + "Console tab works either way."),];

  els.productPanel.replaceChildren(h("section.card", null, //
    h("div.card-head", null, h("h2", null, identity ? "No demo for this board yet" : "Board did not identify itself")), //
    ...explanation));
}

function unmountProduct() {
  if (state.demo) {
    try {
      state.demo.destroy();
    } catch (err) {
      console.error("demo teardown failed", err);
    }
  }
  state.demo = null;
}

/**
 * Put an identified board on screen: fill in the device facts, then mount its
 * demo or explain why there is not one. The connect flow and the Reset device
 * button both end here; they differ only in how they got the identity, and a
 * null one means the board never answered.
 *
 * @param {{product: string, version: string} | null} identity
 */
function applyIdentity(identity) {
  els.factProduct.textContent = identity ? identity.product : "unknown";
  els.factFirmware.textContent = identity ? identity.version : "-";

  const product = identity ? findProduct(identity.product) : null;
  if (product) {
    mountProduct(product, identity.version);
    log(`${product.name} firmware ${identity.version} is up`, "ok");
    return;
  }
  if (identity) {
    log(`No demo for "${identity.product}" firmware ${identity.version}`, "warn");
  } else {
    log("Hint: check the boot line mapping under Connection settings, and " + "that the board is running application firmware.", "warn");
  }
  showUnknown(identity);
}

function mountProduct(product, version) {
  unmountProduct();
  state.demo = product.create(state.link, {log, version});
  els.productPanel.replaceChildren(state.demo.el);
  // The panel may have been laid out while the Console tab was showing.
  if (state.tab === "demo" && state.demo.reflow) state.demo.reflow();
}

/* ----------------------------------------------------------- connection --- */

/**
 * Bring a freshly opened port to a board that is running its application and
 * willing to answer, then ask it what it is.
 *
 * The reset is not optional. Chrome asserts DTR when it opens a port and, on
 * these boards, DTR is BOOT0 - so the board that just came up is sitting in
 * the STM32 system bootloader, silent to every command. `version` is retried
 * rather than asked once because start-up takes as long as it takes; Momentum
 * renegotiates its GNSS module's baud rate on the way up.
 */
async function identify() {
  try {
    await state.boot.runApplication();
  } catch (err) {
    // A port with no modem line control - a plain USB-UART cable, or a
    // platform that refuses setSignals - can still carry a conversation with
    // a board that is already running. Say so and ask anyway.
    log(`Could not drive the boot lines: ${err.message}`, "warn");
  }
  return state.link.ask("version", parseVersion, {timeout: 900, attempts: 5});
}

async function connect() {
  setBusy(true);
  try {
    const port = await requestPort({anyDevice: els.chkAnyPort.checked});
    const settings = readPortSettings();
    const io = new SerialTransport(port);
    await io.open(settings);

    state.io = io;
    state.portSettings = settings;
    state.link = new DeviceLink(io);
    state.boot = new BootControl(io, readPins());
    io.onError = (err) => {
      log(`Serial read failed: ${err.message}`, "error");
      disconnect();
    };

    state.link.onLine((line) => {
      appendConsole([printableLine(line)], "rx");
      updateStats();
    });
    state.link.onSent((echo) => {
      if (els.monEcho.checked) {
        appendConsole([typeof echo === "string" ? echo : hexdumpRow(echo, 0)], "tx");
      }
      updateStats();
    });

    els.deviceFacts.hidden = false;
    els.factPort.textContent = describePort(port);
    els.factProduct.textContent = "identifying...";
    els.factFirmware.textContent = "-";
    setConnState("ok", `Connected @ ${settings.baudRate} ${framingLabel(settings.parity)}`);
    log(`Connected: ${describePort(port)} @ ${settings.baudRate} baud`, "ok");
    updatePortPill();
    updateStats();

    let identity = null;
    try {
      identity = await identify();
    } catch (err) {
      log(`No version reply: ${err.message}`, "warn");
      setConnState("warn", "Connected, not identified");
    }
    applyIdentity(identity);
  } catch (err) {
    if (err && err.name === "NotFoundError") {
      log("Port selection cancelled");
      await teardown();
      return;
    }
    log(`Connect failed: ${err.message}`, "error");
    setConnState("error", "Connection failed");
    await teardown();
  } finally {
    setBusy(false);
  }
}

/** Drop every connection object without touching the UI copy. */
async function teardown() {
  unmountProduct();
  if (state.link) {
    try {
      await state.link.close();
    } catch (err) {
      log(`Close warning: ${err.message}`, "warn");
    }
  }
  state.link = null;
  state.io = null;
  state.boot = null;
  state.portSettings = null;
  updatePortPill();
  updateStats();
}

async function disconnect() {
  if (!state.link) return;
  await teardown();
  els.deviceFacts.hidden = true;
  setConnState("idle", "Not connected");
  showPlaceholder();
  log("Disconnected");
  setBusy(false);
}

/**
 * Reset the board and re-identify it. Doubles as the recovery path: a board
 * that came up in the bootloader, or that was reflashed while the page held
 * the port open, comes back without unplugging anything.
 */
async function resetDevice() {
  if (!state.link) return;
  setBusy(true);
  unmountProduct();
  els.productPanel.replaceChildren();
  try {
    state.boot.pins = readPins();
    log("Resetting into application...");
    applyIdentity(await identify());
  } catch (err) {
    log(`Reset failed: ${err.message}`, "error");
    applyIdentity(null);
  } finally {
    setBusy(false);
  }
}

/* --------------------------------------------------------------- wiring --- */

function wire() {
  els.btnConnect.addEventListener("click", connect);
  els.btnDisconnect.addEventListener("click", disconnect);
  els.btnReset.addEventListener("click", resetDevice);
  els.tabDemo.addEventListener("click", () => selectTab("demo"));
  els.tabConsole.addEventListener("click", () => selectTab("console"));

  els.btnMonSend.addEventListener("click", sendConsoleInput);
  els.monInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendConsoleInput();
    }
  });
  els.btnMonClear.addEventListener("click", clearConsole);
  els.btnResetSettings.addEventListener("click", resetSettings);
  els.btnClearLog.addEventListener("click", () => {
    els.log.textContent = "";
  });

  for (const id of [...CONFIG_FIELDS, ...CONSOLE_FIELDS, "chkAnyPort"]) {
    els[id].addEventListener("change", saveSettings);
  }
  // Line mapping changes have to reach an open connection, or the next reset
  // would still use the settings the page started with.
  for (const id of ["cfgNrstLine", "cfgNrstInvert", "cfgBoot0Line", "cfgBoot0Invert", "cfgResetHold", "cfgBootDelay"]) {
    els[id].addEventListener("change", () => {
      if (state.boot) state.boot.pins = readPins();
    });
  }

  if (WEB_SERIAL) {
    navigator.serial.addEventListener("disconnect", (e) => {
      if (state.io && e.target === state.io.port) {
        log("Device unplugged", "error");
        disconnect();
      }
    });
  }
}

/**
 * Without Web Serial the page is still worth showing: the layout, the
 * settings and the list of supported products all render, so a visitor on the
 * wrong browser can see what the page does before going to find one that runs
 * it. Only the paths that need a real port are closed off.
 */
function init() {
  loadSettings();
  wire();
  selectTab("demo");
  showPlaceholder();
  updatePortPill();
  updateStats();
  setBusy(false);

  if (WEB_SERIAL) {
    log("Ready. Connect a board to begin.");
  } else {
    // The notice itself is revealed by the inline script in index.html, which
    // runs even when this module cannot.
    setConnState("error", "Web Serial unavailable");
    log("Web Serial API not available in this browser. The interface is " + "shown, but nothing can be connected.", "error");
  }

  // Tells the inline watchdog in index.html that the app came up.
  window.__demoReady = true;
}

init();

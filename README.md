# demo

Web based hardware demos for ScalpelSpace boards, served at
[demo.scalpelspace.com](https://demo.scalpelspace.com).

Plug a board into USB-C, press Connect, and the page asks it `version`. The
board answers with the short name compiled into its own firmware, and that name
selects the demo. Nothing is installed, and no data leaves the machine.

Uses the same Web Serial interface and the same site chrome as
[`blasher`](https://github.com/scalpelspace/blasher).

## Supported products

| Product                                                | Demo                                                                         |
|--------------------------------------------------------|------------------------------------------------------------------------------|
| [`momentum`](https://github.com/scalpelspace/momentum) | Orientation, barometric pressure and temperature, GNSS fix, and the RGB LED. |

Polling starts on its own once a board is identified; there is nothing to switch
on.

The GNSS card is the exception, and starts closed. While it is closed the page
never sends the `gnss` command and discards any position a streaming board sends
unasked, so a shared screen cannot give away where the board is until someone
opens it. Closing it again discards what was read.

Opened, it shows the fix in full plus a track plot: where the board has been in
metres relative to its first fix, drawn from the coordinates alone. There is no
basemap and nothing is fetched, so the plot shows how far a fix wanders without
saying where that is. It needs firmware that prints coordinates to six decimal
places (`momentum` 0.6.0.p and later); the practical floor is the ~0.5 m spacing
of the 32-bit float the firmware stores them in, which is visible on the plot as
a grid once the board sits still.

## Requirements

A desktop browser with
the [Web Serial API](https://developer.mozilla.org/docs/Web/API/Web_Serial_API):
Chrome, Edge or Opera. Firefox and Safari do not implement it. The page must be
served over
`https://` or from `http://localhost`.

## Boot control lines

A ScalpelSpace board wires the CP2102N for hands-free flashing: `DTR` drives
`BOOT0` and `RTS` is AC-coupled to `NRESET`. Chrome asserts `DTR` when it opens
a port, so simply opening one leaves the board sitting in the STM32 system
bootloader, which answers no commands.

So on connect the page releases `BOOT0`, pulses `NRESET`, waits for start-up and
then asks for the version. That is the same line mapping `blasher` and
[`pyblasher`](https://github.com/scalpelspace/pyblasher) use, and it means the
`BOOT0 DTR bridge` jumper does not have to be cut to use the serial interface.
Boards that map or invert the lines differently are handled under **Connection
settings**.

## Structure

Plain static HTML, CSS and ES modules. No build step, no dependencies. GitHub
Pages serves the repository root as-is.

```
index.html                Page chrome, device card, console and settings
assets/css/site.css       Single stylesheet (light and dark via prefers-color-scheme)
assets/css/site-reference.css
                          Verbatim copy of scalpelspace.com's stylesheet, to diff against
src/app.js                Connect flow, board identification, console wiring
src/serial.js             Web Serial transport
src/boot.js               BOOT0 / NRESET control over the modem lines
src/link.js               Line broadcast and request/response over the stream
src/lines.js              Byte stream to lines, and back
src/version.js            The `version` reply every product answers with
src/registry.js           Product short name -> demo module
src/ui.js                 DOM helpers, strip chart, track plot, orientation view
src/products/momentum.js  Momentum demo
dev/                      Development only, not published: static server and a
                          harness that mounts a demo against a fake device
```

### Adding a product

Two files: a new module, and one line in the registry. Nothing else on the page
needs to know the product exists.

**1. Write `src/products/<name>.js`,** exporting a product object:

```js
export const widget = {
  id: "widget",                       // short name, as the firmware reports it
  name: "Widget",                     // shown in the log
  summary: "One sentence for the disconnected page.",
  links: [{label: "Firmware", href: "https://github.com/scalpelspace/widget"}],
  matches: (shortName) => shortName === "widget",
  create: (link, ctx) => new WidgetDemo(link, ctx),
};
```

`matches` receives the lower-cased name from the `version` reply, so one module
can claim several names (a `widget` and a `widget_pro`, say).

**2. `create(link, ctx)` returns the demo.** `ctx` is `{log, version}`; `link`
is the [`DeviceLink`](src/link.js) for the open port:

|                               |                                                            |
|-------------------------------|------------------------------------------------------------|
| `link.onLine(fn)`             | every complete line from the board; returns an unsubscribe |
| `link.send(text)`             | one command line, fire and forget                          |
| `link.ask(text, match, opts)` | send and resolve with the first reply `match` accepts      |

The returned object needs `el` (the panel element) and `destroy()` (drop timers
and unsubscribe - it is called on disconnect and on Reset device). Add
`reflow()` if it draws to a canvas, so it can redraw after the Demo tab becomes
visible again, since a canvas laid out inside a hidden panel measures zero.

**3. Add it to `PRODUCTS`** in [`src/registry.js`](src/registry.js).

Reusable pieces live in [`src/ui.js`](src/ui.js): `h()` for markup, `facts()`
for readout rows, `StripChart`, `TrackPlot` and `OrientationView`. Styling is
shared too - a demo that uses `.demo-grid`, `.card` and `.facts` needs no new
CSS.

Test it without hardware by teaching `dev/harness.html` to answer the new
product's commands.

## Local Preview

The Web Serial API and ES modules both need a real origin, so `file://` will not
work. Any static file server does, for example:

```bash
python -m http.server 8125
```

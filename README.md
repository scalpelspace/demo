# demo

Web based hardware demos for ScalpelSpace boards, served at
[demo.scalpelspace.com](https://demo.scalpelspace.com).

Plug a board into USB-C, press Connect, and the page asks it `version`. The
board answers with the short name compiled into its own firmware, and that name
selects the demo. Nothing is installed, and no data leaves the machine.

With nothing connected, each supported product has a **Preview demo** button
that opens its panel empty - the real panel, built by the real module, just with
no device behind it.

Uses the same Web Serial interface and the same site chrome as
[`blasher`](https://github.com/scalpelspace/blasher).

## Supported products

| Product                                                    | Demo                                                                                           |
|------------------------------------------------------------|------------------------------------------------------------------------------------------------|
| [`momentum`](https://github.com/scalpelspace/momentum)     | Orientation, barometric pressure and temperature, GNSS fix, and the RGB LED.                   |
| [`mc_stepper`](https://github.com/scalpelspace/mc_stepper) | Control state, shaft angle, setpoints, TMC2209 status and StallGuard, motion and PID settings. |

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

### Adding a product

Two files: a new module, and one line in the registry. Nothing else on the page
needs to know the product exists.

**1. Write `src/products/<name>.js`,** exporting a product object:

```js
export const widget = {
  id: "widget",                       // short name, as the firmware reports it
  name: "Widget",                     // shown in the log
  summary: "One sentence for the tile on the disconnected page.",
  matches: (shortName) => shortName === "widget",
  create: (link, ctx) => new WidgetDemo(link, ctx),
};
```

`matches` receives the lower-cased name from the `version` reply, so one module
can claim several names (a `widget` and a `widget_pro`, say).

**2. `create(link, ctx)` returns the demo.** `ctx` is
`{log, version, preview}`; `link` is the [`DeviceLink`](src/link.js) for the
open port:

|                               |                                                            |
|-------------------------------|------------------------------------------------------------|
| `link.onLine(fn)`             | every complete line from the board; returns an unsubscribe |
| `link.send(text)`             | one command line, fire and forget                          |
| `link.ask(text, match, opts)` | send and resolve with the first reply `match` accepts      |

The returned object needs `el` (the panel element) and `destroy()` (drop timers
and unsubscribe - it is called on disconnect and on Reset device). Add
`reflow()` if it draws to a canvas, so it can redraw after the Demo tab becomes
visible again, since a canvas laid out inside a hidden panel measures zero.

`ctx.preview` is set when the panel is mounted from a **Preview demo** button on
the disconnected page. There is no device behind the link, so honour it by
skipping whatever the module would otherwise send on mount - the panel then
renders empty, which is the point.

**3. Add it to `PRODUCTS`** in [`src/registry.js`](src/registry.js).

Reusable pieces live in [`src/ui.js`](src/ui.js): `h()` for markup, `facts()`
for readout rows, and `StripChart`, `TrackPlot`, `DialGauge` and
`OrientationView` for canvases. Styling is shared too - a demo built from
`.demo-grid`, `.card` and `.facts` needs no new CSS.

Test it without hardware by adding a fake device to `dev/harness.html`, which
mounts any registered product against one and takes `?product=<id>`. Model how
the firmware refuses things, not just how it succeeds - both existing fakes do,
and it is what caught the queueing bug in the stepper demo.

## Local Preview

The Web Serial API and ES modules both need a real origin, so `file://` will not
work. Any static file server does, for example:

```bash
python -m http.server 8125
```

**English** | [简体中文](../USAGE.md) | [繁體中文](../zh-TW/USAGE.md) | [日本語](../ja/USAGE.md)

← Back to [README](../../README.md)

# User guide

This guide explains every laPower interface control, setting and file format. The project was formerly named WITRN-RS; the new app uses a separate settings directory. Existing CSV and older PD capture files can be imported directly. Quoted labels refer to the application's interface.

- [Interface overview](#interface-overview)
- [Monitor workspace](#monitor-workspace)
- [PD analysis workspace](#pd-analysis-workspace)
- [POWER-Z protocol control](#power-z-protocol-control)
- [Settings](#settings)
- [File formats](#file-formats)
- [Frequently asked questions](#frequently-asked-questions)

## Language selection

In **Settings → Appearance → Language**, choose Follow system, 简体中文, 繁體中文, English or 日本語. Changes take effect immediately and are saved, preserving the connection, recording, data, chart range, filters and selected message. Resetting settings restores automatic selection.

Linux uses the first non-empty variable in LC_ALL → LC_MESSAGES → LANG order; Windows/macOS use the native system locale. If native detection is unavailable, the WebView preferred language is used, with English as the final fallback. Hans selects Simplified Chinese and Hant Traditional Chinese before considering regions; otherwise CN/SG and bare zh select Simplified Chinese, TW/HK/MO Traditional Chinese, and ja Japanese. All other locales, including C/POSIX, select English. Case, underscores, encoding and modifier suffixes are normalized. Manual selection overrides detection.

```bash
LANG=en_US.UTF-8 ./laPower.AppImage
LC_ALL=ja_JP.UTF-8 ./laPower.AppImage
env -u LC_ALL LC_MESSAGES=zh_TW.UTF-8 LANG=en_US.UTF-8 ./laPower.AppImage
```

## Interface overview

The window has three layers: the **title bar** (tabs and device connection), the **workspace** (the current tab) and the **status bar**.

### Title bar

The title bar also acts as the tab strip. Monitor, PD analysis and Settings are always available; connecting a POWER-Z adds Protocol control:

| Tab | Contents |
| --- | --- |
| `Monitor` | Live readings, chart, recording and import/export |
| `PD analysis` | USB-PD message list and field-by-field decoding |
| `Protocol control` (POWER-Z only) | PDM, PDO, protocol detection and voltage requests |
| `Settings` (gear icon) | Appearance, charts and recording, device VID/PID/SN and About |

On the right is the **persistent device connection area**: a device selector, refresh button and a state-dependent `Connect` / `Disconnect` button. It remains available in every tab. The same button displays `Connect` while disconnected and `Disconnect` after connection.

Device names use these formats:

```text
WITRN K2                                    USB port could not be resolved
WITRN K2 (USB 4-4)                          USB topology port resolved
WITRN K2 (USB 4-4) [Interface 0 / Usage 0xFF00]   Multiple HID interfaces on one device
```

The interface suffix appears only if multiple HID interfaces remain after filtering a physical device. WITRN devices with an unrecognized PID appear as `Unknown WITRN device (0716:XXXX)`.

### Status bar

The bottom bar displays `Recording:` (current state, **click to start or pause**), `Duration:` (accumulated recording duration), `Sample:` (sample rate), `Points:` (total acquired points), and the connection indicator (`Connected` / `Disconnected`) on the right. Clicking `Recording:` while disconnected does not start recording.

## Monitor workspace

### Command bar

| Control | Description |
| --- | --- |
| `Start recording` / `Continue recording` / `Pause recording` | Starts or pauses recording. With no data, the label is `Start recording`; with existing or imported data, `Continue recording` appends to the current timeline without clearing it; while recording, it becomes `Pause recording` |
| `Sample rate` | Selector; see the table below |
| `Export CSV` | Menu: `Without temperature` / `With temperature`. On narrow command bars, export, import and reset move into the right-hand `⋯` overflow menu |
| `Import CSV` | Loads a previously exported CSV; recording can continue from its last time point |
| `Reset` | Clears the chart and resets statistics and integrated energy |
| `⋯` | Appears when space is insufficient; contains export, import and reset |
| `Display` | Opens the channel display flyout |
| `Auto pause` | Toggle and gear button for its configuration flyout |
| `Temperature service` | Toggle and gear button for configuration; see [External temperature service](TEMPERATURE.md) |

Sample-rate presets, with the actual millisecond interval also used by CSV `SampTime(ms)`:

| Label | Interval |
| --- | --- |
| `100 samples/s` | 10 ms |
| `10 samples/s` | 100 ms |
| `4 samples/s` | 250 ms (default) |
| `2 samples/s` | 500 ms |
| `1 sample/s` | 1000 ms |
| `0.2 samples/s (1 every 5s)` | 5000 ms |
| `0.1 samples/s (1 every 10s)` | 10000 ms |

Selecting a POWER-Z KM003C/KM002C adds `1000 samples/s` (1 ms). This uses AdcQueue with a 1 kHz device timebase; parallel ADC snapshots supply temperature. If authentication or firmware does not support the queue, the app falls back to `100 samples/s` and explains why. WITRN HID devices always use intervals of at least 10 ms.

The backend `set_sample_rate` accepts any interval from 1–60000 ms, subject to the device minimum. CSV import uses per-point intervals, the summary interval or an estimate from timestamps. It does not overwrite the persisted rate; the selector still shows the interval for the next live recording.

The rate also determines **which gaps energy integration excludes**: an interval between adjacent points greater than `max(2 seconds, 8 × sample interval)` is excluded (for example, sleep, NTP adjustments or missed samples). At 0.2/0.1 samples/s, the tolerance is therefore 40/80 seconds, so normal slow sampling is not mistaken for a gap.

### Reading cards

The left panel is resizable (200–360 px; default 250 px); dragging the divider on its right saves the width. The four main cards (voltage/current/power/temperature) share this structure:

- A title with the channel's color dot and name.
- A rounded **horizontal level bar** around the current reading. Background and fill use lighter and stronger shades of the channel color. The range automatically follows the observed session maximum using 1-2-5 steps, and fills left to right. The large, centered reading occupies most of the bar and uses the normal text color.
- Three statistics: `Min` / `Average` / `Max`.

Additional card behavior:

- **Current** — With signed current enabled, an arrow before the value indicates direction.
- **Temperature** — Hidden when no temperature source is available; missing readings are `--`. A `Device` source follows the meter lifecycle: unplugging/disconnecting removes the source, resets readings to `--` and the `Temperature service` toggle, and unlocks `Source`. An `External` TCP session remains independent of the meter connection.
- **Energy (Wh) and Capacity (mAh)** — Integrated from samples in software, rather than read from the meter's accumulator. Each has an automatically scaled horizontal mini bar. **Only `Reset` zeroes them.** Continuing after a pause retains totals and excludes the pause from integration. Gaps over `max(2 seconds, 8 × sample interval)` are also excluded, as described above.
- **Signal lines** — D+ / D- / CC1 / CC2 each have a name, value and horizontal mini bar. Values show two decimal places; actual resolution depends on the device, with WITRN CC1/CC2 at 0.1 V.

An empty chart displays “Connect a device, then start recording”. It disappears once recording writes its first point.

### `Display` flyout

- Each main curve (`Voltage` / `Current` / `Power` / `Temperature`) has a visibility checkbox and **fill opacity** input (0 = no fill; 1–100 = fill enabled; default 15).
- `D+ / D-` overlays two signal curves using the voltage axis. Off by default.
- `CC1 / CC2` does the same, using the voltage axis. Off by default.
- `Selected range only` limits card minimum/maximum/average and integrated energy/capacity to the timeline's selected range. Off by default. Non-finite values (blank, `NaN` or `Inf` in imported CSV) are excluded from minimum/maximum/average, and an average tooltip reports the excluded count. The “(N points)” in `Range` still counts all original rows in the range, rather than only valid values.

### `Auto pause` flyout

For unattended tests, recording pauses after the selected measurement remains below a threshold for a continuous duration.

| Field | Values |
| --- | --- |
| `Condition` | `None` (default, disabled) / `Voltage <` / `Current <` / `Power <` |
| `Threshold` | Numeric value; unit follows the condition |
| `Hold duration` | Seconds; the condition must hold continuously for this long |

### Chart and timeline

The main chart draws up to eight curves on four shared Y axes: **current (A)**, **voltage (V)**, **power (W)** and **temperature (°C)**, with strictly aligned ticks. D+ / D− / CC1 / CC2 use the voltage axis.

- **Tooltip** — Hover shows all channels at that time and relative time (`HH:MM:SS.d`).
- **Legend** — Click a channel name to hide that curve temporarily.
- **Timeline navigator** — Drag the bottom overview's end handles to select a range, or drag the highlighted middle to pan while preserving the span. The middle shows `Duration:` and the range's point count.
- **Mouse-wheel horizontal zoom** — Scroll over the main chart to zoom around the time at the cursor: up/forward zooms in, down/back zooms out. During recording, a window whose right edge meets the latest point follows new data with a fixed duration; a historical window stays in place. The navigator follows the zoom, and pausing/continuing retains the current window.
- Dense data uses incremental min/max pixel buckets, while full data stays in column storage. Hover uses binary search to retrieve real original samples. History preserves detail at the actual canvas pixel resolution, including high DPI, with the same projection while dragging and after release. At no more than one sample per canvas pixel, it restores original points plus neighbors on either side of the window.

At 1000 samples/s, automatic drawing is about 20 fps by default and can fall to about 10 fps under load. Handle dragging, range panning, wheel zoom and keyboard adjustments refresh independently, committing the final window on release. Healthy 100 samples/s rendering does not drop to a fixed lower rate just because history grows. Refresh rate affects display only; samples, CSV, statistics and energy integration remain complete. Recording and history rendering have separate budgets. Slow history frames may temporarily disable area fill and use pixel-column drawing while preserving curve detail.

## PD analysis workspace

### Command bar

| Control | Description |
| --- | --- |
| `Start recording` / `Pause` | Start/pause recording in follow mode; in independent mode, pause list updates while messages continue buffering |
| `Clear` | Clears the message list |
| `Export` / `Import` | Saves/loads PD capture JSON |
| `Filter by message type…` | Text filter matching message type names |
| `Hide GoodCRC` | Hides link-layer acknowledgements, often more than half the frames, to improve readability |
| `Auto scroll` | Scrolls to the bottom when a message arrives |
| `Follow recording` | Links to monitoring; see below |
| Split direction | At window widths ≥ 1400 px, use a side-by-side split (about 55% list / 45% details). The preference is saved; narrow windows still use stacked panes |

The command bar's right side shows the message count and state, for example `356 messages / Waiting for recording`.

#### `Follow recording` (on by default)

When enabled, PD analysis and monitoring are **fully linked**:

- Capture only while Monitor is recording; other messages are discarded without buffering.
- The left start/pause button also controls monitoring recording.
- Clearing either view clears both the chart and messages.

When disabled, PD capture, pause and clear operate independently.

### Message list

| Column | Meaning |
| --- | --- |
| `#` | Sequence number |
| `Elapsed` | Time relative to the first frame, in milliseconds |
| `SOP` | Start sequence, such as `SOP` (end-to-end) / `SOP'` (to cable chip) |
| `Msg` | Message type badge, colored by category |
| `ID` | Message ID, cycling 0–7 |
| `Direction` | Role/direction badge: `SRC → SNK`, `SRC ← SNK`, `SRC\|SNK → Plug` |
| `Obj` | Number of Data Objects |
| `Rev` | USB-PD specification revision |
| `V/I` | Latest meter voltage/current sample; not necessarily simultaneous with the message |
| `Summary` | Quick summary |

`Summary` helps locate negotiation steps quickly. Typical contents:

```text
Fixed: 5.0V 9.0V 12.0V 15.0V 20.0V SPR AVS: 9-15V@3.0A 15-20V@5.0A PPS: 5.0-21.0V
Position:1 Fixed:5.0V,3.0A
Position:7 PPS:8.0V,3.45A
0xFF00 Discover Identity REQ
```

Source_Capabilities lists all advertised charger profiles; Request shows the selected position and requested voltage/current.

### Detail pane

Click a message to expand it into three layers:

1. **Raw data** — Hex values for `SOP*`, `Msg Header` and `Data Object 0..N`.
2. **Header fields** — `Extended` / `Objects` / `Msg ID` / `Power Role` / `Spec Rev` / `Data Role` / `Msg Type`.
3. **PDO/RDO bit fields** — For example, `PDO 1 5.0V,3.0A FPDO 0x0A81912C` expands into values for `Supply Type`, `Dual-Role Power`, `USB Suspend Supported`, `Unconstrained Power`, `USB Communications Capable`, `Dual-Role Data`, `Unchunked Extended Messages Supported`, `EPR Capable`, `Peak Current`, `Voltage` and `Maximum Current`.

> **Capture tip:** The **instant a charger is plugged in or unplugged** is the most informative. The Discover Identity → Source_Capabilities → Request → Accept → PS_RDY handshake completes in the first few tens of milliseconds. Starting after negotiation usually reveals only periodic PPS adjustments.

## POWER-Z protocol control

Connecting a POWER-Z KM003C/KM002C adds the `Protocol control` tab. It uses the device's virtual serial port for PDM, PDO reads, PD/PPS/AVS requests, QC/FCP/SCP/UFCS detection and cancellation. Live voltage/current/power still comes from the same device's Bulk stream. Click `Cancel` during a command; disconnecting or Bulk reconnection automatically ends the current PDM session.

WITRN devices do not show this tab or receive control commands.

## Settings

Open settings with the gear button in the title bar. On macOS, you can also press ⌘, or choose “Settings…” from the application menu. The main settings list is on the left; device and About information appear on the right in wide windows.

### Appearance

| Setting | Control | Default |
| --- | --- | --- |
| `Theme` | `Follow system` / `Light` / `Dark` | Follow system |
| `Language` | `Follow system` / `简体中文` / `繁體中文` / `English` / `日本語`; automatic mode shows the effective language | Follow system |
| `Window style` | `Follow platform` / `Windows style` / `macOS style` (Windows / Linux only) | Follow platform |
| `UI scale` | Slider, 50–200% | 100% |

UI scale resizes the whole interface, including chart and title bar. Lower it if system scaling crowds the window. It applies when dragging ends, avoiding repeated layout changes while dragging. On macOS, the native traffic lights keep their size and the title bar reserves fixed space for them.

On first run and after resetting settings, the theme follows OS appearance. Existing choices are retained. `Follow platform` selects the platform title-bar style independently of the light/dark theme. macOS uses native traffic lights for full screen, tiling and minimization. Double-clicking empty title-bar space follows the Desktop & Dock setting, so the window-style option is hidden on macOS.

### Charts and recording

| Setting | Control | Default |
| --- | --- | --- |
| `Chart headroom` | `Automatic` / `Custom` and percentage | Automatic (≈ 25%) |
| `Record current direction` | Toggle | Off |
| `Recording limit` | Numeric input, 64–8192 MB | 512 MB |
| `Keep temporary recovery files` | Toggle | On |
| `Reset all settings` | Button | — |

- **Chart headroom** — Leaves blank space above curves, keeping them in the upper-middle area rather than against the top. `Custom` accepts 0–100%.
- **Record current direction** — New recordings/imports keep the sign (positive forward, negative reverse) and show arrows; disabled recording stores absolute values. **Existing data is not rewritten.** Export follows the values actually recorded.
- **Recording limit** — Estimated from memory and CSV row sizes. Recording pauses at the limit; the status bar shows estimated remaining time.
- **Keep temporary recovery files** — Writes to the app cache about once per second. Recover/delete unfinished recordings in Settings. Normal clear/import/exit removes files after successful synchronization; failed writes/synchronization retain them and report an error. Long-term storage still requires CSV export.
- **Reset all settings** — Restores language, sample rate, channels, UI scale, auto pause, temperature and other defaults. Success is reported only after saving to disk. If antivirus or a sync drive holds `settings.json`, an error is shown: the interface has reset, but restarting would roll it back. Notifications appear once per failure period rather than on every control's autosave.

### Device

Displays the connected device's `VID` / `PID` / `SN` from enumeration without interrupting the data stream.

> WITRN USB serial numbers identify a **manufacturing batch date**, rather than an individual unit. Two meters from the same batch can share a serial number. The title-bar list therefore includes USB ports to distinguish identical models on different ports.

### About

The icon appears above the version, followed by `Version` / `License` / `Repository` and third-party notices: uPlot (MIT) · Fluent System Icons (MIT).

## File formats

### CSV

Export has four metadata lines, one blank line, a header and data rows:

```csv
SUM,1
TotalTime,="00:00:00.000"
SampTime(ms),250
DateTime,2026-08-23 00:15:42

Time(D.hh:mm:ss.ms),Voltage(V),Current(A),Power(W),Temp(°C),D+(V),D-(V),CC1(V),CC2(V),RelativeTime(s),Timestamp(ms),RecordingSegment,SampleInterval(ms),
="00:00:00.000",9.0991,0.0646,0.58820186,31.5,0.61,0.02,0.5,1.6,0,1787415342000,1,250,
```

- `Without temperature` omits **`Temp(°C)` from both header and data**, keeping other columns.
- `="HH:MM:SS.mmm"` makes Excel interpret time as text rather than a date. After a day, a day prefix appears: `="1.02:03:04.500"`.
- Numeric columns use round-trip decimal text with original precision and current sign, without truncation to the UI's decimal places. Missing values are blank; actual device resolution varies by channel/model.
- `RelativeTime(s)` stores precise relative seconds; `Timestamp(ms)` stores the absolute timestamp. Optional `RecordingSegment` distinguishes recording segments and excludes pauses from integration. `SampleInterval(ms)` stores per-point intervals for mixed rates. Legacy files lacking these trailing columns remain importable.
- Missing signal values are blank; **older files without the four signal columns remain importable**. Import matches header names independently of column order.

### PD capture

Export uses a JSON envelope:

```json
{
  "app": "laPower",
  "kind": "pd-capture",
  "version": 2,
  "exportedAt": "2026-08-23T00:15:42.000Z",
  "entries": []
}
```

`version: 2` is the current compact format; the older tree format (`version: 1`) can still be imported. Import validates `kind` and `version`, giving an explicit error on mismatch.

Imported and live messages use different log generations, so historical captures do not mix their IDs with the current live stream.

## Frequently asked questions

### Device not recognized

- Refresh and check whether it appears in the selector.
- WITRN enumeration uses VID `0x0716`, so WITRN devices should appear. If none do, check for a power-only cable or port.
- Unplug and reconnect.

### Connection fails

- Check whether another meter application is using the device; two programs cannot exclusively open the same HID interface.
- Close other WITRN applications and retry, or restart laPower.

### Linux finds no devices

This is usually a **permission issue**. `hidapi` must open `/dev/hidrawN`, typically accessible only by root by default. The app can start normally with an empty device list and no error for a regular user.

See [Development and build · udev rules](DEVELOPMENT.md#udev-rules-required).

### Unattended long recordings on macOS

- While recording, laPower prevents idle system sleep. The display can still turn off; pausing or stopping recording releases the sleep assertion. Acquisition without recording follows the system sleep settings.
- Closing the lid or choosing Sleep still puts the Mac to sleep. Do neither during a recording.
- On macOS 14+, minimizing, hiding or covering the window does not suspend acquisition. macOS 12–13 cannot disable WKWebView background throttling, so keep the window visible for long recordings.

### Incorrect or missing measurements

- Check the [supported device list](../../README.md#-supported-devices). Unknown WITRN devices work only if their firmware uses a compatible report layout.
- The parser rejects wrong frame headers or voltage/current far outside physical limits. Incompatible firmware therefore typically yields “connected but no data”, rather than incorrect readings.

### Temperature stays at `--`

- The default source is `External` (TCP). For the meter's sensor, change `Source` to `Device` in the `Temperature service` flyout.
- For TCP, check address, port and plain numeric lines with a newline. See [External temperature service](TEMPERATURE.md).
- Temperature offsets are verified on only some models. Out-of-range temperature is treated as missing without discarding the whole measurement, so voltage/current can work while temperature remains `--`.

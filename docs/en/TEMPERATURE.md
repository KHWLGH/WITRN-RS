**English** | [简体中文](../TEMPERATURE.md) | [繁體中文](../zh-TW/TEMPERATURE.md) | [日本語](../ja/TEMPERATURE.md)

← Back to [README](../../README.md)

# External temperature service

laPower supports two temperature sources: **the meter's sensor** or **an external sensor over TCP**. WITRN temperature comes from HID reports; POWER-Z uses ADC snapshots. External sources let you record, chart and export thermocouple, infrared or other sensor readings alongside voltage/current.

- [Selecting a source](#selecting-a-source)
- [Protocol](#protocol)
- [Example servers](#example-servers)
- [Troubleshooting](#troubleshooting)

## Language selection

In **Settings → Appearance → Language**, choose Follow system, 简体中文, 繁體中文, English or 日本語. Changes take effect immediately and are saved, preserving the connection, recording, data, chart range, filters and selected message. Resetting settings restores automatic selection.

Linux uses the first non-empty variable in LC_ALL → LC_MESSAGES → LANG order; Windows/macOS use the native system locale. If native detection is unavailable, the WebView preferred language is used, with English as the final fallback. Hans selects Simplified Chinese and Hant Traditional Chinese before considering regions; otherwise CN/SG and bare zh select Simplified Chinese, TW/HK/MO Traditional Chinese, and ja Japanese. All other locales, including C/POSIX, select English. Case, underscores, encoding and modifier suffixes are normalized. Manual selection overrides detection.

```bash
LANG=en_US.UTF-8 ./laPower.AppImage
LC_ALL=ja_JP.UTF-8 ./laPower.AppImage
env -u LC_ALL LC_MESSAGES=zh_TW.UTF-8 LANG=en_US.UTF-8 ./laPower.AppImage
```

## Selecting a source

In the `Monitor` command bar, click the gear beside `Temperature service` to open configuration:

| Field | Description | Default |
| --- | --- | --- |
| `Source` | `Device` = meter sensor; `External` = TCP temperature service | `External` |
| `IP` | Server address (external source only) | `127.0.0.1` |
| `Port` | Server port (external source only) | `1573` |

Use the command-bar `Temperature service` toggle to connect/disconnect. Connection controls are not in the flyout. **Source selection is locked while connected**; disconnect before changing it.

`Device` requires no external program and uses the meter's temperature field. This field is verified on only some models. The parser treats untrustworthy values as missing, displayed as `--`.

A `Device` source follows the meter lifecycle: disconnecting/unplugging removes it, clears live readings to `--`, resets the `Temperature service` toggle and unlocks `Source`. The backend emits `temp-disconnected` only for TCP, since the device source has no separate session to close; the frontend handles its removal when meter connection state changes. Recorded temperature curves and the temperature-data flag remain intact. The `External` TCP session is independent of the HID stream and survives unplugging the meter.

Once connected, the card shows the current temperature and `Average` / `Min` / `Max`; the chart uses its fourth Y axis. `Export CSV` → `With temperature` writes it to `Temp(°C)`.

## Protocol

The protocol is deliberately minimal; a server takes only a few lines in any language.

- **Transport:** TCP, with the server listening and laPower connecting as a client.
- **Format:** one plain decimal number per line, ending in `\n`, in degrees Celsius.
- **No handshake, heartbeat or frame header.**

```
25.125\n
25.250\n
24.875\n
```

### Behavior details

- **Five-second connection timeout.** Addresses are fully resolved; IPv4 is tried before IPv6.
- **No fixed sending interval.** Reads use a 250 ms timeout loop; a timeout continues waiting instead of disconnecting. **Intervals over ten seconds are valid**, and the connection stays open while idle.
- **Partial lines are retained.** A read timeout can return partial data. The buffer is cleared only after a complete line is processed, so TCP fragmentation does not produce invalid values.
- **Lines exceeding 256 bytes are discarded** to prevent an unterminated stream from growing the buffer indefinitely.
- **Server close/EOF** notifies the application and updates connection state.

## Example servers

The repository includes two Python examples with no third-party dependencies:

| File | Purpose |
| --- | --- |
| [`temperature-example/network_server.py`](../../temperature-example/network_server.py) | Sends a random temperature between 0 and 100 once per second |
| [`temperature-example/network_client.py`](../../temperature-example/network_client.py) | Standalone client for checking the server |

Start the server (its console messages are in Simplified Chinese):

```bash
python temperature-example/network_server.py
```

```
温度服务器启动，监听 127.0.0.1:1573
等待客户端连接...
```

In the app, select `Source` → `External`, keep the default `127.0.0.1:1573`, and connect with the command-bar `Temperature service` toggle.

### Implementing your own server

Replace the sample generator with a real sensor read. The core is just:

```python
import socket

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("0.0.0.0", 1573))
server.listen(1)

conn, addr = server.accept()
while True:
    temperature = read_your_sensor()      # returns a float
    conn.sendall(f"{temperature}\n".encode())
```

For a remote server, bind to `0.0.0.0` and enter the server's actual IP in the app.

## Troubleshooting

**Connection timeout** — Check address/port. On another machine, bind the server to `0.0.0.0` rather than `127.0.0.1` and allow the port through its firewall.

**Connected but temperature stays `--`** — Send only a number followed by a newline. Units (`25.1°C`), JSON wrappers or values without newline separation are invalid. Both LF and CRLF line endings work.

**Jumping or clearly incorrect values** — Check for several numbers on one line without a newline. Lines over 256 bytes are discarded entirely.

**Cannot change `Source`** — It is locked while the temperature service is connected. Disconnect first.

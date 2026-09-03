# homebridge-wattbox

[![NPM Version](https://img.shields.io/npm/v/homebridge-wattbox.svg)](https://www.npmjs.com/package/homebridge-wattbox)
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

# WattBox Homebridge Platform Plugin

[WattBox](https://www.snapav.com/shop/en/snapav/wattbox) plugin
for [Homebridge](https://github.com/homebridge/homebridge).

## Models Supported

- WB-300
- WB-300VB
- WB-700
- WB-700CH
- WB-800 series (via the Integration Protocol, see below)

## Transports

WattBox devices expose one of two control interfaces depending on firmware:

- **Integration Protocol** — a line-based TCP interface (default port `23`) used by
  current OvrC firmware (e.g. the WB-800 series). This is the recommended interface.
- **Legacy HTTP/XML API** — `wattbox_info.xml` / `control.cgi` over HTTP, used by older
  firmware.

The `transport` option selects which to use:

- `auto` (default) — probe the Integration Protocol first, then fall back to the HTTP API.
- `integration` — force the Integration Protocol.
- `http` — force the legacy HTTP/XML API.

For the Integration Protocol, set `address` to a bare host or `host:port`
(e.g. `192.168.1.100`) and optionally `port` (defaults to `23`). For the HTTP API, set
`address` to a URL (e.g. `http://192.168.1.100`).

## Configuration

### Required Configuration

```json
{
  "platforms": [
    {
      "platform": "WattBox",
      "name": "WattBox",
      "address": "192.168.1.100",
      "transport": "auto",
      "username": "wattbox",
      "password": "wattbox"
    }
  ]
}
```

### Optional Configuration

#### Include/Exclude Outlets

Outlets can be included or excluded by name:

```
{
  "platforms": [
    {
      // ... required config, see above
      "includeOutlets": ["<name>"], // Defaults to null
      "excludeOutlets": ["<name>"] // Defaults to null
    }
  ]
}
```

### Advanced Configuration

These config values should not be configured under normal situations, but are
exposed nonetheless. Min, max, and default values are enforced to keep the
plugin usable.

#### Status Cache TTL

The time to live (in seconds) for a cached status to avoid excessive API calls:

```
{
  "platforms": [
    {
      // ... required config, see above
      "outletStatusCacheTtl": <seconds>>, // Defaults to 15
    }
  ]
}
```

#### Status Poll Interval

The polling interval (in milliseconds) to query the API for status changes:

```
{
  "platforms": [
    {
      // ... required config, see above
      "outletStatusPollInterval": <milliseconds>>, // Defaults to 15000
    }
  ]
}
```

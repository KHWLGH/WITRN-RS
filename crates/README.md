# Protocol crates

`usbpd-parser` and `witrn-hid` originated in the standalone `WITRN-API-RS`
repository (last imported at its commit `30c4bdb`). That repository has been
retired: both crates are now maintained here, versioned together with the
application through `workspace.package.version`, and are not published
independently (`publish = false`).

The application integration adds numeric `GeneralSample` decoding and a
caller-owned `decode_pd_report` entry point. The HID device wrapper remains
available for API compatibility, but `src-tauri` deliberately keeps ownership of
its existing device handle and background thread.

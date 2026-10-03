# km003c

POWER-Z KM003C / KM002C protocol support for laPower.

This workspace-only crate provides:

- Interface 0 Vendor Bulk transport for ADC and USB-PD capture;
- AES authenticated AdcQueue streaming, including 1000 samples per second;
- CDC text protocol control for PDM, PDO and charging protocol requests.

The crate does not depend on Tauri. Device access is owned by the application runtime.

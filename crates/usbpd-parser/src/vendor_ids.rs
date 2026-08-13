//! USB-IF vendor-ID lookup, used by the renderer to name a `VID` field's owner.

#[cfg(feature = "vendor-ids")]
mod table;

/// Look up the manufacturer behind a USB vendor ID.
///
/// `vid` is the field's rendered form, `"0x1234"` with uppercase hex digits — the
/// same text [`Metadata::value`](crate::Metadata::value) carries.
///
/// Always `None` without the `vendor-ids` feature.
///
/// ```
/// # #[cfg(feature = "vendor-ids")] {
/// use usbpd_parser::vendor_name;
/// assert_eq!(vendor_name("0x05AC"), Some("Apple"));
/// assert_eq!(vendor_name("0xFFFF"), None);
/// # }
/// ```
pub fn vendor_name(vid: &str) -> Option<&'static str> {
    #[cfg(feature = "vendor-ids")]
    {
        table::VENDOR_IDS
            .binary_search_by_key(&vid, |(id, _)| id)
            .ok()
            .map(|i| table::VENDOR_IDS[i].1)
    }
    #[cfg(not(feature = "vendor-ids"))]
    {
        let _ = vid;
        None
    }
}

#[cfg(all(test, feature = "vendor-ids"))]
mod tests {
    use super::*;

    #[test]
    fn the_table_is_sorted_so_binary_search_is_valid() {
        assert!(table::VENDOR_IDS.windows(2).all(|w| w[0].0 < w[1].0));
    }

    #[test]
    fn looks_up_known_and_unknown_ids() {
        assert!(vendor_name("0x05AC").is_some());
        assert_eq!(vendor_name("not a vid"), None);
        // Lookup is case-sensitive on the rendered uppercase form.
        assert_eq!(vendor_name("0x05ac"), None);
    }
}

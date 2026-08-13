//! Bit-string, slicing and number-formatting primitives.
//!
//! The parser represents every field's `raw` as a string of `'0'`/`'1'` characters,
//! exactly like the Python original — that is part of the public data model, not an
//! implementation detail, so [`Metadata::raw`](crate::Metadata::raw) can hand it back
//! verbatim.

use crate::error::{ParseError, Result};

/// Byte order used when flattening bytes into a bit string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Order {
    /// Bytes in wire order — the original's `lst2str(data, '>')`.
    ///
    /// A whole PD message is stored big-endian, so container nodes use this.
    Big,
    /// Bytes reversed — the original's `lst2str(data, '<')` (the default there).
    ///
    /// A single logical field (a PDO, a 16-bit header) is stored little-endian, so
    /// leaf nodes use this and index their bits MSB-first.
    Little,
}

/// Flatten `data` into a string of `'0'`/`'1'`, one character per bit, MSB-first
/// within each byte.
///
/// ```
/// use usbpd_parser::bits::{bits, Order};
/// assert_eq!(bits(&[0x14, 0xA5], Order::Big), "0001010010100101");
/// assert_eq!(bits(&[0xA5, 0x14], Order::Little), "0001010010100101");
/// ```
pub fn bits(data: &[u8], order: Order) -> String {
    let mut out = String::with_capacity(data.len() * 8);
    match order {
        Order::Big => data.iter().for_each(|&b| push_byte(&mut out, b)),
        Order::Little => data.iter().rev().for_each(|&b| push_byte(&mut out, b)),
    }
    out
}

fn push_byte(out: &mut String, byte: u8) {
    for i in (0..8).rev() {
        out.push(if byte >> i & 1 == 1 { '1' } else { '0' });
    }
}

/// Slice a bit string the way Python slices strings: out-of-range indices clamp
/// instead of panicking.
///
/// Bit strings are pure ASCII, so byte indices and character indices coincide.
pub(crate) fn sl(s: &str, start: usize, end: usize) -> &str {
    let start = start.min(s.len());
    let end = end.clamp(start, s.len());
    &s[start..end]
}

/// Slice a byte slice the way Python slices lists: out-of-range indices clamp.
pub(crate) fn bsl(data: &[u8], start: usize, end: usize) -> &[u8] {
    let start = start.min(data.len());
    let end = end.clamp(start, data.len());
    &data[start..end]
}

/// Read a bit string as an unsigned integer — the original's `int(raw, 2)`.
///
/// An empty slice means the message was truncated; Python raised `ValueError` here
/// and the caller turned the whole message into an `Error Data` node.
pub(crate) fn num(s: &str, field: &'static str) -> Result<u64> {
    if s.is_empty() || s.len() > 64 {
        return Err(ParseError::Truncated { field });
    }
    u64::from_str_radix(s, 2).map_err(|_| ParseError::Truncated { field })
}

/// Read a single-bit (or any) field as a flag — the original's `bool(int(raw, 2))`.
pub(crate) fn flag(s: &str, field: &'static str) -> Result<bool> {
    Ok(num(s, field)? != 0)
}

/// Every PD data object is exactly 32 bits, so a shorter one means the message
/// claimed more objects than it carried.
///
/// Without this check the per-field slices below simply clamp, and a truncated
/// object decodes with its trailing fields read from too few bits — a plausible but
/// wrong value rather than an error.
pub(crate) fn require_object(raw: &str, field: &'static str) -> Result<()> {
    if raw.len() < 32 {
        return Err(ParseError::Truncated { field });
    }
    Ok(())
}

/// Uppercase hex of `data` in wire order — the original's `bytes(data).hex().upper()`.
pub(crate) fn hex_upper(data: &[u8]) -> String {
    data.iter().map(|b| format!("{b:02X}")).collect()
}

/// Render a bit string as uppercase hex, one nibble per 4 bits, rounding the width
/// up so no leading bits are lost.
///
/// Works for bit strings of any length — a whole 512-bit HID report included — where
/// reading the value into an integer first would not.
///
/// ```
/// use usbpd_parser::bits::bits_to_hex;
/// assert_eq!(bits_to_hex("10101"), "15");
/// assert_eq!(bits_to_hex("11111111"), "FF");
/// assert_eq!(bits_to_hex(""), "");
/// ```
pub fn bits_to_hex(s: &str) -> String {
    let pad = (4 - s.len() % 4) % 4;
    let padded: String = std::iter::repeat('0').take(pad).chain(s.chars()).collect();
    padded
        .as_bytes()
        .chunks(4)
        .map(|nibble| {
            let v = nibble
                .iter()
                .fold(0u8, |acc, &c| acc << 1 | (c == b'1') as u8);
            char::from_digit(v as u32, 16)
                .unwrap_or('0')
                .to_ascii_uppercase()
        })
        .collect()
}

/// Uppercase hex of `data` reversed — the original's `bytes(data[::-1]).hex().upper()`.
pub(crate) fn hex_rev_upper(data: &[u8]) -> String {
    data.iter().rev().map(|b| format!("{b:02X}")).collect()
}

/// Format a float the way Python's `repr` does, so value strings such as `"5.0V"`
/// and `"14.114115715026855Ah"` come out byte-identical to the original.
///
/// Rust's `Display` for `f64` already produces the shortest round-tripping form, but
/// it drops the trailing `.0` and never switches to exponent notation; Python keeps
/// the former and uses the latter outside `1e-4 ..= 1e16`.
///
/// ```
/// use usbpd_parser::bits::py_float;
/// assert_eq!(py_float(5.0), "5.0");
/// assert_eq!(py_float(100.0 / 20.0), "5.0");
/// assert_eq!(py_float(1.0 / 20.0), "0.05");
/// assert_eq!(py_float(0.00001), "1e-05");
/// ```
pub fn py_float(v: f64) -> String {
    if v.is_nan() {
        return "nan".into();
    }
    if v.is_infinite() {
        return if v.is_sign_positive() { "inf" } else { "-inf" }.into();
    }

    let magnitude = v.abs();
    if v != 0.0 && !(1e-4..1e16).contains(&magnitude) {
        // Python writes the exponent signed and at least two digits wide: `1e-05`, `1e+16`.
        let sci = format!("{v:e}");
        let (mantissa, exp) = sci
            .split_once('e')
            .expect("`{:e}` always emits an exponent");
        let (sign, digits) = match exp.strip_prefix('-') {
            Some(rest) => ('-', rest),
            None => ('+', exp),
        };
        return format!("{mantissa}e{sign}{digits:0>2}");
    }

    let s = format!("{v}");
    if s.contains('.') {
        s
    } else {
        format!("{s}.0")
    }
}

/// Decode a hex string into bytes, accepting the shapes the Python `Parser.parse`
/// took for its `raw` argument: `"1234AB"`, `"0x1234AB"`, and `"0x12 0x34 0xAB"`.
///
/// ```
/// use usbpd_parser::hex_to_bytes;
/// assert_eq!(hex_to_bytes("0x1234").unwrap(), vec![0x12, 0x34]);
/// assert_eq!(hex_to_bytes("0x12 0x34").unwrap(), vec![0x12, 0x34]);
/// assert_eq!(hex_to_bytes("12 34").unwrap(), vec![0x12, 0x34]);
/// ```
pub fn hex_to_bytes(s: &str) -> Result<Vec<u8>> {
    let mut digits = String::with_capacity(s.len());
    for token in s.split([' ', ',', '\t', '\n', '\r']) {
        let token = token
            .strip_prefix("0x")
            .or(token.strip_prefix("0X"))
            .unwrap_or(token);
        if token.chars().any(|c| !c.is_ascii_hexdigit()) {
            return Err(ParseError::BadHex(s.to_owned()));
        }
        digits.push_str(token);
    }
    if digits.is_empty() || digits.len() % 2 != 0 {
        return Err(ParseError::BadHex(s.to_owned()));
    }
    (0..digits.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&digits[i..i + 2], 16).map_err(|_| ParseError::BadHex(s.to_owned()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bit_strings_match_the_python_endianness_note() {
        // README of the original: 0x14A5 big-endian vs little-endian.
        assert_eq!(bits(&[0x14, 0xA5], Order::Big), "0001010010100101");
        assert_eq!(bits(&[0x14, 0xA5], Order::Little), "1010010100010100");
    }

    #[test]
    fn slices_clamp_like_python() {
        assert_eq!(sl("0101", 2, 99), "01");
        assert_eq!(sl("0101", 9, 99), "");
        assert_eq!(bsl(&[1, 2, 3], 1, 99), &[2, 3]);
        assert_eq!(bsl(&[1, 2, 3], 9, 99), &[] as &[u8]);
    }

    #[test]
    fn empty_field_is_truncation_not_zero() {
        assert!(num("", "X").is_err());
        assert_eq!(num("1010", "X").unwrap(), 10);
    }

    #[test]
    fn floats_render_like_python_repr() {
        assert_eq!(py_float(0.0), "0.0");
        assert_eq!(py_float(-0.0), "-0.0");
        assert_eq!(py_float(20.0), "20.0");
        assert_eq!(py_float(255.75), "255.75");
        assert_eq!(py_float(3.3000000000000003), "3.3000000000000003");
        assert_eq!(py_float(0.0001), "0.0001");
        assert_eq!(py_float(0.00001), "1e-05");
        assert_eq!(py_float(1.5e-7), "1.5e-07");
        assert_eq!(py_float(1e16), "1e+16");
        // An f32 sensor reading widens to f64 without gaining noise digits, exactly
        // as Python's `struct.unpack('<f', ...)` then `repr` does.
        assert_eq!(
            py_float(f32::from_bits(0x4161_D36B) as f64),
            "14.114115715026855"
        );
    }

    #[test]
    fn hex_input_accepts_every_python_shape() {
        assert_eq!(hex_to_bytes("A1B2").unwrap(), vec![0xA1, 0xB2]);
        assert_eq!(hex_to_bytes("0xA1B2").unwrap(), vec![0xA1, 0xB2]);
        assert_eq!(hex_to_bytes("0xA1 0xB2").unwrap(), vec![0xA1, 0xB2]);
        assert!(hex_to_bytes("nope").is_err());
        assert!(hex_to_bytes("A1B").is_err());
    }
}

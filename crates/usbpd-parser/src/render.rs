//! Turn a [`Metadata`] tree into styled text for a terminal or a UI.

use crate::bits::bits_to_hex;
use crate::metadata::{BitLoc, Metadata};
use crate::vendor_ids::vendor_name;

/// The five roles a rendered run of text can play.
///
/// Marked `#[non_exhaustive]`: match with a `_` arm so a future style does not break
/// your build.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "lowercase"))]
#[non_exhaustive]
pub enum Style {
    /// Bit position.
    Red,
    /// Field name.
    Bold,
    /// Decoded value.
    Blue,
    /// Underlying bits or hex.
    Green,
    /// PDO/RDO quick summary.
    Purple,
}

impl Style {
    /// The original's style name, for callers that map these onto their own theme.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Red => "red",
            Self::Bold => "bold",
            Self::Blue => "blue",
            Self::Green => "green",
            Self::Purple => "purple",
        }
    }

    /// The SGR escape that starts this style.
    pub fn ansi(self) -> &'static str {
        match self {
            Self::Red => "\x1b[31m",
            Self::Bold => "\x1b[1m",
            Self::Blue => "\x1b[34m",
            Self::Green => "\x1b[32m",
            Self::Purple => "\x1b[35m",
        }
    }
}

/// A styled run of text. Newlines are inside the text, so concatenating the runs in
/// order reproduces the whole listing.
pub type ColorToken = (Style, String);

/// How deep [`render`] will descend before it stops.
///
/// A parsed message nests five levels at most, but [`Metadata::new`] is public, so a
/// caller can hand over a tree of any depth — and this walk is recursive. Stopping
/// with a marker keeps that from becoming a stack overflow, which no caller can catch.
pub const MAX_RENDER_DEPTH: usize = 64;

/// Render one message.
///
/// `level_thr` is the nesting depth at which leaf values switch from hex to binary:
/// leaves shallower than it print as `(0x1A2B)`, deeper ones as `(0001101000101011b)`.
///
/// ```
/// use usbpd_parser::{Parser, ParseOptions, render, to_plain};
///
/// let msg = Parser::new().parse(&[0x41, 0x00], ParseOptions::default());
/// let text = to_plain(&render(&msg, 1));
/// assert!(text.contains("Message Type: GoodCRC"));
/// ```
pub fn render(msg: &Metadata, level_thr: usize) -> Vec<ColorToken> {
    let mut out = Vec::new();
    push(msg, 0, level_thr, &mut out);
    out
}

/// Render several messages back to back, e.g. a captured stream.
pub fn render_all(msgs: &[Metadata], level_thr: usize) -> Vec<ColorToken> {
    let mut out = Vec::new();
    for msg in msgs {
        push(msg, 0, level_thr, &mut out);
    }
    out
}

/// Concatenate rendered runs, dropping the styling.
pub fn to_plain(tokens: &[ColorToken]) -> String {
    tokens.iter().map(|(_, text)| text.as_str()).collect()
}

/// Concatenate rendered runs as ANSI-escaped text ready for a terminal.
pub fn to_ansi(tokens: &[ColorToken]) -> String {
    let mut out = String::new();
    for (style, text) in tokens {
        // Keep the reset before any trailing newline so the escape does not leak
        // across lines.
        let (body, newline) = match text.strip_suffix('\n') {
            Some(body) => (body, "\n"),
            None => (text.as_str(), ""),
        };
        out.push_str(style.ansi());
        out.push_str(body);
        out.push_str("\x1b[0m");
        out.push_str(newline);
    }
    out
}

fn fmt_bit_loc(msg: &Metadata, indent: &str) -> String {
    let label = match msg.bit_loc() {
        BitLoc::Bits(a, b) if a == b => format!("[b{a}] "),
        BitLoc::Bits(a, b) => format!("[b{a}-b{b}] "),
        BitLoc::None => "[b--] ".to_owned(),
    };
    format!("{indent}{label:<12}")
}

fn push(msg: &Metadata, level: usize, level_thr: usize, out: &mut Vec<ColorToken>) {
    let indent = "    ".repeat(level);
    out.push((Style::Red, fmt_bit_loc(msg, &indent)));
    out.push((Style::Bold, format!("{}: ", msg.field())));

    match msg.children() {
        None => {
            let value = msg.value().to_string();
            out.push((Style::Blue, format!("{value} ")));

            if matches!(
                msg.field(),
                crate::fields::USB_VENDOR_ID | crate::fields::VID
            ) {
                let name = vendor_name(&value).unwrap_or("Unknown Vendor");
                out.push((Style::Blue, format!("[{name}] ")));
            }

            out.push((Style::Green, format_raw(msg, level < level_thr)));
        }
        Some(children) => {
            if let Some(quick) = msg.quick_pdo() {
                out.push((Style::Purple, format!("{quick} ")));
            }
            if let Some(quick) = msg.quick_rdo() {
                out.push((Style::Purple, format!("{quick} ")));
            }
            out.push((Style::Green, format_raw(msg, true)));

            if level >= MAX_RENDER_DEPTH {
                out.push((
                    Style::Red,
                    format!("{indent}    … nesting limit ({MAX_RENDER_DEPTH}) reached\n"),
                ));
                return;
            }

            for child in children {
                push(child, level + 1, level_thr, out);
            }
        }
    }
}

/// A field's bits, as hex when `as_hex` and the field really holds bits, otherwise
/// verbatim.
fn format_raw(msg: &Metadata, as_hex: bool) -> String {
    let raw = msg.raw();
    if !raw.is_bits() {
        format!("({raw})\n")
    } else if as_hex {
        format!("(0x{})\n", bits_to_hex(raw.as_str()))
    } else {
        format!("({raw}b)\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ParseOptions, Parser, Sop};

    fn caps() -> Metadata {
        Parser::new().parse(
            &[0xA1, 0x11, 0x2C, 0x91, 0x01, 0x08],
            ParseOptions {
                sop: Sop::Sop,
                ..Default::default()
            },
        )
    }

    #[test]
    fn renders_the_whole_tree_with_indentation() {
        let text = to_plain(&render(&caps(), 1));
        assert!(text.contains("[b0-b47]    PD: "), "{text}");
        assert!(text.contains("    [b0-b15]    Message Header: "), "{text}");
        assert!(
            text.contains("        [b4-b0]     Message Type: Source_Capabilities "),
            "{text}"
        );
    }

    #[test]
    fn the_sop_node_has_no_bit_position() {
        let text = to_plain(&render(&caps(), 1));
        assert!(text.contains("[b--]"), "{text}");
        assert!(text.contains("SOP*: SOP (SOP)"), "{text}");
    }

    #[test]
    fn level_threshold_switches_leaves_from_hex_to_binary() {
        let shallow = to_plain(&render(&caps(), 9));
        assert!(
            shallow.contains("Message Type: Source_Capabilities (0x01)"),
            "{shallow}"
        );

        let deep = to_plain(&render(&caps(), 0));
        assert!(
            deep.contains("Message Type: Source_Capabilities (00001b)"),
            "{deep}"
        );
    }

    #[test]
    fn pdo_summaries_are_rendered_alongside_the_field_name() {
        let text = to_plain(&render(&caps(), 1));
        assert!(text.contains("PDO 1: F 5.0V@3.0A "), "{text}");
    }

    #[test]
    fn ansi_output_resets_before_each_newline() {
        let ansi = to_ansi(&render(&caps(), 1));
        assert!(!ansi.contains("\n\x1b[0m"));
        assert!(ansi.contains("\x1b[0m\n"));
        // Stripping the escapes recovers the plain rendering.
        assert_eq!(
            ansi.replace("\x1b[0m", "")
                .replace("\x1b[31m", "")
                .replace("\x1b[1m", "")
                .replace("\x1b[34m", "")
                .replace("\x1b[32m", "")
                .replace("\x1b[35m", ""),
            to_plain(&render(&caps(), 1))
        );
    }

    #[test]
    fn style_names_match_the_original() {
        assert_eq!(Style::Red.as_str(), "red");
        assert_eq!(Style::Purple.as_str(), "purple");
    }
}

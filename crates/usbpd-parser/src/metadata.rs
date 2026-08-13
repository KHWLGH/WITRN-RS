//! The [`Metadata`] tree: every parsed field, at every nesting level, is one of these.

use std::borrow::Cow;
use std::fmt;

/// Where a field sits, in bits, inside its parent.
///
/// Bit positions follow the USB-PD spec's own numbering, so for a 32-bit object the
/// first field is `(31, 30)` and the last is `(9, 0)` — start is the *high* bit.
/// Container nodes instead number bits from the start of the message, ascending.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BitLoc {
    /// A concrete `(start, end)` bit range.
    Bits(u32, u32),
    /// No meaningful position — used by the synthetic `SOP*` node, which carries a
    /// label rather than decoded bits. Renders as `[b--]`.
    None,
}

impl From<(u32, u32)> for BitLoc {
    fn from((a, b): (u32, u32)) -> Self {
        Self::Bits(a, b)
    }
}

/// A field's underlying bits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Raw {
    /// A string of `'0'`/`'1'`, MSB-first.
    Bits(String),
    /// A label rather than bits — the `SOP*` node and hard/cable resets.
    Text(Cow<'static, str>),
}

impl Raw {
    /// The characters as stored, whether bits or label.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Bits(s) => s,
            Self::Text(s) => s,
        }
    }

    /// Whether this is a non-empty run of bits, i.e. safe to reformat as hex.
    ///
    /// Mirrors the original renderer's `msg.raw().isdigit()` test, which is also
    /// false for an empty string.
    pub fn is_bits(&self) -> bool {
        matches!(self, Self::Bits(s) if !s.is_empty())
    }

    /// The bits as an integer, if this is a run of at most 64 bits.
    pub fn to_u64(&self) -> Option<u64> {
        match self {
            Self::Bits(s) if !s.is_empty() && s.len() <= 64 => u64::from_str_radix(s, 2).ok(),
            _ => None,
        }
    }
}

impl From<String> for Raw {
    fn from(s: String) -> Self {
        Self::Bits(s)
    }
}

impl From<&str> for Raw {
    fn from(s: &str) -> Self {
        Self::Bits(s.to_owned())
    }
}

impl fmt::Display for Raw {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A decoded field value, or the list of sub-fields it decomposes into.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    /// No value — what `Reserved` fields carry. Displays as `None`, matching Python.
    None,
    /// A flag. Displays as `True`/`False`, matching Python.
    Bool(bool),
    /// A count, index or version component.
    Int(i64),
    /// A rendered value such as `"5.0V"`, `"Source_Capabilities"` or `"0x1A2B"`.
    Str(String),
    /// The next level down of the tree.
    List(Vec<Metadata>),
}

impl Value {
    /// The sub-fields, if this field decomposes.
    pub fn as_list(&self) -> Option<&[Metadata]> {
        match self {
            Self::List(v) => Some(v),
            _ => None,
        }
    }

    /// The value as text, if it is a string.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Str(s) => Some(s),
            _ => None,
        }
    }

    /// The value as a flag, if it is one.
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(b) => Some(*b),
            _ => None,
        }
    }

    /// The value as an integer, if it is one.
    pub fn as_int(&self) -> Option<i64> {
        match self {
            Self::Int(i) => Some(*i),
            _ => None,
        }
    }
}

impl From<bool> for Value {
    fn from(v: bool) -> Self {
        Self::Bool(v)
    }
}
impl From<i64> for Value {
    fn from(v: i64) -> Self {
        Self::Int(v)
    }
}
impl From<u64> for Value {
    fn from(v: u64) -> Self {
        Self::Int(v as i64)
    }
}
impl From<usize> for Value {
    fn from(v: usize) -> Self {
        Self::Int(v as i64)
    }
}
impl From<String> for Value {
    fn from(v: String) -> Self {
        Self::Str(v)
    }
}
impl From<&str> for Value {
    fn from(v: &str) -> Self {
        Self::Str(v.to_owned())
    }
}
impl From<Vec<Metadata>> for Value {
    fn from(v: Vec<Metadata>) -> Self {
        Self::List(v)
    }
}
impl<T: Into<Value>> From<Option<T>> for Value {
    fn from(v: Option<T>) -> Self {
        v.map_or(Self::None, Into::into)
    }
}

impl fmt::Display for Value {
    /// Matches Python's `str()` of the same value, including `None`/`True`/`False`
    /// and the `[field: value, ...]` shape of a list.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::None => f.write_str("None"),
            Self::Bool(true) => f.write_str("True"),
            Self::Bool(false) => f.write_str("False"),
            Self::Int(i) => write!(f, "{i}"),
            Self::Str(s) => f.write_str(s),
            Self::List(items) => {
                f.write_str("[")?;
                for (i, m) in items.iter().enumerate() {
                    if i > 0 {
                        f.write_str(", ")?;
                    }
                    write!(f, "{}", m.repr())?;
                }
                f.write_str("]")
            }
        }
    }
}

/// What a PDO supplies, as the bits say rather than as the tree prints it.
///
/// The `Supply Type` and `APDO Type` fields carry display strings — `"FPDO"`,
/// `"SPR PPS"` — and an RDO's own field layout depends on which supply it is
/// requesting. Dispatching on the printed text would mean a change of wording
/// silently changed how messages decode, so the classification is kept separately
/// from the text.
///
/// Only Source PDOs carry one: an RDO resolves against `Source_Capabilities`, and a
/// Sink PDO reaching that path is a malformed conversation rather than a layout to
/// pick.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[non_exhaustive]
pub enum SupplyType {
    /// Fixed Supply.
    Fixed,
    /// Battery Supply.
    Battery,
    /// Variable Supply (non-battery).
    Variable,
    /// Augmented: SPR Programmable Power Supply.
    Pps,
    /// Augmented: SPR Adjustable Voltage Supply.
    SprAvs,
    /// Augmented: EPR Adjustable Voltage Supply.
    EprAvs,
    /// Augmented, with an APDO type the spec has not assigned.
    UnassignedApdo,
}

/// Extras only a handful of node kinds carry, boxed so the common node stays small.
#[derive(Debug, Clone, Default, PartialEq)]
struct Extra {
    quick_pdo: Option<String>,
    quick_rdo: Option<String>,
    pdo: Option<Metadata>,
    supply: Option<SupplyType>,
    /// Bytes accumulated across the chunks of a chunked extended message.
    full_data: Option<Vec<u8>>,
    /// Data-object count accumulated across chunks of EPR capability messages.
    full_num_objs: Option<f64>,
    /// Chunk number this reassembly is expecting next.
    next_chunk: Option<u64>,
}

/// One parsed field: its bits, its position, its name, and its value or sub-fields.
///
/// This is the single currency of the parser — headers, PDOs, RDOs, VDOs and whole
/// messages are all `Metadata`, nested. Walk it with [`get`](Self::get) by field name
/// or [`at`](Self::at) by index, and read leaves with [`value`](Self::value).
///
/// ```
/// use usbpd_parser::{Parser, ParseOptions, Sop};
///
/// let mut parser = Parser::new();
/// // Source_Capabilities carrying one 5V/3A fixed PDO.
/// let msg = parser.parse(
///     &[0xA1, 0x11, 0x2C, 0x91, 0x01, 0x08],
///     ParseOptions { sop: Sop::Sop, ..Default::default() },
/// );
///
/// let header = msg.get("Message Header").unwrap();
/// assert_eq!(header.get("Message Type").unwrap().value().as_str(), Some("Source_Capabilities"));
///
/// let pdo = msg.get("Data Objects").unwrap().get("PDO 1").unwrap();
/// assert_eq!(pdo.get("Voltage").unwrap().value().as_str(), Some("5.0V"));
/// assert_eq!(pdo.quick_pdo(), Some("F 5.0V@3.0A"));
/// ```
#[derive(Debug, Clone, PartialEq)]
pub struct Metadata {
    raw: Raw,
    bit_loc: BitLoc,
    field: Cow<'static, str>,
    value: Value,
    /// Set only on chunked extended messages: the per-chunk value, where `value`
    /// holds the reassembled one.
    raw_value: Option<Value>,
    /// Set only on chunked extended messages: bits of every chunk so far.
    full_raw: Option<Raw>,
    extra: Option<Box<Extra>>,
}

impl Metadata {
    /// Build a leaf or container node.
    pub fn new(
        raw: impl Into<Raw>,
        bit_loc: impl Into<BitLoc>,
        field: impl Into<Cow<'static, str>>,
        value: impl Into<Value>,
    ) -> Self {
        Self {
            raw: raw.into(),
            bit_loc: bit_loc.into(),
            field: field.into(),
            value: value.into(),
            raw_value: None,
            full_raw: None,
            extra: None,
        }
    }

    /// Build a `Reserved` node — bits that carry no value at this revision.
    pub fn reserved(raw: impl Into<Raw>, bit_loc: impl Into<BitLoc>) -> Self {
        Self::new(raw, bit_loc, "Reserved", Value::None)
    }

    /// The field's bits, as a string of `'0'`/`'1'`.
    ///
    /// A single logical field is stored little-endian on the wire but indexed
    /// MSB-first here; a container spanning several fields keeps wire order. That is
    /// why `0x14A5` shows up as `1010010100010100` in a leaf and `0001010010100101`
    /// in its parent.
    pub fn raw(&self) -> &Raw {
        &self.raw
    }

    /// Where the field sits inside its parent, in bits.
    pub fn bit_loc(&self) -> BitLoc {
        self.bit_loc
    }

    /// The field's name, e.g. `"Message Type"` or `"PDO 1"`.
    pub fn field(&self) -> &str {
        &self.field
    }

    /// The decoded value, or the sub-fields it decomposes into.
    ///
    /// For a chunked extended message this is the *reassembled* value; use
    /// [`raw_value`](Self::raw_value) for this chunk alone.
    pub fn value(&self) -> &Value {
        &self.value
    }

    /// The sub-fields, if this node has any.
    pub fn children(&self) -> Option<&[Metadata]> {
        self.value.as_list()
    }

    /// This chunk's own value, for a chunked extended message.
    ///
    /// Equal to [`value`](Self::value) everywhere else.
    pub fn raw_value(&self) -> &Value {
        self.raw_value.as_ref().unwrap_or(&self.value)
    }

    /// The bits of every chunk received so far, for a chunked extended message.
    ///
    /// Equal to [`raw`](Self::raw) everywhere else.
    pub fn full_raw(&self) -> &Raw {
        self.full_raw.as_ref().unwrap_or(&self.raw)
    }

    /// A one-line summary of a PDO, e.g. `"F 5.0V@3.0A"`, or `None` if this is not one.
    ///
    /// The leading letters encode the supply type: `F`ixed, `B`attery, `V`ariable,
    /// `P`PS, `SA`/`EA` for SPR/EPR adjustable voltage, prefixed with `E` for an EPR
    /// object position.
    pub fn quick_pdo(&self) -> Option<&str> {
        self.extra.as_ref()?.quick_pdo.as_deref()
    }

    /// A one-line summary of an RDO, e.g. `"[2] F 9.0V@3.0A"`, or `None` if this is
    /// not one. The bracketed number is the requested object position.
    pub fn quick_rdo(&self) -> Option<&str> {
        self.extra.as_ref()?.quick_rdo.as_deref()
    }

    /// The PDO an RDO is requesting against, resolved from the stored
    /// Source_Capabilities. `None` if this is not an RDO.
    pub fn pdo(&self) -> Option<&Metadata> {
        self.extra.as_ref()?.pdo.as_ref()
    }

    /// What this PDO supplies, classified from its bits rather than its printed
    /// `Supply Type`. `None` on anything that is not a Source PDO.
    pub fn supply_type(&self) -> Option<SupplyType> {
        self.extra.as_ref()?.supply
    }

    /// The message type, without spelling out the two-level path to it.
    ///
    /// ```
    /// use usbpd_parser::{ParseOptions, Parser};
    ///
    /// let msg = Parser::new().parse(&[0x41, 0x00], ParseOptions::default());
    /// assert_eq!(msg.message_type(), Some("GoodCRC"));
    /// ```
    pub fn message_type(&self) -> Option<&str> {
        self.get(crate::fields::MESSAGE_HEADER)?
            .get(crate::fields::MESSAGE_TYPE)?
            .value()
            .as_str()
    }

    /// The data objects of a message, under whichever name it files them.
    ///
    /// A non-extended message calls the block `Data Objects`; the EPR capability
    /// messages call it `Data Block`. Looking for only the first is what made a
    /// `Request` after `EPR_Source_Capabilities` fail to decode in the original.
    pub fn data_objects(&self) -> Option<&[Metadata]> {
        self.get(crate::fields::DATA_OBJECTS)
            .or_else(|| self.get(crate::fields::DATA_BLOCK))?
            .children()
    }

    /// Look up a sub-field by name.
    ///
    /// `Reserved` never resolves (there are usually several); when a name repeats,
    /// the last match wins, matching the original's dict construction.
    pub fn get(&self, field: &str) -> Option<&Metadata> {
        if field == crate::fields::RESERVED {
            return None;
        }
        self.value
            .as_list()?
            .iter()
            .rev()
            .find(|m| m.field == field)
    }

    /// Look up a sub-field by position.
    pub fn at(&self, index: usize) -> Option<&Metadata> {
        self.value.as_list()?.get(index)
    }

    /// `field: value`, the original's `repr()`.
    pub fn repr(&self) -> String {
        format!("{}: {}", self.field, self.value)
    }

    pub(crate) fn with_quick_pdo(mut self, quick: String) -> Self {
        self.extra_mut().quick_pdo = Some(quick);
        self
    }

    pub(crate) fn with_quick_rdo(mut self, quick: String) -> Self {
        self.extra_mut().quick_rdo = Some(quick);
        self
    }

    pub(crate) fn with_pdo(mut self, pdo: Metadata) -> Self {
        self.extra_mut().pdo = Some(pdo);
        self
    }

    pub(crate) fn with_supply(mut self, supply: SupplyType) -> Self {
        self.extra_mut().supply = Some(supply);
        self
    }

    /// Attach chunk-reassembly state to a chunked extended message body.
    ///
    /// `full_data` is `None` when this message is a *request* for a chunk and so
    /// carries nothing that a later chunk could build on.
    pub(crate) fn with_chunks(
        mut self,
        full_raw: Raw,
        raw_value: Value,
        full_data: Option<Vec<u8>>,
        full_num_objs: Option<f64>,
        next_chunk: Option<u64>,
    ) -> Self {
        self.full_raw = Some(full_raw);
        self.raw_value = Some(raw_value);
        let extra = self.extra_mut();
        extra.full_data = full_data;
        extra.full_num_objs = full_num_objs;
        extra.next_chunk = next_chunk;
        self
    }

    pub(crate) fn chunk_data(&self) -> Option<&[u8]> {
        self.extra.as_ref()?.full_data.as_deref()
    }

    pub(crate) fn chunk_num_objs(&self) -> Option<f64> {
        self.extra.as_ref()?.full_num_objs
    }

    /// Which chunk number this reassembly expects next, if it is one.
    pub(crate) fn chunk_next(&self) -> Option<u64> {
        self.extra.as_ref()?.next_chunk
    }

    fn extra_mut(&mut self) -> &mut Extra {
        self.extra.get_or_insert_with(Box::default)
    }
}

impl fmt::Display for Metadata {
    /// The value alone, matching the original's `str()`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.value)
    }
}

impl Drop for Metadata {
    /// Take the tree apart iteratively.
    ///
    /// `Value::List` makes `Metadata` recursive through a `Vec`, so the drop glue the
    /// compiler generates descends one stack frame per level. A parsed message nests
    /// five levels, but [`Metadata::new`] is public and a caller can build one far
    /// deeper — and unlike a `panic!`, a stack overflow is not something they can
    /// catch. [`render`](crate::render) is bounded by
    /// [`MAX_RENDER_DEPTH`](crate::MAX_RENDER_DEPTH) for the same reason; this covers
    /// the tree simply going out of scope.
    fn drop(&mut self) {
        let mut pending = Vec::new();
        detach(self, &mut pending);
        while let Some(mut node) = pending.pop() {
            detach(&mut node, &mut pending);
            // `node` now owns no other node, so its own drop cannot recurse.
        }
    }
}

/// Move every node owned by `node` onto `pending`, leaving it childless.
fn detach(node: &mut Metadata, pending: &mut Vec<Metadata>) {
    if let Value::List(children) = std::mem::replace(&mut node.value, Value::None) {
        pending.extend(children);
    }
    if let Some(Value::List(children)) = node.raw_value.take() {
        pending.extend(children);
    }
    if let Some(mut extra) = node.extra.take() {
        // The PDO an RDO resolved against is owned, so it is part of the tree too.
        if let Some(pdo) = extra.pdo.take() {
            pending.push(pdo);
        }
    }
}

#[cfg(feature = "serde")]
mod serde_impls {
    use super::{BitLoc, Metadata, Raw, Value};
    use serde::ser::{SerializeMap, SerializeSeq};
    use serde::{Serialize, Serializer};

    impl Serialize for BitLoc {
        /// `[start, end]`, or `null` for the synthetic `SOP*` node.
        fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
            match self {
                Self::Bits(a, b) => {
                    let mut seq = s.serialize_seq(Some(2))?;
                    seq.serialize_element(a)?;
                    seq.serialize_element(b)?;
                    seq.end()
                }
                Self::None => s.serialize_none(),
            }
        }
    }

    impl Serialize for Raw {
        fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
            s.serialize_str(self.as_str())
        }
    }

    impl Serialize for Value {
        fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
            match self {
                Self::None => s.serialize_none(),
                Self::Bool(b) => s.serialize_bool(*b),
                Self::Int(i) => s.serialize_i64(*i),
                Self::Str(v) => s.serialize_str(v),
                Self::List(items) => items.serialize(s),
            }
        }
    }

    impl Serialize for Metadata {
        /// `{raw, bit_loc, field, value}`, plus `quick_pdo`/`quick_rdo`/`full_raw`
        /// only on the nodes that have them.
        fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
            let optional = self.quick_pdo().is_some() as usize
                + self.quick_rdo().is_some() as usize
                + self.full_raw.is_some() as usize;
            let mut map = s.serialize_map(Some(4 + optional))?;
            map.serialize_entry("raw", &self.raw)?;
            map.serialize_entry("bit_loc", &self.bit_loc)?;
            map.serialize_entry("field", &self.field)?;
            map.serialize_entry("value", &self.value)?;
            if let Some(q) = self.quick_pdo() {
                map.serialize_entry("quick_pdo", q)?;
            }
            if let Some(q) = self.quick_rdo() {
                map.serialize_entry("quick_rdo", q)?;
            }
            if let Some(r) = &self.full_raw {
                map.serialize_entry("full_raw", r)?;
            }
            map.end()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> Metadata {
        Metadata::new(
            "0011",
            (0, 3),
            "Root",
            vec![
                Metadata::new("0", (3, 3), "Flag", true),
                Metadata::reserved("0", (2, 2)),
                Metadata::new("11", (1, 0), "Count", 3u64),
            ],
        )
    }

    #[test]
    fn lookup_by_name_and_index() {
        let m = tree();
        assert_eq!(m.get("Flag").unwrap().value(), &Value::Bool(true));
        assert_eq!(m.at(2).unwrap().field(), "Count");
        assert!(m.get("Nope").is_none());
    }

    #[test]
    fn reserved_never_resolves_by_name() {
        assert!(tree().get("Reserved").is_none());
    }

    #[test]
    fn repeated_names_resolve_to_the_last() {
        let m = Metadata::new(
            "",
            (0, 0),
            "Root",
            vec![
                Metadata::new("0", (1, 1), "Dup", "first"),
                Metadata::new("1", (0, 0), "Dup", "second"),
            ],
        );
        assert_eq!(m.get("Dup").unwrap().value().as_str(), Some("second"));
    }

    #[test]
    fn display_matches_python_str_and_repr() {
        let m = tree();
        assert_eq!(m.at(0).unwrap().to_string(), "True");
        assert_eq!(m.at(1).unwrap().to_string(), "None");
        assert_eq!(m.at(2).unwrap().repr(), "Count: 3");
        assert_eq!(m.to_string(), "[Flag: True, Reserved: None, Count: 3]");
    }

    #[test]
    fn leaves_without_extras_report_no_quick_summary() {
        let m = tree();
        assert!(m.quick_pdo().is_none());
        assert!(m.quick_rdo().is_none());
        assert!(m.pdo().is_none());
    }

    #[test]
    fn full_raw_and_raw_value_fall_back_to_the_plain_ones() {
        let m = tree();
        assert_eq!(m.full_raw(), m.raw());
        assert_eq!(m.raw_value(), m.value());
    }

    #[cfg(feature = "serde")]
    #[test]
    fn serializes_to_a_frontend_friendly_shape() {
        let json = serde_json::to_value(tree()).unwrap();
        assert_eq!(json["field"], "Root");
        assert_eq!(json["bit_loc"], serde_json::json!([0, 3]));
        assert_eq!(json["value"][0]["value"], true);
        assert_eq!(json["value"][1]["value"], serde_json::Value::Null);
        assert_eq!(json["value"][2]["value"], 3);
        assert!(json.get("quick_pdo").is_none());
    }
}

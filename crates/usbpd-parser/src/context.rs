//! Shared context threaded through message-body decoders.

use crate::error::{ParseError, Result};
use crate::header::Sop;
use crate::metadata::Metadata;

/// Everything a message body may need beyond its own bytes.
///
/// `last_pdo`, `last_ext` and `last_rdo` are the conversation's state: a Request is
/// only decodable against the Source_Capabilities that preceded it, a later chunk of
/// an extended message only against the earlier ones, and a Status message's
/// CL/CV flag only against the RDO in force.
pub(crate) struct Ctx<'a> {
    pub sop: Sop,
    pub header: &'a Metadata,
    pub ex_header: Option<&'a Metadata>,
    pub last_pdo: Option<&'a Metadata>,
    pub last_ext: Option<&'a Metadata>,
    pub last_rdo: Option<&'a Metadata>,
    pub prop_protocol: bool,
}

impl Ctx<'_> {
    /// Number of Data Objects, from the Message Header.
    pub fn num_objs(&self) -> usize {
        self.header
            .at(1)
            .and_then(|m| m.value().as_int())
            .unwrap_or(0)
            .max(0) as usize
    }

    /// Port Power Role, from the Message Header.
    pub fn power_role(&self) -> &str {
        self.header
            .at(3)
            .and_then(|m| m.value().as_str())
            .unwrap_or("")
    }

    /// Data Size, from the Extended Message Header.
    pub fn data_size(&self, field: &'static str) -> Result<usize> {
        self.ex_header
            .and_then(|h| h.get("Data Size"))
            .and_then(|m| m.value().as_int())
            .filter(|n| *n >= 0)
            .map(|n| n as usize)
            .ok_or(ParseError::Truncated { field })
    }

    pub fn ex_header(&self, field: &'static str) -> Result<&Metadata> {
        self.ex_header.ok_or(ParseError::Truncated { field })
    }

    pub fn last_ext(&self, field: &'static str) -> Result<&Metadata> {
        self.last_ext.ok_or(ParseError::MissingContext {
            which: "last_ext",
            field,
        })
    }
}

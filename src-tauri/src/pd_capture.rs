//! PD 捕获日志：HID 线程写入紧凑事件，详情按索引取已解析的树。
//!
//! 前端列表只拿摘要 + 原始 HID 帧；解码树留在这边，点选时 `decode_pd_at` 直接
//! 取出，不再重放 Parser。会话上下文（RDO 相对 PDO）在捕获当下已经解析好。

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use witrn_hid::usbpd_parser::fields;
use witrn_hid::{decode_pd_report, Metadata, Parser};

/// 推给前端的一条 PD 事件。`divider` 为真时其余字段为空。
#[derive(Clone, Debug, Serialize)]
pub struct PdEvent {
    pub t: u64,
    #[serde(default, skip_serializing_if = "is_false")]
    pub divider: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sop: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub msg_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<Vec<u8>>,
}

/// 导入时的一条原始记录（前端 v2 捕获文件 / 替换命令）。
#[derive(Clone, Debug, Deserialize)]
pub struct PdLoadEntry {
    pub t: u64,
    #[serde(default)]
    pub divider: bool,
    #[serde(default)]
    pub bytes: Vec<u8>,
}

/// 列表行摘要，字段口径与 `src/pd-model.js` 的 `summarize` 对齐。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PdSummary {
    pub sop: String,
    pub msg_type: String,
    pub role: String,
    pub summary: String,
}

struct PdMessage {
    meta: Metadata,
}

/// 仅存报文（不含断开分隔行）。`seq` 就是本向量下标。
#[derive(Default)]
pub struct PdLog {
    messages: Vec<PdMessage>,
}

fn is_false(v: &bool) -> bool {
    !*v
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl PdLog {
    pub fn clear(&mut self) {
        self.messages.clear();
    }

    /// 追加一条已解析报文，返回发给前端的紧凑事件。
    pub fn push_message(&mut self, t: u64, report: Vec<u8>, meta: Metadata) -> PdEvent {
        let seq = self.messages.len() as u64;
        let event = PdEvent::message(t, seq, &report, &meta);
        self.messages.push(PdMessage { meta });
        event
    }

    pub fn meta_at(&self, index: usize) -> Option<&Metadata> {
        self.messages.get(index).map(|m| &m.meta)
    }

    /// 用导入的原始帧重建日志。分隔行只出现在返回的事件里，不占 seq。
    pub fn replace(&mut self, entries: Vec<PdLoadEntry>) -> Result<Vec<PdEvent>, String> {
        self.messages.clear();
        let mut parser = Parser::new();
        let mut out = Vec::with_capacity(entries.len());
        for entry in entries {
            if entry.divider {
                out.push(PdEvent::divider(entry.t));
                continue;
            }
            if entry.bytes.is_empty() {
                return Err("导入的报文缺少原始帧".to_string());
            }
            let meta = decode_pd_report(&mut parser, &entry.bytes)
                .map_err(|e| format!("导入的报文无法解析: {e}"))?;
            out.push(self.push_message(entry.t, entry.bytes, meta));
        }
        Ok(out)
    }
}

impl PdEvent {
    pub fn divider(t: u64) -> Self {
        Self {
            t,
            divider: true,
            seq: None,
            sop: None,
            msg_type: None,
            role: None,
            summary: None,
            bytes: None,
        }
    }

    pub fn message(t: u64, seq: u64, report: &[u8], meta: &Metadata) -> Self {
        let s = summarize(meta);
        Self {
            t,
            divider: false,
            seq: Some(seq),
            sop: Some(s.sop),
            msg_type: Some(s.msg_type),
            role: Some(s.role),
            summary: Some(s.summary),
            bytes: Some(report.to_vec()),
        }
    }
}

/// 与前端 `summarize` 相同的列表摘要。
pub fn summarize(meta: &Metadata) -> PdSummary {
    let sop = meta
        .get(fields::SOP)
        .and_then(|m| m.value().as_str())
        .unwrap_or("?")
        .to_string();

    let header = meta
        .get(fields::MESSAGE_HEADER)
        .or_else(|| meta.get(fields::EXTENDED_MESSAGE_HEADER));

    let msg_type = header
        .and_then(|h| h.get(fields::MESSAGE_TYPE))
        .and_then(|m| m.value().as_str())
        .unwrap_or("未知")
        .to_string();

    let mut role = String::new();
    if let Some(h) = header {
        match h.get("Port Power Role").and_then(|m| m.value().as_str()) {
            Some("Source") => role = "SRC".to_string(),
            Some("Sink") => role = "SNK".to_string(),
            _ if h.get("Cable Plug").is_some() => role = "CBL".to_string(),
            _ => {}
        }
    }

    let mut quicks = Vec::new();
    if let Some(objs) = meta.data_objects() {
        for child in objs {
            if let Some(q) = child.quick_pdo().or(child.quick_rdo()) {
                quicks.push(q);
            }
        }
    }

    PdSummary {
        sop,
        msg_type,
        role,
        summary: quicks.join("  "),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use witrn_hid::usbpd_parser::{ParseOptions, Parser, Sop};
    use witrn_hid::REPORT_LEN;

    fn pd_frame(payload: &[u8], sop_byte: u8) -> Vec<u8> {
        let mut d = vec![0u8; REPORT_LEN];
        d[0] = 0xFE;
        d[1] = payload.len() as u8 + 1;
        d[2] = sop_byte;
        d[3..3 + payload.len()].copy_from_slice(payload);
        d
    }

    #[test]
    fn summarize_goodcrc_and_source_caps() {
        let mut parser = Parser::new();
        let crc = parser.parse(&[0x41, 0x00], ParseOptions::default());
        let s = summarize(&crc);
        assert_eq!(s.sop, "SOP");
        assert_eq!(s.msg_type, "GoodCRC");
        assert_eq!(s.role, "SNK");

        let caps = parser.parse(
            &[0xA1, 0x11, 0x2C, 0x91, 0x01, 0x08],
            ParseOptions::default(),
        );
        let s = summarize(&caps);
        assert_eq!(s.msg_type, "Source_Capabilities");
        assert_eq!(s.role, "SRC");
        assert_eq!(s.summary, "F 5.0V@3.0A");
    }

    #[test]
    fn summarize_cable_plug_role() {
        let mut parser = Parser::new();
        let msg = parser.parse(
            &[0x41, 0x00],
            ParseOptions {
                sop: Sop::SopPrime,
                ..Default::default()
            },
        );
        let s = summarize(&msg);
        assert_eq!(s.sop, "SOP'");
        assert_eq!(s.role, "CBL");
    }

    #[test]
    fn log_seq_skips_dividers_and_decode_is_o1() {
        let mut log = PdLog::default();
        let mut parser = Parser::new();
        let caps = pd_frame(&[0xA1, 0x11, 0x2C, 0x91, 0x01, 0x08], 224);
        let crc = pd_frame(&[0x41, 0x00], 224);
        let e0 = log.push_message(
            1,
            caps.clone(),
            decode_pd_report(&mut parser, &caps).unwrap(),
        );
        assert_eq!(e0.seq, Some(0));
        let e1 = log.push_message(2, crc.clone(), decode_pd_report(&mut parser, &crc).unwrap());
        assert_eq!(e1.seq, Some(1));
        assert!(log.meta_at(1).is_some());
        assert!(log.meta_at(2).is_none());
        assert_eq!(
            summarize(log.meta_at(0).unwrap()).msg_type,
            "Source_Capabilities"
        );
        assert_eq!(summarize(log.meta_at(1).unwrap()).msg_type, "GoodCRC");
    }

    #[test]
    fn replace_replays_conversation_for_request() {
        // Source_Capabilities 5V/3A + 9V/3A, then Request for PDO 2.
        let caps = pd_frame(
            &[0xA1, 0x21, 0x2C, 0x91, 0x01, 0x08, 0x2C, 0xD1, 0x02, 0x00],
            224,
        );
        let req = pd_frame(&[0x42, 0x10, 0x2C, 0xB1, 0x04, 0x20], 224);
        let mut log = PdLog::default();
        let events = log
            .replace(vec![
                PdLoadEntry {
                    t: 1,
                    divider: false,
                    bytes: caps,
                },
                PdLoadEntry {
                    t: 2,
                    divider: true,
                    bytes: vec![],
                },
                PdLoadEntry {
                    t: 3,
                    divider: false,
                    bytes: req,
                },
            ])
            .unwrap();
        assert_eq!(events.len(), 3);
        assert!(events[1].divider);
        assert_eq!(events[0].seq, Some(0));
        assert_eq!(events[2].seq, Some(1));
        assert!(log.meta_at(1).is_some());
        assert!(log.meta_at(2).is_none());
        let s = summarize(log.meta_at(1).unwrap());
        assert_eq!(s.msg_type, "Request");
        assert_eq!(s.summary, "[2] F 9.0V@3.0A");
    }
}

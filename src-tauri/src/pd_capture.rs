//! PD 捕获日志：HID 线程写入紧凑事件，详情按索引取已解析的树。
//!
//! 前端列表只拿摘要 + 原始 HID 帧；解码树留在这边，点选时 `decode_pd_at` 直接
//! 取出，不再重放 Parser。会话上下文（RDO 相对 PDO）在捕获当下已经解析好。
//! 入库前给 VID / USB Vendor ID 叶子补 USB-IF 厂商名，列表 Note 与详情共用。

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
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub obj: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rev: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vbus: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ibus: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<Vec<u8>>,
    #[serde(default)]
    pub gen: u64,
}

/// 导入时的一条原始记录（前端 v2 捕获文件 / 替换命令）。
#[derive(Clone, Debug, Default, Deserialize)]
pub struct PdLoadEntry {
    pub t: u64,
    #[serde(default)]
    pub divider: bool,
    #[serde(default)]
    pub bytes: Vec<u8>,
    #[serde(default)]
    pub vbus: Option<f32>,
    #[serde(default)]
    pub ibus: Option<f32>,
}

/// 列表行摘要，字段口径与 `src/pd-model.js` 的 `summarize` 对齐。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PdSummary {
    pub sop: String,
    pub msg_type: String,
    pub role: String,
    pub summary: String,
    pub id: String,
    pub obj: String,
    pub rev: String,
    pub direction: String,
}

struct PdMessage {
    event: PdEvent,
    meta: Metadata,
}

/// 仅存报文（不含断开分隔行）。`seq` 就是本向量下标。
#[derive(Default)]
pub struct PdLog {
    messages: Vec<PdMessage>,
    generation: u64,
}

/// 超过该条数停止入库，避免无界增长把进程吃满。
pub const PD_LOG_HARD_CAP: usize = 1_000_000;

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
    pub fn clear(&mut self) -> u64 {
        self.messages.clear();
        self.generation = self.generation.wrapping_add(1);
        self.generation
    }

    /// 追加一条已解析报文，返回发给前端的紧凑事件。满员时返回 `None`。
    pub fn push_message(
        &mut self,
        t: u64,
        report: Vec<u8>,
        meta: Metadata,
        vbus: Option<f32>,
        ibus: Option<f32>,
    ) -> Option<PdEvent> {
        if self.messages.len() >= PD_LOG_HARD_CAP {
            return None;
        }
        let seq = self.messages.len() as u64;
        let mut meta = meta;
        meta.annotate_vendor_names();
        let mut event = PdEvent::message(t, seq, &report, &meta);
        event.vbus = vbus;
        event.ibus = ibus;
        event.gen = self.generation;
        self.messages.push(PdMessage {
            event: event.clone(),
            meta,
        });
        Some(event)
    }

    pub fn meta_at(&self, index: usize) -> Option<&Metadata> {
        self.messages.get(index).map(|m| &m.meta)
    }

    /// `after_seq` 为 `None` 时返回全部；否则返回 `seq > after_seq` 的紧凑事件。
    pub fn events_after(&self, after_seq: Option<u64>) -> Vec<PdEvent> {
        let start = match after_seq {
            None => 0,
            Some(seq) => (seq + 1) as usize,
        };
        self.messages
            .get(start..)
            .map(|slice| slice.iter().map(|m| m.event.clone()).collect())
            .unwrap_or_default()
    }

    /// 解析导入帧，不碰现有日志。调用方持锁后再 [`install`](Self::install)。
    pub fn build(entries: Vec<PdLoadEntry>) -> Result<(Self, Vec<PdEvent>), String> {
        let mut next = PdLog::default();
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
            let event = next
                .push_message(entry.t, entry.bytes, meta, entry.vbus, entry.ibus)
                .ok_or_else(|| "导入超过日志上限".to_string())?;
            out.push(event);
        }
        Ok((next, out))
    }

    /// 用已解析的日志替换自身，并给事件盖上新的 generation。
    pub fn install(&mut self, mut next: PdLog, mut events: Vec<PdEvent>) -> Vec<PdEvent> {
        next.generation = self.generation.wrapping_add(1);
        for event in &mut events {
            event.gen = next.generation;
        }
        for message in &mut next.messages {
            message.event.gen = next.generation;
        }
        *self = next;
        events
    }

    /// 用导入的原始帧重建日志。分隔行只出现在返回的事件里，不占 seq。
    #[cfg(test)]
    pub fn replace(&mut self, entries: Vec<PdLoadEntry>) -> Result<Vec<PdEvent>, String> {
        let (next, events) = Self::build(entries)?;
        Ok(self.install(next, events))
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
            id: None,
            obj: None,
            rev: None,
            direction: None,
            vbus: None,
            ibus: None,
            bytes: None,
            gen: 0,
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
            summary: nonempty(s.summary),
            id: nonempty(s.id),
            obj: nonempty(s.obj),
            rev: nonempty(s.rev),
            direction: nonempty(s.direction),
            vbus: None,
            ibus: None,
            bytes: Some(report.to_vec()),
            gen: 0,
        }
    }
}

fn nonempty(s: String) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s)
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
                quicks.push(q.to_string());
            }
        }
    }

    let id = header
        .and_then(|h| h.get("MessageID"))
        .map(leaf_text)
        .unwrap_or_default();
    let obj = header
        .and_then(|h| h.get("Number of Data Objects"))
        .map(leaf_text)
        .unwrap_or_default();
    let rev = header
        .and_then(|h| h.get("Specification Revision"))
        .and_then(|m| m.value().as_str())
        .map(spec_rev_short)
        .unwrap_or_default();

    PdSummary {
        summary: format_note(&msg_type, &quicks, meta),
        id,
        obj,
        rev,
        direction: direction_of(&sop, &role, header),
        sop,
        msg_type,
        role,
    }
}

fn leaf_text(meta: &Metadata) -> String {
    meta.value().to_string()
}

fn spec_rev_short(value: &str) -> String {
    if value.contains('1') {
        "V1".into()
    } else if value.contains('2') {
        "V2".into()
    } else if value.contains('3') {
        "V3".into()
    } else {
        value.to_string()
    }
}

fn direction_of(sop: &str, role: &str, header: Option<&Metadata>) -> String {
    let plug_sop = matches!(sop, "SOP'" | "SOP''" | "SOP'_DEBUG" | "SOP''_DEBUG");
    if plug_sop {
        let from_plug = header
            .and_then(|h| h.get("Cable Plug"))
            .and_then(|m| m.value().as_str())
            .is_some_and(|v| v.starts_with("Cable Plug"));
        return if from_plug {
            "SRC|SNK←Plug".into()
        } else {
            "SRC|SNK→Plug".into()
        };
    }
    match role {
        "SRC" => "SRC→SNK".into(),
        "SNK" => "SRC←SNK".into(),
        _ => String::new(),
    }
}

fn format_note(msg_type: &str, quicks: &[String], meta: &Metadata) -> String {
    match msg_type {
        "Source_Capabilities"
        | "Sink_Capabilities"
        | "EPR_Source_Capabilities"
        | "EPR_Sink_Capabilities" => format_cap_note(quicks),
        "Request" | "EPR_Request" => {
            format_request_note(quicks.first().map(String::as_str).unwrap_or(""))
        }
        "Vendor_Defined" | "Vendor_Defined_Extended" => format_vdm_note(meta),
        _ => quicks.join("  "),
    }
}

fn format_cap_note(quicks: &[String]) -> String {
    let mut fixed = Vec::new();
    let mut battery = Vec::new();
    let mut variable = Vec::new();
    let mut spr_avs = Vec::new();
    let mut epr_avs = Vec::new();
    let mut pps = Vec::new();
    for q in quicks {
        let Some((kind, rest)) = split_quick(q) else {
            continue;
        };
        match kind {
            "F" | "EF" => fixed.push(protect_note_token(rest.split('@').next().unwrap_or(rest))),
            "P" => pps.push(protect_note_token(rest.split('@').next().unwrap_or(rest))),
            "SA" => spr_avs.push(protect_note_token(rest)),
            "EA" => epr_avs.push(protect_note_token(rest.split('@').next().unwrap_or(rest))),
            "V" | "EV" => variable.push(protect_note_token(rest)),
            "B" | "EB" => battery.push(protect_note_token(rest)),
            _ => {}
        }
    }
    let mut parts = Vec::new();
    push_group(&mut parts, "Fixed", &fixed);
    push_group(&mut parts, "Battery", &battery);
    push_group(&mut parts, "Variable", &variable);
    push_group(&mut parts, "SPR AVS", &spr_avs);
    push_group(&mut parts, "EPR AVS", &epr_avs);
    push_group(&mut parts, "PPS", &pps);
    parts.join("  ")
}

fn push_group(parts: &mut Vec<String>, label: &str, items: &[String]) {
    if !items.is_empty() {
        parts.push(format!("{label}: {}", items.join(" ")));
    }
}

fn split_quick(quick: &str) -> Option<(&str, &str)> {
    for kind in ["EF", "EA", "SA", "EB", "EV", "F", "B", "V", "P"] {
        let prefix = format!("{kind} ");
        if let Some(rest) = quick.strip_prefix(&prefix) {
            return Some((kind, rest));
        }
    }
    None
}

fn format_request_note(quick: &str) -> String {
    if quick.is_empty() {
        return String::new();
    }
    let Some(rest) = quick.strip_prefix('[') else {
        return quick.to_string();
    };
    let Some((pos, after)) = rest.split_once(']') else {
        return quick.to_string();
    };
    let after = after.trim_start();
    let Some((kind, body)) = split_quick(after) else {
        return quick.to_string();
    };
    let kind_name = match kind {
        "F" => "Fixed",
        "EF" => "EPR Fixed",
        "P" => "PPS",
        "SA" => "SPR AVS",
        "EA" => "EPR AVS",
        "V" => "Variable",
        "EV" => "EPR Variable",
        "B" => "Battery",
        "EB" => "EPR Battery",
        other => other,
    };
    format!(
        "Position:{pos} {kind_name}:{}",
        protect_note_token(&body.replace('@', ","))
    )
}

/// 数字范围里的 `-` 换成非断行连字符，Note 只在空格处折行。
fn protect_note_token(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    for i in 0..chars.len() {
        if chars[i] == '-'
            && i > 0
            && i + 1 < chars.len()
            && chars[i - 1].is_ascii_digit()
            && chars[i + 1].is_ascii_digit()
        {
            out.push('\u{2011}');
        } else {
            out.push(chars[i]);
        }
    }
    out
}

fn format_vdm_note(meta: &Metadata) -> String {
    let header = meta
        .data_objects()
        .and_then(|objs| objs.iter().find(|m| m.field() == "VDM Header"));
    let Some(header) = header else {
        return String::new();
    };
    let mut parts = Vec::new();
    if header.get("VDM Type").and_then(|m| m.value().as_str()) == Some("Unstructured") {
        parts.push("Unstructured".to_string());
    }
    if let Some(svid) = header
        .get("SVID")
        .or_else(|| header.get(fields::VID))
        .and_then(|m| m.value().as_str())
    {
        parts.push(svid.to_string());
    }
    if let Some(command) = header.get("Command") {
        if let Some(s) = command.value().as_str() {
            if !s.is_empty() {
                parts.push(s.to_string());
            }
        } else if let Some(n) = command.value().as_int() {
            parts.push(format!("CMD {n}"));
        }
    }
    if let Some(cmd_type) = header.get("Command Type").and_then(|m| m.value().as_str()) {
        if !cmd_type.is_empty() {
            parts.push(cmd_type.to_string());
        }
    }
    parts.join(" ")
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
        assert_eq!(s.summary, "Fixed: 5.0V");
        assert_eq!(s.direction, "SRC→SNK");
        assert_eq!(s.rev, "V3");
        assert_eq!(s.obj, "1");
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
        assert_eq!(s.direction, "SRC|SNK→Plug");

        let from_plug = parser.parse(
            &[0x41, 0x01],
            ParseOptions {
                sop: Sop::SopPrime,
                ..Default::default()
            },
        );
        assert_eq!(summarize(&from_plug).direction, "SRC|SNK←Plug");
    }

    #[test]
    fn log_seq_skips_dividers_and_decode_is_o1() {
        let mut log = PdLog::default();
        let mut parser = Parser::new();
        let caps = pd_frame(&[0xA1, 0x11, 0x2C, 0x91, 0x01, 0x08], 224);
        let crc = pd_frame(&[0x41, 0x00], 224);
        let e0 = log
            .push_message(
                1,
                caps.clone(),
                decode_pd_report(&mut parser, &caps).unwrap(),
                None,
                None,
            )
            .unwrap();
        assert_eq!(e0.seq, Some(0));
        let e1 = log
            .push_message(
                2,
                crc.clone(),
                decode_pd_report(&mut parser, &crc).unwrap(),
                None,
                None,
            )
            .unwrap();
        assert_eq!(e1.seq, Some(1));
        assert!(log.meta_at(1).is_some());
        assert!(log.meta_at(2).is_none());
        assert_eq!(
            summarize(log.meta_at(0).unwrap()).msg_type,
            "Source_Capabilities"
        );
        assert_eq!(summarize(log.meta_at(1).unwrap()).msg_type, "GoodCRC");
        assert_eq!(log.events_after(None).len(), 2);
        assert_eq!(log.events_after(Some(0)).len(), 1);
        assert_eq!(log.events_after(Some(1)).len(), 0);
        assert_eq!(log.events_after(Some(0))[0].seq, Some(1));
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
                    vbus: Some(5.097),
                    ibus: Some(0.044),
                },
                PdLoadEntry {
                    t: 2,
                    divider: true,
                    bytes: vec![],
                    ..Default::default()
                },
                PdLoadEntry {
                    t: 3,
                    divider: false,
                    bytes: req,
                    ..Default::default()
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
        assert_eq!(s.summary, "Position:2 Fixed:9.0V,3.0A");
        assert_eq!(s.direction, "SRC←SNK");
        assert_eq!(events[0].vbus, Some(5.097));
        assert_eq!(events[0].ibus, Some(0.044));
        assert_eq!(events[2].vbus, None);
        assert_eq!(events[0].gen, 1);
        assert_eq!(events[2].gen, 1);
    }

    #[test]
    fn replace_failure_keeps_existing_messages() {
        let caps = pd_frame(&[0xA1, 0x11, 0x2C, 0x91, 0x01, 0x08], 224);
        let mut log = PdLog::default();
        log.replace(vec![PdLoadEntry {
            t: 1,
            divider: false,
            bytes: caps,
            ..Default::default()
        }])
        .unwrap();
        assert!(log.meta_at(0).is_some());

        let failed = log.replace(vec![PdLoadEntry {
            t: 2,
            divider: false,
            bytes: vec![],
            ..Default::default()
        }]);
        assert!(failed.is_err());
        assert!(log.meta_at(0).is_some());
    }

    #[test]
    fn cap_note_uses_non_breaking_hyphen_in_ranges() {
        assert_eq!(
            format_cap_note(&[
                "F 5.0V@3.0A".into(),
                "P 5.0-21.0V@5.0A".into(),
                "SA 9-15V@3.0A 15-20V@5.0A".into()
            ]),
            "Fixed: 5.0V  SPR AVS: 9\u{2011}15V@3.0A 15\u{2011}20V@5.0A  PPS: 5.0\u{2011}21.0V"
        );
    }
}

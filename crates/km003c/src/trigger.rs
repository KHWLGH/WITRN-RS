//! Protocol trigger over the CDC virtual serial port: a PDM session, the protocol the
//! meter has entered, and the command set the firmware understands.
//!
//! The firmware answers in free text (sometimes GBK) and the binary PDO tail of
//! `pd pdo`; replies are validated strictly so that an empty, partial or failed answer
//! never reads as success.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};

use crate::protocol::pd::Pdo as WirePdo;
use crate::text::{
    avs_current_ma, format_avs_label, make_pdo, normalize_scan_text, parse_detected_protocols,
    parse_pdos, sanitize_trigger_text, spr_avs_pdos,
};
use crate::transport::serial::{self, CdcPort};
use crate::types::{DetectedProtocol, PdmConfig, TriggerCommand, TriggerOutcome, TriggerPdo};
use crate::StopSignal;

fn fixed_kind(pos: u8, voltage_mv: u32) -> &'static str {
    if pos >= 8 || voltage_mv > 20_000 {
        "epr_fixed"
    } else {
        "fixed"
    }
}

fn wire_one(pos: u8, p: &WirePdo) -> Vec<TriggerPdo> {
    match p {
        WirePdo::Fixed {
            voltage_mv,
            max_current_ma,
            ..
        } => vec![make_pdo(
            pos,
            fixed_kind(pos, *voltage_mv),
            *voltage_mv,
            *voltage_mv,
            Some(*max_current_ma),
            false,
        )],
        WirePdo::Pps {
            min_voltage_mv,
            max_voltage_mv,
            max_current_ma,
        } => vec![make_pdo(
            pos,
            "pps",
            *min_voltage_mv,
            *max_voltage_mv,
            Some(*max_current_ma),
            true,
        )],
        WirePdo::Avs {
            min_voltage_mv,
            max_voltage_mv,
            pdp_w,
            epr,
            max_current_9v_15v_ma,
            max_current_15v_20v_ma,
        } => {
            if *epr {
                let pdp = (*pdp_w > 0).then_some(*pdp_w);
                let cur = avs_current_ma(None, None, pdp, *max_voltage_mv);
                let mut rec = make_pdo(pos, "epr_avs", *min_voltage_mv, *max_voltage_mv, cur, true);
                rec.label = format_avs_label(
                    pos,
                    "epr_avs",
                    *min_voltage_mv,
                    *max_voltage_mv,
                    None,
                    None,
                    pdp,
                );
                vec![rec]
            } else {
                spr_avs_pdos(
                    pos,
                    "spr_avs",
                    *max_current_9v_15v_ma,
                    *max_current_15v_20v_ma,
                )
            }
        }
        WirePdo::Battery {
            min_voltage_mv,
            max_voltage_mv,
            ..
        } => vec![make_pdo(
            pos,
            "battery",
            *min_voltage_mv,
            *max_voltage_mv,
            None,
            true,
        )],
        WirePdo::Variable {
            min_voltage_mv,
            max_voltage_mv,
            max_current_ma,
        } => vec![make_pdo(
            pos,
            "variable",
            *min_voltage_mv,
            *max_voltage_mv,
            Some(*max_current_ma),
            true,
        )],
        WirePdo::Unknown(_) => Vec::new(),
    }
}

/// Map sniffed capability objects to requestable PDOs, keeping 1-based positions.
pub fn wire_pdos(pdos: &[WirePdo]) -> Vec<TriggerPdo> {
    pdos.iter()
        .enumerate()
        .flat_map(|(i, p)| wire_one((i + 1) as u8, p))
        .collect()
}

fn wire_pdos_indexed(pdos: &[(u8, WirePdo)]) -> Vec<TriggerPdo> {
    pdos.iter().flat_map(|(pos, p)| wire_one(*pos, p)).collect()
}

fn pdo_voltage_ok(p: &WirePdo) -> bool {
    let (min, max) = match p {
        WirePdo::Fixed { voltage_mv, .. } => (*voltage_mv, *voltage_mv),
        WirePdo::Battery {
            min_voltage_mv,
            max_voltage_mv,
            ..
        }
        | WirePdo::Variable {
            min_voltage_mv,
            max_voltage_mv,
            ..
        }
        | WirePdo::Pps {
            min_voltage_mv,
            max_voltage_mv,
            ..
        }
        | WirePdo::Avs {
            min_voltage_mv,
            max_voltage_mv,
            ..
        } => (*min_voltage_mv, *max_voltage_mv),
        WirePdo::Unknown(_) => return false,
    };
    min > 0 && max > 0 && max <= 50_000 && min <= max
}

/// Whitespace / control padding the firmware may insert around binary PDO words.
/// Do NOT include `,` / `;` — those can be valid LE object bytes (e.g. 5V/3A starts with 0x2C).
fn is_pdo_padding(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\r' | b'\n' | 0x0B | 0x00)
}

/// Between objects, skip newlines / VT — but not `0x00`, which is an empty PDO word.
fn is_inter_word_padding(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\r' | b'\n' | 0x0B)
}

fn try_parse_pdo_stream(raw: &[u8], start: usize, count: Option<usize>) -> Vec<(u8, WirePdo)> {
    let mut pos = start;
    let mut slot: u8 = 0;
    let mut parsed = Vec::new();
    loop {
        if let Some(n) = count {
            if slot as usize >= n {
                break;
            }
        }
        while pos < raw.len() && is_inter_word_padding(raw[pos]) {
            pos += 1;
        }
        if pos + 4 > raw.len() {
            break;
        }
        let word = u32::from_le_bytes([raw[pos], raw[pos + 1], raw[pos + 2], raw[pos + 3]]);
        pos += 4;
        slot = slot.saturating_add(1);
        if word == 0 {
            if count.is_none() {
                break;
            }
            continue;
        }
        let pdo = WirePdo::parse(word);
        if matches!(pdo, WirePdo::Unknown(_)) || !pdo_voltage_ok(&pdo) {
            if count.is_none() {
                break;
            }
            continue;
        }
        parsed.push((slot, pdo));
    }
    parsed
}

fn pdo_parse_better(a: &[(u8, WirePdo)], b: &[(u8, WirePdo)]) -> bool {
    let max_a = a.iter().map(|(p, _)| *p).max().unwrap_or(0);
    let max_b = b.iter().map(|(p, _)| *p).max().unwrap_or(0);
    b.len() > a.len() || (b.len() == a.len() && max_b > max_a)
}

/// Decode KM003C CDC `pd pdo` binary tails: ASCII `pdo:N` followed by LE u32 objects.
/// Firmware may insert newlines / control bytes between objects.
fn parse_binary_pdos(raw: &[u8]) -> Vec<TriggerPdo> {
    let lower: Vec<u8> = raw.iter().map(|b| b.to_ascii_lowercase()).collect();
    let marker = b"pdo:";
    let Some(start) = lower.windows(marker.len()).position(|w| w == marker) else {
        return Vec::new();
    };
    let after_marker = start + marker.len();
    let mut idx = after_marker;
    let mut count: Option<usize> = None;
    while idx < raw.len() && raw[idx].is_ascii_digit() {
        let digit = (raw[idx] - b'0') as usize;
        count = Some(count.unwrap_or(0) * 10 + digit);
        idx += 1;
    }
    while idx < raw.len() && is_pdo_padding(raw[idx]) {
        idx += 1;
    }

    let mut best: Vec<(u8, WirePdo)> = Vec::new();
    for align in 0..=3 {
        let parsed = try_parse_pdo_stream(raw, idx + align, count);
        if parsed.is_empty() {
            continue;
        }
        if pdo_parse_better(&best, &parsed) {
            best = parsed;
        }
        if let Some(n) = count {
            if best.len() == n {
                break;
            }
        }
    }
    wire_pdos_indexed(&best)
}

fn pdo_list_score(pdos: &[TriggerPdo]) -> (u8, usize) {
    let max_pos = pdos.iter().map(|p| p.position).max().unwrap_or(0);
    (max_pos, pdos.len())
}

fn merge_trigger_pdos(a: Vec<TriggerPdo>, b: Vec<TriggerPdo>) -> Vec<TriggerPdo> {
    if pdo_list_score(&b) > pdo_list_score(&a) {
        b
    } else {
        a
    }
}

fn pick_trigger_pdos(binary: Vec<TriggerPdo>, ascii: Vec<TriggerPdo>) -> Vec<TriggerPdo> {
    merge_trigger_pdos(binary, ascii)
}

fn pdos_lack_epr(pdos: &[TriggerPdo]) -> bool {
    pdos.is_empty()
        || pdos.iter().all(|p| {
            p.position <= 7
                && p.volt_max_mv <= 20_000
                && !matches!(p.kind.as_str(), "epr_avs" | "epr_fixed")
        })
}

fn decode_pd_pdo_reply(entry: &str, pdo: &str, raw: &[u8]) -> (Vec<TriggerPdo>, String) {
    let binary = parse_binary_pdos(raw);
    let ascii = parse_pdos(&sanitize_trigger_text(pdo));
    let pdos = pick_trigger_pdos(binary, ascii);
    let message = nonempty(format_pdo_message(entry, pdo, &pdos));
    (pdos, message)
}

#[derive(Default)]
struct CdcState {
    port: Option<CdcPort>,
    // Owned by one device session, not by the short-lived CDC transport.
    pdm: ConfirmedPdm,
    /// Session stop or command cancel; aborts replies and the waits between steps.
    stop: StopSignal,
}

#[derive(Default)]
struct ConfirmedPdm(Option<PdmConfig>);

impl ConfirmedPdm {
    fn command(config: &PdmConfig) -> String {
        format!(
            "pdm set type={},em={},sink={}",
            config.pd_type, config.em, config.sink
        )
    }

    fn apply(
        &mut self,
        config: PdmConfig,
        send: impl FnOnce(&str) -> Result<String>,
    ) -> Result<String> {
        let reply = send(&Self::command(&config))?;
        ensure_trigger_reply(&reply)?;
        self.0 = Some(config);
        Ok(reply)
    }

    fn reopen(&self, mut send: impl FnMut(&str) -> Result<String>) -> Result<()> {
        let reply = send("pdm open").context("重新打开 PDM 失败")?;
        ensure_trigger_reply(&reply).context("重新打开 PDM 失败")?;
        if let Some(config) = &self.0 {
            let command = Self::command(config);
            let reply = send(&command).with_context(|| format!("恢复 PDM 参数失败：{command}"))?;
            ensure_trigger_reply(&reply)
                .with_context(|| format!("恢复 PDM 参数失败：{command}"))?;
        }
        Ok(())
    }
}

fn ensure_cdc<'a>(
    cdc: &'a mut CdcState,
    serial: Option<&str>,
    pdm_open: bool,
) -> Result<&'a mut CdcPort> {
    if cdc.port.is_none() {
        if cdc.stop.is_set() {
            bail!("已取消");
        }
        let mut port = serial::open_matching(None, serial)?;
        port.set_stop(cdc.stop.clone());
        if pdm_open {
            cdc.pdm
                .reopen(|command| port.send_command(command, serial::suggested_wait(command)))?;
        }
        cdc.port = Some(port);
    }
    cdc.port.as_mut().ok_or_else(|| anyhow!("CDC 未打开"))
}

fn looks_empty(s: &str) -> bool {
    let t = s.trim();
    t.is_empty() || t == "(无回复)"
}

fn reopen_cdc(
    cdc: &mut CdcState,
    serial: Option<&str>,
    mode: &mut Option<String>,
    pdm_open: bool,
) -> Result<()> {
    cdc.port = None;
    *mode = None;
    cdc.stop.sleep(Duration::from_millis(300))?;
    let _ = ensure_cdc(cdc, serial, pdm_open)?;
    Ok(())
}

fn pdm_raw_kind(command: &str) -> Option<bool> {
    match command.trim().to_ascii_lowercase().as_str() {
        "pdm open" => Some(true),
        "pdm close" => Some(false),
        _ => None,
    }
}

fn cmd_requires_pdm(cmd: &TriggerCommand) -> bool {
    !matches!(
        cmd,
        TriggerCommand::PdmOpen | TriggerCommand::PdmClose | TriggerCommand::Raw { .. }
    )
}

fn wants_pd_drain(cmd: &TriggerCommand) -> bool {
    matches!(
        cmd,
        TriggerCommand::PdPdo
            | TriggerCommand::PdCmd { .. }
            | TriggerCommand::PdReq { .. }
            | TriggerCommand::PdData { .. }
            | TriggerCommand::Ufcs { .. }
            | TriggerCommand::UfcsCmd { .. }
    )
}

fn volt_arg(v: &str) -> String {
    let t = v.trim();
    if t.ends_with('V') || t.ends_with('v') {
        t.to_string()
    } else {
        format!("{t}V")
    }
}

struct TriggerOut {
    ok: bool,
    message: String,
    pdos: Vec<TriggerPdo>,
    protocols: Vec<DetectedProtocol>,
    code: Option<String>,
}

fn pack(message: String) -> TriggerOut {
    let message = sanitize_trigger_text(&message);
    let message = if message.trim().is_empty() {
        "(无回复)".into()
    } else {
        message
    };
    let pdos = parse_pdos(&message);
    let protocols = parse_detected_protocols(&message);
    TriggerOut {
        ok: true,
        message,
        pdos,
        protocols,
        code: None,
    }
}

fn nonempty(s: String) -> String {
    let t = s.trim();
    if t.is_empty() {
        "(无回复)".into()
    } else {
        t.to_string()
    }
}

fn join_text(parts: &[String]) -> String {
    let merged = parts
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty() && *s != "(无回复)")
        .collect::<Vec<_>>()
        .join("\n");
    nonempty(merged)
}

fn send_stream(
    cdc: &mut CdcState,
    serial: Option<&str>,
    command: &str,
    pdm_open: bool,
    on_line: &mut dyn FnMut(&str),
) -> Result<String> {
    let port = ensure_cdc(cdc, serial, pdm_open)?;
    port.send_command_stream(command, serial::suggested_wait(command), |line| {
        on_line(line);
    })
    .map(nonempty)
    .with_context(|| format!("KM003 命令 {command} 失败"))
}

fn send_stream_raw(
    cdc: &mut CdcState,
    serial: Option<&str>,
    command: &str,
    pdm_open: bool,
    on_line: &mut dyn FnMut(&str),
) -> Result<(String, Vec<u8>)> {
    let port = ensure_cdc(cdc, serial, pdm_open)?;
    let (text, raw) =
        port.send_command_stream_raw(command, serial::suggested_wait(command), |line| {
            on_line(line);
        })?;
    Ok((nonempty(text), raw))
}

/// Send `reset` and give the module time to settle. The reply itself is not checked,
/// but a stop request still ends the wait with an error.
fn reset_module(
    cdc: &mut CdcState,
    serial: Option<&str>,
    mode: &mut Option<String>,
    pdm_open: bool,
    on_line: &mut dyn FnMut(&str),
) -> Result<()> {
    let _ = send_stream(cdc, serial, "reset", pdm_open, on_line);
    *mode = None;
    cdc.stop.sleep(Duration::from_millis(800))
}

fn is_list_proto(proto: &str) -> bool {
    proto == "list" || proto == "list+"
}

fn ensure_protocol(
    cdc: &mut CdcState,
    serial: Option<&str>,
    mode: &mut Option<String>,
    wanted: &str,
    pdm_open: bool,
    on_line: &mut dyn FnMut(&str),
) -> Result<String> {
    if wanted == "pd" {
        // PD recovery belongs to the caller: one entry per complete PDM reopen,
        // with no hidden Reset/retry that can overrun the caller's ACK deadline.
        let reply = ensure_pd_entry(mode, || {
            send_stream(cdc, serial, "entry pd", pdm_open, on_line)
        })?;
        if !reply.is_empty() {
            cdc.stop.sleep(Duration::from_millis(300))?;
        }
        return Ok(reply);
    }
    let list_like = is_list_proto(wanted);
    if !list_like && mode.as_deref() == Some(wanted) {
        return Ok(String::new());
    }
    if list_like || mode.is_some() {
        reset_module(cdc, serial, mode, pdm_open, on_line)?;
    }
    let cmd = format!("entry {wanted}");
    let resp = send_stream(cdc, serial, &cmd, pdm_open, on_line)?;
    if list_like {
        *mode = None;
        return Ok(resp);
    }
    if serial::entry_failed(&resp) {
        reset_module(cdc, serial, mode, pdm_open, on_line)?;
        let retry = send_stream(cdc, serial, &cmd, pdm_open, on_line)?;
        if serial::entry_failed(&retry) {
            *mode = None;
            bail!("进入 {wanted} 失败:\n{retry}");
        }
        *mode = Some(wanted.to_string());
        cdc.stop.sleep(Duration::from_millis(300))?;
        return Ok(retry);
    }
    *mode = Some(wanted.to_string());
    cdc.stop.sleep(Duration::from_millis(300))?;
    Ok(resp)
}

fn ensure_pd_entry(
    mode: &mut Option<String>,
    send: impl FnOnce() -> Result<String>,
) -> Result<String> {
    if mode.as_deref() == Some("pd") {
        return Ok(String::new());
    }
    *mode = None;
    let reply = send().context("进入 PD 失败")?;
    ensure_trigger_reply(&reply).context("进入 PD 失败")?;
    if !serial::entry_ready(&reply) && !reply.trim().eq_ignore_ascii_case("ok") {
        return Err(
            ProtocolReplyError::Unconfirmed(format!("进入 PD 未收到就绪确认：{reply}")).into(),
        );
    }
    *mode = Some("pd".into());
    Ok(reply)
}

fn then_follow(
    cdc: &mut CdcState,
    serial: Option<&str>,
    mode: &mut Option<String>,
    proto: &str,
    follow: &str,
    pdm_open: bool,
    on_line: &mut dyn FnMut(&str),
) -> Result<String> {
    let entry = ensure_protocol(cdc, serial, mode, proto, pdm_open, on_line)?;
    let second = send_stream(cdc, serial, follow, pdm_open, on_line)?;
    Ok(join_text(&[entry, second]))
}

fn format_pdo_lines(pdos: &[TriggerPdo]) -> String {
    pdos.iter()
        .map(|p| p.label.clone())
        .collect::<Vec<_>>()
        .join("\n")
}

fn is_pdo_status_line(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return false;
    }
    let lower = t.to_ascii_lowercase();
    if lower == "ok" {
        return true;
    }
    lower.contains("attach")
        || lower.contains("detach")
        || lower.contains("cc1")
        || lower.contains("cc2")
        || lower.contains("ready")
        || lower.contains("max power")
        || t.contains("最大功率")
}

/// Keep handshake/status lines from CDC text and append binary-parsed `#N` labels once.
fn format_pdo_message(entry: &str, pdo_text: &str, pdos: &[TriggerPdo]) -> String {
    let mut status = Vec::new();
    let mut seen = Vec::new();
    for part in [entry, pdo_text] {
        for line in part.lines() {
            let trimmed = line.trim();
            if !is_pdo_status_line(trimmed) {
                continue;
            }
            let lower = trimmed.to_ascii_lowercase();
            // Collapse near-duplicate status lines (e.g. ready:5217mV vs ready:5215mV).
            let key = if lower == "ok" {
                "ok".to_string()
            } else if lower.contains("ready") {
                "ready".to_string()
            } else if lower.contains("max power") || trimmed.contains("最大功率") {
                "max_power".to_string()
            } else if lower.contains("attach") || lower.contains("detach") {
                "attach".to_string()
            } else {
                lower.split_whitespace().collect::<Vec<_>>().join(" ")
            };
            if seen.iter().any(|s: &String| s == &key) {
                continue;
            }
            seen.push(key);
            status.push(trimmed.to_string());
        }
    }
    let labels = format_pdo_lines(pdos);
    if status.is_empty() {
        labels
    } else if labels.is_empty() {
        status.join("\n")
    } else {
        format!("{}\n{}", status.join("\n"), labels)
    }
}

fn run_pd_pdo(
    cdc: &mut CdcState,
    serial: Option<&str>,
    mode: &mut Option<String>,
    pdm_open: bool,
    on_line: &mut dyn FnMut(&str),
) -> Result<TriggerOut> {
    let attempt = |cdc: &mut CdcState,
                   mode: &mut Option<String>,
                   on_line: &mut dyn FnMut(&str)|
     -> Result<(String, String, Vec<u8>)> {
        let entry = ensure_protocol(cdc, serial, mode, "pd", pdm_open, on_line)?;
        let (pdo, raw) = send_stream_raw(cdc, serial, "pd pdo", pdm_open, on_line)?;
        Ok((entry, pdo, raw))
    };
    let (mut entry, mut pdo, raw) = attempt(cdc, mode, on_line)?;
    let (mut pdos, mut message) = decode_pd_pdo_reply(&entry, &pdo, &raw);
    if looks_empty(&pdo) || pdos_lack_epr(&pdos) {
        reopen_cdc(cdc, serial, mode, pdm_open)?;
        let again = attempt(cdc, mode, on_line)?;
        let (pdos2, message2) = decode_pd_pdo_reply(&again.0, &again.1, &again.2);
        if pdo_list_score(&pdos2) > pdo_list_score(&pdos) {
            entry = again.0;
            pdo = again.1;
            pdos = pdos2;
            message = message2;
        } else if !pdos2.is_empty() {
            pdos = merge_trigger_pdos(pdos, pdos2);
            message = nonempty(format_pdo_message(&entry, &pdo, &pdos));
        }
    }
    if !pdos.is_empty() {
        let protocols = parse_detected_protocols(&message);
        return Ok(TriggerOut {
            ok: true,
            message,
            pdos,
            protocols,
            code: None,
        });
    }
    let mut parts = vec![entry, sanitize_trigger_text(&pdo)];
    if parse_pdos(&join_text(&parts)).is_empty() {
        let cap = send_stream(cdc, serial, "pd cmd=7", pdm_open, on_line).unwrap_or_default();
        parts.push(cap);
    }
    Ok(pack(join_text(&parts)))
}

fn run_ufcs_pdo(
    cdc: &mut CdcState,
    serial: Option<&str>,
    mode: &mut Option<String>,
    follow: &str,
    pdm_open: bool,
    on_line: &mut dyn FnMut(&str),
) -> Result<String> {
    let mut text = then_follow(cdc, serial, mode, "ufcs", follow, pdm_open, on_line)?;
    if follow == "ufcs pdo" && parse_pdos(&text).is_empty() {
        reopen_cdc(cdc, serial, mode, pdm_open)?;
        text = then_follow(cdc, serial, mode, "ufcs", follow, pdm_open, on_line)?;
    }
    Ok(text)
}

fn clean_hex(src: &str) -> Result<String> {
    let hex: String = src.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() < 2 || hex.len() % 2 != 0 {
        bail!("pd data 需要偶数位十六进制，例如 018F1401A000FF");
    }
    Ok(hex.to_ascii_uppercase())
}

fn run_trigger(
    cdc: &mut CdcState,
    serial: Option<&str>,
    cmd: &TriggerCommand,
    mode: &mut Option<String>,
    pdm_open: &mut bool,
    on_line: &mut dyn FnMut(&str),
) -> Result<TriggerOut> {
    if cmd_requires_pdm(cmd) && !*pdm_open {
        return Ok(TriggerOut {
            ok: false,
            message: "请先打开 PDM".into(),
            pdos: Vec::new(),
            protocols: Vec::new(),
            code: Some("pdm_required".into()),
        });
    }
    let ready = *pdm_open;
    let message = match cmd {
        TriggerCommand::PdmOpen => {
            // Explicit opens are followed by the caller's frozen PdmSet. Do not
            // implicitly open/restore and then open a second time here.
            *mode = None;
            let text = send_stream(cdc, serial, "pdm open", false, on_line)?;
            ensure_trigger_reply(&text)?;
            *pdm_open = true;
            text
        }
        TriggerCommand::PdmClose => {
            // Losing CDC does not mean the hardware stopped its PPS negotiation.
            // Reopen only the transport; never implicitly reopen PDM before closing it.
            let result = send_stream(cdc, serial, "pdm close", false, on_line);
            cdc.port = None;
            *mode = None;
            *pdm_open = false;
            result?
        }
        TriggerCommand::List { plus } => {
            let proto = if *plus { "list+" } else { "list" };
            let raw = ensure_protocol(cdc, serial, mode, proto, ready, on_line)?;
            normalize_scan_text(&raw)
        }
        TriggerCommand::PdmSet { pd_type, em, sink } => {
            // The negotiated mode predates these settings, even if applying them fails.
            *mode = None;
            // This command supplies authoritative settings. A reconnect must
            // not replay older settings that could prevent applying the new ones.
            let reopening = cdc.port.is_none();
            ensure_cdc(cdc, serial, false)?;
            if reopening && ready {
                let reply = send_stream(cdc, serial, "pdm open", false, on_line)?;
                ensure_trigger_reply(&reply)?;
            }
            let CdcState { port, pdm, .. } = cdc;
            pdm.apply(
                PdmConfig {
                    pd_type: *pd_type,
                    em: *em,
                    sink: *sink,
                },
                |command| {
                    port.as_mut().context("CDC 未打开")?.send_command_stream(
                        command,
                        serial::suggested_wait(command),
                        on_line,
                    )
                },
            )?
        }
        TriggerCommand::Entry { protocol } => ensure_protocol(
            cdc,
            serial,
            mode,
            &protocol.trim().to_ascii_lowercase(),
            ready,
            on_line,
        )?,
        TriggerCommand::PdPdo => return run_pd_pdo(cdc, serial, mode, ready, on_line),
        TriggerCommand::PdReq {
            position,
            volt_mv,
            cur_ma,
        } => {
            let mut s = format!("pd req={position}");
            if let Some(v) = volt_mv {
                s.push_str(&format!(",volt={v}"));
            }
            if let Some(c) = cur_ma {
                s.push_str(&format!(",cur={c}"));
            }
            let entry = ensure_protocol(cdc, serial, mode, "pd", ready, on_line)?;
            let response = send_stream(cdc, serial, &s, ready, on_line)?;
            // An earlier "PD ready" must not hide an empty/rejected PDO response.
            ensure_trigger_reply(&response).with_context(|| format!("KM003 请求失败：{s}"))?;
            join_text(&[entry, response])
        }
        TriggerCommand::PdCmd { cmd } => then_follow(
            cdc,
            serial,
            mode,
            "pd",
            &format!("pd cmd={cmd}"),
            ready,
            on_line,
        )?,
        TriggerCommand::PdData { hex } => {
            let hex = clean_hex(hex)?;
            then_follow(
                cdc,
                serial,
                mode,
                "pd",
                &format!("pd data={hex}"),
                ready,
                on_line,
            )?
        }
        TriggerCommand::Qc { voltage } => then_follow(
            cdc,
            serial,
            mode,
            "qc",
            &format!("qc {}", volt_arg(voltage)),
            ready,
            on_line,
        )?,
        TriggerCommand::Qc3 { volt_mv } => then_follow(
            cdc,
            serial,
            mode,
            "qc",
            &format!("qc3 volt={volt_mv}"),
            ready,
            on_line,
        )?,
        TriggerCommand::Qc3Adjust { steps } => {
            if *steps == 0 {
                ensure_protocol(cdc, serial, mode, "qc", ready, on_line)?
            } else {
                let n = steps.unsigned_abs();
                let follow = if *steps > 0 {
                    format!("qc3 inc={n}")
                } else {
                    format!("qc3 dec={n}")
                };
                then_follow(cdc, serial, mode, "qc", &follow, ready, on_line)?
            }
        }
        TriggerCommand::Fcp { voltage } => then_follow(
            cdc,
            serial,
            mode,
            "fcp",
            &format!("fcp {}", volt_arg(voltage)),
            ready,
            on_line,
        )?,
        TriggerCommand::Afc { voltage } => then_follow(
            cdc,
            serial,
            mode,
            "afc",
            &format!("afc {}", volt_arg(voltage)),
            ready,
            on_line,
        )?,
        TriggerCommand::Sfcp { voltage } => then_follow(
            cdc,
            serial,
            mode,
            "sfcp",
            &format!("sfcp {}", volt_arg(voltage)),
            ready,
            on_line,
        )?,
        TriggerCommand::Scp { volt_mv, cur_ma } => then_follow(
            cdc,
            serial,
            mode,
            "scp",
            &format!("scp volt={volt_mv},cur={cur_ma}"),
            ready,
            on_line,
        )?,
        TriggerCommand::Vfcp { volt_mv, cur_ma } => then_follow(
            cdc,
            serial,
            mode,
            "vfcp",
            &format!("vfcp volt={volt_mv},cur={cur_ma}"),
            ready,
            on_line,
        )?,
        TriggerCommand::Ufcs {
            req,
            volt_mv,
            cur_ma,
        } => {
            let c = match (volt_mv, cur_ma) {
                (Some(v), Some(a)) => format!("ufcs req={req},volt={v},cur={a}"),
                (Some(v), None) => format!("ufcs req={req},volt={v}"),
                (None, Some(a)) => format!("ufcs req={req},cur={a}"),
                (None, None) => "ufcs pdo".into(),
            };
            run_ufcs_pdo(cdc, serial, mode, &c, ready, on_line)?
        }
        TriggerCommand::UfcsCmd { cmd } => then_follow(
            cdc,
            serial,
            mode,
            "ufcs",
            &format!("ufcs cmd={cmd}"),
            ready,
            on_line,
        )?,
        TriggerCommand::Reset => {
            reset_module(cdc, serial, mode, ready, on_line)?;
            "reset".into()
        }
        TriggerCommand::Raw { command } => {
            // Raw configuration may contain firmware-specific or partial fields.
            // Do not replay an older typed configuration over a manual change.
            if command.trim().to_ascii_lowercase().starts_with("pdm set ") {
                cdc.pdm = ConfirmedPdm::default();
                *mode = None;
            }
            let text = send_stream(cdc, serial, command, ready, on_line)?;
            if let Some(open) = pdm_raw_kind(command) {
                *pdm_open = open;
                if !open {
                    cdc.port = None;
                    *mode = None;
                }
            }
            text
        }
    };

    if matches!(
        cmd,
        TriggerCommand::PdmOpen
            | TriggerCommand::PdmClose
            | TriggerCommand::PdmSet { .. }
            | TriggerCommand::PdReq { .. }
    ) {
        ensure_trigger_reply(&message)?;
    }
    Ok(pack(message))
}

#[derive(Debug)]
enum ProtocolReplyError {
    Rejected(String),
    Unconfirmed(String),
}
impl std::fmt::Display for ProtocolReplyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rejected(message) | Self::Unconfirmed(message) => f.write_str(message),
        }
    }
}
impl std::error::Error for ProtocolReplyError {}

fn can_retry_pd_in_session(
    command: &TriggerCommand,
    mode: Option<&str>,
    error: &anyhow::Error,
) -> bool {
    matches!(command, TriggerCommand::PdReq { .. })
        && mode == Some("pd")
        && matches!(
            error.downcast_ref::<ProtocolReplyError>(),
            Some(ProtocolReplyError::Rejected(_))
        )
}

fn ensure_trigger_reply(message: &str) -> Result<()> {
    if looks_empty(message) {
        return Err(
            ProtocolReplyError::Unconfirmed(format!("协议命令未确认成功：{message}")).into(),
        );
    }
    if serial::command_failed(message) {
        return Err(ProtocolReplyError::Rejected(format!("协议命令未确认成功：{message}")).into());
    }
    Ok(())
}

/// How often a PD-ish command re-checks the sniffer while waiting for capabilities.
const PDO_CACHE_POLL: Duration = Duration::from_millis(40);
/// How long a PD-ish command whose reply carried no PDO table waits for the sniffer.
const PDO_CACHE_WAIT: Duration = Duration::from_millis(700);

/// The most recent Source_Capabilities the bulk sniffer decoded, shared with the trigger.
///
/// Commands such as `pd req` often answer with no PDO table; the source's capabilities
/// then arrive on the sniffer a moment later, so the trigger waits for them briefly.
#[derive(Clone, Default)]
pub struct PdoCache(Arc<Mutex<Option<CachedPdos>>>);

/// When the list was recorded, and the list.
type CachedPdos = (Instant, Vec<TriggerPdo>);

impl PdoCache {
    /// Record a capability list. Empty lists are ignored.
    pub fn update(&self, pdos: Vec<TriggerPdo>) {
        if pdos.is_empty() {
            return;
        }
        if let Ok(mut slot) = self.0.lock() {
            *slot = Some((Instant::now(), pdos));
        }
    }

    /// A list recorded at or after `since`, waiting up to `budget` for one to arrive.
    fn wait_since(
        &self,
        since: Instant,
        budget: Duration,
        stop: &StopSignal,
    ) -> Option<Vec<TriggerPdo>> {
        let deadline = Instant::now() + budget;
        loop {
            if let Ok(slot) = self.0.lock() {
                if let Some((at, pdos)) = slot.as_ref() {
                    if *at >= since {
                        return Some(pdos.clone());
                    }
                }
            }
            let now = Instant::now();
            if now >= deadline || stop.sleep(PDO_CACHE_POLL.min(deadline - now)).is_err() {
                return None;
            }
        }
    }
}

/// One meter's trigger state: the CDC port, the PDM session and the entered protocol.
///
/// Commands run one at a time on the caller's thread. The CDC port opens on first use,
/// matched to the meter by USB serial number; if PDM was open when the port was lost,
/// reopening it replays `pdm open` and the last confirmed `pdm set` first.
pub struct TriggerSession {
    serial: Option<String>,
    cdc: CdcState,
    mode: Option<String>,
    pdm_open: bool,
    /// A cancelled scan leaves the firmware mid-sequence; reset before the next command.
    needs_reset: bool,
}

impl TriggerSession {
    pub fn new(serial: Option<String>, stop: StopSignal) -> Self {
        Self {
            serial,
            cdc: CdcState {
                port: None,
                pdm: ConfirmedPdm::default(),
                stop,
            },
            mode: None,
            pdm_open: false,
            needs_reset: false,
        }
    }

    pub fn pdm_open(&self) -> bool {
        self.pdm_open
    }

    /// The bulk handle was reopened: the meter may have re-enumerated, so the COM handle
    /// and the entered protocol are stale. Returns whether PDM had been open, so the
    /// caller can ask the user to open it again.
    pub fn drop_cdc(&mut self) -> bool {
        let was_open = self.pdm_open;
        self.cdc.port = None;
        self.mode = None;
        self.pdm_open = false;
        was_open
    }

    /// Run one command. `progress` receives each reply line as the firmware prints it.
    pub fn run(
        &mut self,
        cmd: &TriggerCommand,
        pdo_cache: &PdoCache,
        progress: &mut dyn FnMut(&str),
    ) -> TriggerOutcome {
        let started = Instant::now();
        let mut on_line = |line: &str| {
            let text = sanitize_trigger_text(line);
            if !text.is_empty() {
                progress(&text);
            }
        };
        if std::mem::take(&mut self.needs_reset) && self.pdm_open && cmd_requires_pdm(cmd) {
            if let Err(error) = reset_module(
                &mut self.cdc,
                self.serial.as_deref(),
                &mut self.mode,
                true,
                &mut on_line,
            ) {
                return self.failure(cmd, error);
            }
        }
        match run_trigger(
            &mut self.cdc,
            self.serial.as_deref(),
            cmd,
            &mut self.mode,
            &mut self.pdm_open,
            &mut on_line,
        ) {
            Ok(mut out) => {
                if wants_pd_drain(cmd) && out.pdos.is_empty() {
                    if let Some(pdos) =
                        pdo_cache.wait_since(started, PDO_CACHE_WAIT, &self.cdc.stop)
                    {
                        out.pdos = pdos;
                    }
                }
                TriggerOutcome {
                    ok: out.ok,
                    message: out.message,
                    pdos: out.pdos,
                    protocols: out.protocols,
                    code: out.code,
                    pdm_open: self.pdm_open,
                }
            }
            Err(error) => self.failure(cmd, error),
        }
    }

    fn failure(&mut self, cmd: &TriggerCommand, error: anyhow::Error) -> TriggerOutcome {
        let cancelled = self.cdc.stop.is_set();
        if cancelled && matches!(cmd, TriggerCommand::List { .. }) {
            self.needs_reset = true;
        }
        // A rejected PDO request does not close the active PD session. Dropping CDC here
        // would turn the caller's next request into an implicit PDM reopen, which can
        // itself be rejected as busy.
        if !can_retry_pd_in_session(cmd, self.mode.as_deref(), &error) {
            self.cdc.port = None;
            self.mode = None;
        }
        let code = if cancelled {
            "cancelled"
        } else if error.is::<ProtocolReplyError>() {
            "protocol_rejected"
        } else {
            "transport_error"
        };
        TriggerOutcome {
            ok: false,
            message: format!("{error:#}"),
            pdos: Vec::new(),
            protocols: Vec::new(),
            code: Some(code.into()),
            pdm_open: self.pdm_open,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdm_reopen_restores_confirmed_settings_before_entry_and_pdo() {
        for (config, expected_command) in [
            (
                PdmConfig {
                    pd_type: 2,
                    em: 2,
                    sink: 1,
                },
                "pdm set type=2,em=2,sink=1",
            ),
            (
                PdmConfig {
                    pd_type: 3,
                    em: 2,
                    sink: 0,
                },
                "pdm set type=3,em=2,sink=0",
            ),
        ] {
            let mut settings = ConfirmedPdm::default();
            let mut hardware = PdmConfig::default();
            settings
                .apply(config.clone(), |command| {
                    assert_eq!(command, expected_command);
                    hardware = config.clone();
                    Ok("ok".into())
                })
                .unwrap();
            // Every internal PDO retry reopens PDM, resetting this simulated
            // firmware's settings. Check restoration on repeated reconnects.
            for _ in 0..2 {
                let mut commands = Vec::new();
                let mut send = |command: &str| -> Result<String> {
                    commands.push(command.to_owned());
                    if command == "pdm open" {
                        hardware = PdmConfig::default();
                    } else if command == expected_command {
                        hardware = config.clone();
                    } else {
                        assert_eq!(hardware, config, "protocol ran with wrong settings");
                    }
                    Ok("ok".into())
                };
                settings.reopen(&mut send).unwrap();
                send("entry pd").unwrap();
                send("pd pdo").unwrap();
                send("pd req=8,volt=28000,cur=3000").unwrap();
                assert_eq!(
                    commands,
                    [
                        "pdm open".to_owned(),
                        expected_command.to_owned(),
                        "entry pd".into(),
                        "pd pdo".into(),
                        "pd req=8,volt=28000,cur=3000".into()
                    ]
                );
            }
        }
    }

    #[test]
    fn pdm_restore_failure_stops_before_protocol_and_retains_retry_settings() {
        let config = PdmConfig {
            pd_type: 2,
            em: 2,
            sink: 1,
        };
        let settings = ConfirmedPdm(Some(config.clone()));
        for fail_at in ["pdm open", &ConfirmedPdm::command(&config)] {
            for reply in ["", "request rejected", "transport error"] {
                let mut commands = Vec::new();
                let result = (|| -> Result<()> {
                    settings.reopen(|command| {
                        commands.push(command.to_owned());
                        if command == fail_at {
                            if reply == "transport error" {
                                bail!("模拟串口断开");
                            }
                            return Ok(reply.into());
                        }
                        Ok("ok".into())
                    })?;
                    commands.push("entry pd".into());
                    commands.push("pd pdo".into());
                    Ok(())
                })();
                assert!(result.is_err());
                assert_eq!(commands.last().unwrap(), fail_at);
                assert_eq!(settings.0.as_ref(), Some(&config));
            }
        }
        let mut retry = Vec::new();
        settings
            .reopen(|command| {
                retry.push(command.to_owned());
                Ok("ok".into())
            })
            .unwrap();
        assert_eq!(
            retry,
            ["pdm open".to_owned(), ConfirmedPdm::command(&config)]
        );
    }

    #[test]
    fn pdm_cache_only_commits_successful_settings_and_is_per_device() {
        let mut first = CdcState::default();
        let second = CdcState::default();
        let config = PdmConfig {
            pd_type: 2,
            em: 2,
            sink: 1,
        };
        first
            .pdm
            .apply(config.clone(), |_| Ok("ok".into()))
            .unwrap();
        for reply in ["", "PD: FAIL"] {
            assert!(first
                .pdm
                .apply(PdmConfig::default(), |_| Ok(reply.into()))
                .is_err());
            assert_eq!(first.pdm.0.as_ref(), Some(&config));
        }
        assert!(first
            .pdm
            .apply(PdmConfig::default(), |_| bail!("模拟串口断开"))
            .is_err());
        assert_eq!(first.pdm.0.as_ref(), Some(&config));
        let mut other_commands = Vec::new();
        second
            .pdm
            .reopen(|command| {
                other_commands.push(command.to_owned());
                Ok("ok".into())
            })
            .unwrap();
        assert_eq!(other_commands, ["pdm open"]);
        first
            .pdm
            .apply(PdmConfig::default(), |_| Ok("ok".into()))
            .unwrap();
        assert_eq!(first.pdm.0, Some(PdmConfig::default()));
    }

    #[test]
    fn pd_entry_failure_does_not_cache_success_or_retry_behind_the_caller() {
        for reply in [
            "",
            "(无回复)",
            "PD: FAIL",
            "PD not ready",
            "negotiating",
            "request rejected",
        ] {
            let mut mode = Some("qc".to_owned());
            let mut calls = 0;
            let result = ensure_pd_entry(&mut mode, || {
                calls += 1;
                Ok(reply.into())
            });
            assert!(result.is_err(), "{reply}");
            assert!(result.unwrap_err().is::<ProtocolReplyError>(), "{reply}");
            assert_eq!(calls, 1, "{reply}");
            assert_eq!(mode, None, "{reply}");
            assert_eq!(
                ensure_pd_entry(&mut mode, || Ok("PD ready".into())).unwrap(),
                "PD ready"
            );
            assert_eq!(mode.as_deref(), Some("pd"));
            assert!(ensure_pd_entry(&mut mode, || panic!("already entered PD"))
                .unwrap()
                .is_empty());
        }
        let mut mode = Some("qc".to_owned());
        assert!(!ensure_pd_entry(&mut mode, || bail!("CDC disconnected"))
            .unwrap_err()
            .is::<ProtocolReplyError>());
        assert!(mode.is_none());
    }

    #[test]
    fn pdm_and_pdo_commands_require_a_nonempty_nonfailed_reply() {
        for reply in [
            "",
            "(无回复)",
            "error",
            "request failed",
            "PD ready\nrequest failed",
            "PD: FAIL",
            "request rejected",
            "PD ready\nrequest: timeout",
            "不支持",
        ] {
            assert!(ensure_trigger_reply(reply).is_err(), "{reply}");
        }
        for reply in ["ok", "PD ready", "request accepted"] {
            assert!(ensure_trigger_reply(reply).is_ok(), "{reply}");
        }
    }

    fn fixed_pdo_le(voltage_mv: u32, current_ma: u32) -> [u8; 4] {
        let v_units = voltage_mv / 50;
        let i_units = current_ma / 10;
        let raw = (v_units << 10) | i_units;
        raw.to_le_bytes()
    }

    fn pps_pdo_le(min_mv: u32, max_mv: u32, current_ma: u32) -> [u8; 4] {
        let min_u = (min_mv / 100) & 0xFF;
        let max_u = (max_mv / 100) & 0xFF;
        let i_u = (current_ma / 50) & 0x7F;
        let raw = (3u32 << 30) | (max_u << 17) | (min_u << 8) | i_u;
        raw.to_le_bytes()
    }

    fn spr_avs_pdo_le(cur_9_15_ma: u32, cur_15_20_ma: u32) -> [u8; 4] {
        let i9 = (cur_9_15_ma / 10) & 0x3FF;
        let i20 = (cur_15_20_ma / 10) & 0x3FF;
        let raw = (3u32 << 30) | (2u32 << 28) | (i9 << 10) | i20;
        raw.to_le_bytes()
    }

    fn epr_avs_pdo_le(min_mv: u32, max_mv: u32, pdp_w: u32) -> [u8; 4] {
        let max_u = (max_mv / 100) & 0x1FF;
        let min_u = (min_mv / 100) & 0xFF;
        let raw = (3u32 << 30) | (1u32 << 28) | (max_u << 17) | (min_u << 8) | (pdp_w & 0xFF);
        raw.to_le_bytes()
    }

    #[test]
    fn parse_binary_pdos_fixed_pair_with_noise() {
        let mut raw = b"ok\r\ncc1 attach\r\npdo:2".to_vec();
        raw.push(0x0B);
        raw.extend_from_slice(&fixed_pdo_le(5000, 3000));
        raw.push(b'\n');
        raw.extend_from_slice(&fixed_pdo_le(9000, 3000));
        let pdos = parse_binary_pdos(&raw);
        assert_eq!(pdos.len(), 2, "{pdos:?}");
        assert_eq!(pdos[0].volt_max_mv, 5000);
        assert_eq!(pdos[0].cur_ma, Some(3000));
        assert_eq!(pdos[1].volt_max_mv, 9000);
        assert!(pdos[0].label.contains("5.00"));
        assert!(pdos[1].label.contains("9.00"));
    }

    #[test]
    fn parse_binary_pdos_seven_like_screenshot() {
        let mut raw = b"pdo:7".to_vec();
        raw.push(0x0B);
        for (v, i) in [
            (5000, 3000),
            (9000, 3000),
            (12000, 2500),
            (15000, 2000),
            (20000, 1500),
        ] {
            raw.extend_from_slice(&fixed_pdo_le(v, i));
            raw.push(b'\n');
        }
        raw.extend_from_slice(&pps_pdo_le(5000, 11000, 3000));
        raw.push(b'\n');
        raw.extend_from_slice(&pps_pdo_le(5000, 20000, 1500));
        let pdos = parse_binary_pdos(&raw);
        assert_eq!(pdos.len(), 7, "{pdos:?}");
        assert_eq!(pdos[0].volt_max_mv, 5000);
        assert_eq!(pdos[4].volt_max_mv, 20000);
        assert_eq!(pdos[5].kind, "pps");
        assert_eq!(pdos[6].volt_max_mv, 20000);
    }

    #[test]
    fn parse_binary_pdos_with_pps() {
        let mut raw = b"pdo:3".to_vec();
        raw.extend_from_slice(&fixed_pdo_le(5000, 3000));
        raw.extend_from_slice(&fixed_pdo_le(9000, 3000));
        raw.extend_from_slice(&pps_pdo_le(5000, 11000, 3000));
        let pdos = parse_binary_pdos(&raw);
        assert_eq!(pdos.len(), 3, "{pdos:?}");
        assert_eq!(pdos[2].kind, "pps");
        assert_eq!(pdos[2].volt_min_mv, 5000);
        assert_eq!(pdos[2].volt_max_mv, 11000);
    }

    #[test]
    fn format_pdo_message_keeps_status_and_labels_once() {
        let entry = "ok\ncc1 attach";
        let pdo_text = concat!(
            "pdo:7\n",
            ",\u{52A9}\u{6704}<2\u{82BE}2\u{60F2}\n",
            "ready:5217mV,0mA\n",
            "max power 30W\n",
            "Fixed:     5.00V 3.00A\n",
            "Fixed:     9.00V 3.00A\n",
            "Fixed:    12.00V 2.50A\n",
            "Fixed:    15.00V 2.00A\n",
            "Fixed:    20.00V 1.50A\n",
            "PPS: 5.00-11.00V 3.00A\n",
            "PPS: 5.00-20.00V 1.50A\n",
            "pdo:7\n",
            ",\u{52A9}\u{6704}<2\u{82BE}2\u{60F2}\n",
            "ready:5215mV,0mA\n",
        );
        let mut raw = b"pdo:7".to_vec();
        raw.push(0x0B);
        for (v, i) in [
            (5000, 3000),
            (9000, 3000),
            (12000, 2500),
            (15000, 2000),
            (20000, 1500),
        ] {
            raw.extend_from_slice(&fixed_pdo_le(v, i));
            raw.push(b'\n');
        }
        raw.extend_from_slice(&pps_pdo_le(5000, 11000, 3000));
        raw.push(b'\n');
        raw.extend_from_slice(&pps_pdo_le(5000, 20000, 1500));
        let pdos = parse_binary_pdos(&raw);
        assert_eq!(pdos.len(), 7);
        let msg = format_pdo_message(entry, pdo_text, &pdos);
        assert!(msg.contains("ok"));
        assert!(msg.contains("cc1 attach"));
        assert!(msg.contains("ready:5217mV,0mA"));
        assert!(msg.contains("max power 30W"));
        assert!(msg.contains("#1 FIXED"));
        assert!(msg.contains("#7 PPS"));
        assert!(!msg.to_ascii_lowercase().contains("pdo:"));
        assert!(!msg.contains("Fixed:"));
        assert!(!msg.contains("PPS:"));
        assert!(!msg.contains('\u{52A9}'));
        assert_eq!(msg.matches("ready:").count(), 1);
        assert_eq!(msg.matches("#1 FIXED").count(), 1);
    }

    #[test]
    fn parse_binary_pdos_seven_with_spr_avs() {
        let mut raw = b"pdo:7".to_vec();
        for (v, i) in [
            (5000, 3000),
            (9000, 3000),
            (12000, 3000),
            (15000, 3000),
            (20000, 5000),
        ] {
            raw.extend_from_slice(&fixed_pdo_le(v, i));
        }
        raw.extend_from_slice(&spr_avs_pdo_le(3000, 5000));
        raw.extend_from_slice(&pps_pdo_le(5000, 21000, 5000));
        let pdos = parse_binary_pdos(&raw);
        assert_eq!(pdos.len(), 8, "{pdos:?}");
        assert_eq!(pdos[5].kind, "spr_avs");
        assert_eq!(pdos[5].position, 6);
        assert_eq!(pdos[5].volt_min_mv, 9000);
        assert_eq!(pdos[5].volt_max_mv, 15_000);
        assert_eq!(pdos[5].cur_ma, Some(3000));
        assert_eq!(pdos[6].kind, "spr_avs");
        assert_eq!(pdos[6].position, 6);
        assert_eq!(pdos[6].volt_min_mv, 15_000);
        assert_eq!(pdos[6].volt_max_mv, 20_000);
        assert_eq!(pdos[6].cur_ma, Some(5000));
        assert_eq!(pdos[7].kind, "pps");
        assert_eq!(pdos[7].volt_max_mv, 21000);
        assert_eq!(pdos[7].position, 7);
    }

    #[test]
    fn parse_binary_pdos_skips_padding_and_keeps_epr_positions() {
        let mut raw = b"pdo:11".to_vec();
        raw.push(0x0B);
        for (v, i) in [
            (5000, 3000),
            (9000, 3000),
            (12000, 3000),
            (15000, 3000),
            (20000, 5000),
        ] {
            raw.extend_from_slice(&fixed_pdo_le(v, i));
            raw.push(b'\n');
        }
        raw.extend_from_slice(&spr_avs_pdo_le(3000, 5000));
        raw.push(b'\n');
        raw.extend_from_slice(&pps_pdo_le(5000, 21000, 5000));
        raw.extend_from_slice(&[0, 0, 0, 0]);
        raw.push(b'\n');
        raw.extend_from_slice(&fixed_pdo_le(28_000, 5000));
        raw.push(b'\n');
        raw.extend_from_slice(&epr_avs_pdo_le(15_000, 48_000, 240));
        let pdos = parse_binary_pdos(&raw);
        assert!(pdos.len() >= 10, "{pdos:?}");
        let epr_fixed = pdos
            .iter()
            .find(|p| p.kind == "epr_fixed" && p.volt_max_mv == 28_000)
            .expect("epr fixed 28 V");
        assert!(
            epr_fixed.position == 8 || epr_fixed.position == 9,
            "28 V position {}, pdos={pdos:?}",
            epr_fixed.position
        );
        assert_eq!(epr_fixed.cur_ma, Some(5000));
        let epr_avs = pdos.iter().find(|p| p.kind == "epr_avs").expect("epr avs");
        assert_eq!(epr_avs.volt_min_mv, 15_000);
        assert_eq!(epr_avs.volt_max_mv, 48_000);
        assert_eq!(epr_avs.cur_ma, Some(5000));
        assert!(epr_avs.label.contains("240 W"), "{}", epr_avs.label);
        assert!(epr_avs.position > epr_fixed.position);
    }

    #[test]
    fn format_pdo_message_drops_inline_cjk_and_ascii_table() {
        let entry = "ok\ncc1 attach";
        let pdo_text = concat!(
            "pdo:7,憗\n",
            "ready:5100mV,0mA\n",
            "max power 100W\n",
            "Fixed:     5.00V 3.00A\n",
            "Fixed:     9.00V 3.00A\n",
            "Fixed:    12.00V 3.00A\n",
            "Fixed:    15.00V 3.00A\n",
            "Fixed:    20.00V 5.00A\n",
            "AVS: 9-20V3.00A,5.00A\n",
            "PPS: 5.00-21.00V 5.00A\n",
            "pdo:7,憗\n",
            "ready:5097mV,0mA\n",
            "pdo:9,憗\n",
            "ready:5099mV,0mA\n",
        );
        let mut raw = b"pdo:7".to_vec();
        for (v, i) in [
            (5000, 3000),
            (9000, 3000),
            (12000, 3000),
            (15000, 3000),
            (20000, 5000),
        ] {
            raw.extend_from_slice(&fixed_pdo_le(v, i));
        }
        raw.extend_from_slice(&spr_avs_pdo_le(3000, 5000));
        raw.extend_from_slice(&pps_pdo_le(5000, 21000, 5000));
        let binary = parse_binary_pdos(&raw);
        let ascii = parse_pdos(&sanitize_trigger_text(pdo_text));
        let pdos = pick_trigger_pdos(binary, ascii);
        assert_eq!(pdos.len(), 8, "{pdos:?}");
        let msg = format_pdo_message(entry, pdo_text, &pdos);
        assert!(msg.contains("ok"));
        assert!(msg.contains("cc1 attach"));
        assert!(msg.contains("ready:5100mV,0mA"));
        assert!(msg.contains("max power 100W"));
        assert!(msg.contains("#1 FIXED"));
        assert!(msg.contains("#6 SPR AVS"));
        assert!(msg.contains("#7 PPS"));
        assert!(msg.contains("3.00 A"), "{msg}");
        assert!(msg.contains("5.00 A"), "{msg}");
        assert!(!msg.contains('憗'), "{msg}");
        assert!(!msg.to_ascii_lowercase().contains("pdo:"));
        assert!(!msg.contains("Fixed:"));
        assert!(!msg.contains("AVS:"));
        assert!(!msg.contains("PPS:"));
        assert_eq!(msg.matches("ready:").count(), 1);
    }

    #[test]
    fn pick_trigger_pdos_prefers_longer_ascii_table() {
        let binary = vec![make_pdo(1, "fixed", 5000, 5000, Some(3000), false)];
        let ascii = parse_pdos(
            "Fixed: 5.00V 3.00A\nFixed: 9.00V 3.00A\nAVS: 9-20V3.00A\nPPS: 5.00-21.00V 5.00A",
        );
        assert_eq!(ascii.len(), 4);
        let picked = pick_trigger_pdos(binary, ascii);
        assert_eq!(picked.len(), 4);
        assert_eq!(picked[2].kind, "avs");
    }

    #[test]
    fn pdm_commands_gate_protocol_until_open() {
        assert_eq!(pdm_raw_kind("pdm open"), Some(true));
        assert_eq!(pdm_raw_kind("PDM CLOSE"), Some(false));
        assert_eq!(pdm_raw_kind("pd pdo"), None);
        assert!(!cmd_requires_pdm(&TriggerCommand::PdmOpen));
        assert!(!cmd_requires_pdm(&TriggerCommand::PdmClose));
        assert!(!cmd_requires_pdm(&TriggerCommand::Raw {
            command: "pdm open".into()
        }));
        assert!(cmd_requires_pdm(&TriggerCommand::PdPdo));
        assert!(cmd_requires_pdm(&TriggerCommand::PdmSet {
            pd_type: 1,
            em: 1,
            sink: 0
        }));
    }

    #[test]
    fn closed_pdm_gates_protocol_commands_without_touching_the_port() {
        let mut session = TriggerSession::new(None, StopSignal::default());
        let outcome = session.run(&TriggerCommand::PdPdo, &PdoCache::default(), &mut |_| {});
        assert!(!outcome.ok);
        assert_eq!(outcome.code.as_deref(), Some("pdm_required"));
        assert!(!outcome.pdm_open);
        assert!(session.cdc.port.is_none());
    }

    #[test]
    fn cancelled_scan_is_reported_and_forces_a_reset_next_time() {
        let cancel = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let mut session = TriggerSession::new(None, StopSignal::new(alive, Arc::clone(&cancel)));
        session.pdm_open = true;
        let outcome = session.run(
            &TriggerCommand::List { plus: true },
            &PdoCache::default(),
            &mut |_| {},
        );
        assert!(!outcome.ok);
        assert_eq!(outcome.code.as_deref(), Some("cancelled"));
        assert!(session.needs_reset);
        assert!(outcome.pdm_open, "cancelling a scan does not close PDM");
    }

    #[test]
    fn dropping_cdc_reports_whether_pdm_was_open() {
        let mut session = TriggerSession::new(None, StopSignal::default());
        assert!(!session.drop_cdc());
        session.pdm_open = true;
        session.mode = Some("pd".into());
        assert!(session.drop_cdc());
        assert!(!session.pdm_open());
        assert!(session.mode.is_none());
    }

    #[test]
    fn pdo_cache_only_answers_with_lists_newer_than_the_command() {
        let cache = PdoCache::default();
        let pdos = vec![make_pdo(1, "fixed", 5000, 5000, Some(3000), false)];
        cache.update(pdos.clone());
        let later = Instant::now() + Duration::from_millis(1);
        assert!(cache
            .wait_since(later, Duration::from_millis(50), &StopSignal::default())
            .is_none());
        let before = Instant::now() - Duration::from_secs(1);
        assert_eq!(
            cache.wait_since(before, Duration::ZERO, &StopSignal::default()),
            Some(pdos)
        );
        cache.update(Vec::new());
        assert!(cache
            .wait_since(before, Duration::ZERO, &StopSignal::default())
            .is_some());
    }
}

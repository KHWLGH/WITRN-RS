//! Parse KM003C CDC text: `pd pdo` rows and `entry list` protocol lines.

use crate::types::{DetectedProtocol, TriggerPdo};

struct ProtoPat {
    id: &'static str,
    label: &'static str,
    tokens: &'static [&'static str],
}

/// Firmware `entry list+` field names (the token before `:`). `pd` is handled separately.
const SCAN_FIELD_NAMES: &[&str] = &[
    "bc1.2", "bc 1.2", "dcp", "apple", "ufcs", "vfcp", "vifc", "vifcp", "qc2.0", "qc 2.0", "qc2",
    "qc3.0", "qc 3.0", "qc3+", "qc3", "afc", "fcp", "scp", "sfcp", "tfcp", "svooc", "vooc",
    "mtkpe", "mtkpe2.0", "mtk pe", "mtk",
];

const PROTO_PATS: &[ProtoPat] = &[
    ProtoPat {
        id: "pd",
        label: "PD",
        tokens: &[
            "power delivery",
            "pd3.2",
            "pd 3.2",
            "pd3.1",
            "pd3.0",
            "pd2.0",
            "pd",
        ],
    },
    ProtoPat {
        id: "qc3",
        label: "QC 3.0",
        tokens: &["qc3+", "qc3.0", "qc 3.0", "qc3"],
    },
    ProtoPat {
        id: "qc",
        label: "QC 2.0",
        tokens: &["qc2.0", "qc 2.0", "qc2", "qc"],
    },
    ProtoPat {
        id: "fcp",
        label: "FCP",
        tokens: &["fcp"],
    },
    ProtoPat {
        id: "scp",
        label: "SCP",
        tokens: &["scp"],
    },
    ProtoPat {
        id: "afc",
        label: "AFC",
        tokens: &["afc"],
    },
    ProtoPat {
        id: "sfcp",
        label: "SFCP",
        tokens: &["sfcp"],
    },
    ProtoPat {
        id: "vfcp",
        label: "VFCP",
        tokens: &["vfcp", "vifc", "vifcp"],
    },
    ProtoPat {
        id: "ufcs",
        label: "UFCS",
        tokens: &["ufcs"],
    },
    ProtoPat {
        id: "apple",
        label: "Apple",
        tokens: &["apple2.4", "apple 2.4", "apple"],
    },
    ProtoPat {
        id: "bc",
        label: "BC 1.2",
        tokens: &["bc1.2", "bc 1.2", "dcp", "bc"],
    },
    ProtoPat {
        id: "vooc",
        label: "VOOC",
        tokens: &["svooc", "vooc"],
    },
    ProtoPat {
        id: "mtk",
        label: "MTK PE",
        tokens: &["mtk pe", "mtkpe", "mtk"],
    },
];

/// Convert PDP (W) at `volt_max_mv` into milliamps: `I = P / V`.
pub fn pdp_to_current_ma(pdp_w: u32, volt_max_mv: u32) -> Option<u32> {
    if pdp_w == 0 || volt_max_mv == 0 {
        return None;
    }
    Some((u64::from(pdp_w) * 1_000_000 / u64::from(volt_max_mv)) as u32)
}

/// SPR AVS uses the 15–20 V current, else 9–15 V. EPR AVS uses `PDP / Vmax`.
pub fn avs_current_ma(
    max_current_15v_20v_ma: Option<u32>,
    max_current_9v_15v_ma: Option<u32>,
    pdp_w: Option<u32>,
    volt_max_mv: u32,
) -> Option<u32> {
    max_current_15v_20v_ma
        .filter(|&c| c > 0)
        .or_else(|| max_current_9v_15v_ma.filter(|&c| c > 0))
        .or_else(|| pdp_w.and_then(|w| pdp_to_current_ma(w, volt_max_mv)))
}

/// PD 3.2 SPR AVS bands with a valid non-zero current (10 mA units, at most 5 A).
/// Both include 15 V: USB PD R3.2 V1.2 Table 3.2 note 4 permits the 20 V
/// current at exactly 15.0 V. Keep the two limits instead of using one for 9–20 V.
pub fn expand_spr_avs_bands(
    i_9_15_ma: Option<u32>,
    i_15_20_ma: Option<u32>,
) -> Vec<(u32, u32, u32)> {
    if [i_9_15_ma, i_15_20_ma]
        .into_iter()
        .flatten()
        .any(|a| a > 5000 || a % 10 != 0)
    {
        return Vec::new();
    }
    let mut bands = Vec::new();
    if let Some(a) = i_9_15_ma.filter(|&c| c > 0) {
        bands.push((9000, 15_000, a));
    }
    if let Some(a) = i_15_20_ma.filter(|&c| c > 0) {
        bands.push((15_000, 20_000, a));
    }
    bands
}

/// One TriggerPdo per advertised SPR AVS band, sharing `position`.
pub fn spr_avs_pdos(
    position: u8,
    kind: &str,
    i_9_15_ma: Option<u32>,
    i_15_20_ma: Option<u32>,
) -> Vec<TriggerPdo> {
    expand_spr_avs_bands(i_9_15_ma, i_15_20_ma)
        .into_iter()
        .map(|(vmin, vmax, cur)| make_pdo(position, kind, vmin, vmax, Some(cur), true))
        .collect()
}

pub fn parse_pdos(text: &str) -> Vec<TriggerPdo> {
    let mut out = Vec::new();
    let mut auto = 1u8;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        if lower.contains("ready") || lower == "ok" || lower.starts_with("entry") {
            continue;
        }
        for chunk in split_pdo_chunks(trimmed) {
            let chunk = chunk.trim();
            if chunk.is_empty() {
                continue;
            }
            let pos_hint = parse_position(chunk);
            let chunk_kind = classify_pdo(&chunk.to_ascii_lowercase(), chunk);
            let pairs = extract_pairs(chunk);
            if pairs.is_empty() {
                continue;
            }
            let pdp_w = extract_pdp_w(chunk);
            let epr_avs = is_epr_avs_chunk(&chunk_kind, &pairs);
            let spr_currents = if !epr_avs && is_spr_avs_chunk(&chunk_kind) {
                Some(spr_avs_currents(chunk, &pairs))
            } else {
                None
            };
            let spr_bands = spr_currents
                .map(|(i9, i20)| {
                    expand_spr_avs_bands(i9, i20)
                        .into_iter()
                        .flat_map(|(min, max, current)| {
                            pairs.iter().filter_map(move |&(lo, hi, _)| {
                                let (lo, hi) = (lo.max(min), hi.min(max));
                                (lo < hi).then_some((lo, hi, current))
                            })
                        })
                        .collect::<std::collections::BTreeSet<_>>()
                })
                .unwrap_or_default();

            struct Item {
                vmin: u32,
                vmax: u32,
                cur: Option<u32>,
                i9: Option<u32>,
                i20: Option<u32>,
                share_pos: bool,
                epr_label: bool,
            }

            let items: Vec<Item> = if epr_avs {
                let vmin = pairs.iter().map(|p| p.0).min().unwrap();
                let vmax = pairs.iter().map(|p| p.1).max().unwrap();
                let cur = avs_current_ma(None, None, pdp_w, vmax);
                vec![Item {
                    vmin,
                    vmax,
                    cur,
                    i9: None,
                    i20: None,
                    share_pos: false,
                    epr_label: true,
                }]
            } else if spr_currents.is_some_and(|(i9, i20)| i9.is_some() || i20.is_some()) {
                spr_bands
                    .into_iter()
                    .map(|(vmin, vmax, cur)| Item {
                        vmin,
                        vmax,
                        cur: Some(cur),
                        i9: None,
                        i20: None,
                        share_pos: true,
                        epr_label: false,
                    })
                    .collect()
            } else {
                pairs
                    .into_iter()
                    .map(|(vmin, vmax, cur)| Item {
                        vmin,
                        vmax,
                        cur,
                        i9: None,
                        i20: None,
                        share_pos: false,
                        epr_label: false,
                    })
                    .collect()
            };

            let share = items.len() > 1 && items.iter().all(|it| it.share_pos);
            let group_pos = {
                let mut p = pos_hint.unwrap_or(auto);
                if p == 0 {
                    p = auto;
                }
                p
            };
            if items.is_empty() {
                // A zero/invalid APDO still occupies a physical PDO position.
                auto = group_pos.saturating_add(1);
                continue;
            }
            for (i, it) in items.into_iter().enumerate() {
                let mut position = if share || i == 0 { group_pos } else { auto };
                if position == 0 {
                    position = auto;
                }
                let kind = kind_for(&chunk_kind, it.vmin, it.vmax);
                let mut cur = it.cur;
                if cur.is_none() {
                    if let Some(w) = pdp_w {
                        cur = pdp_to_current_ma(w, it.vmax);
                    }
                }
                let programmable = is_programmable_kind(&kind);
                let mut rec = make_pdo(position, &kind, it.vmin, it.vmax, cur, programmable);
                if it.epr_label {
                    rec.cur_ma = rec
                        .cur_ma
                        .or_else(|| avs_current_ma(it.i20, it.i9, pdp_w, it.vmax));
                    rec.label =
                        format_avs_label(position, &kind, it.vmin, it.vmax, it.i9, it.i20, pdp_w);
                }
                out.push(rec);
                if !share {
                    auto = position.saturating_add(1);
                }
            }
            if share {
                auto = group_pos.saturating_add(1);
            }
        }
    }
    out
}

fn split_pdo_chunks(line: &str) -> Vec<&str> {
    const SEPARATORS: [char; 5] = [';', ',', '，', '、', '|'];
    let mut chunks = Vec::new();
    let mut start = 0;
    for (index, separator) in line.char_indices().filter(|(_, c)| SEPARATORS.contains(c)) {
        let next = index + separator.len_utf8();
        let before = &line[start..index];
        let after = line[next..].split(SEPARATORS).next().unwrap_or("").trim();
        // CDC firmware writes `AVS: 9-20V3.00A,5.00A`; this comma separates
        // currents, not PDOs. Also keep the two explicitly named voltage bands.
        if matches!(separator, ',' | '，' | '、') && spr_avs_continuation(before, after) {
            continue;
        }
        chunks.push(before);
        start = next;
    }
    chunks.push(&line[start..]);
    chunks
}

fn spr_avs_continuation(before: &str, after: &str) -> bool {
    let kind = classify_pdo(&before.to_ascii_lowercase(), before);
    let pairs = extract_pairs(before);
    if !is_spr_avs_chunk(&kind) || is_epr_avs_chunk(&kind, &pairs) || pairs.len() != 1 {
        return false;
    }
    if dual_amp_pair(before).is_none()
        && current_number(&after.to_ascii_lowercase())
            .is_some_and(|(_, unit, rest)| unit.is_some() && rest.trim().is_empty())
    {
        return true;
    }
    let Some((min, max, start, end)) = next_voltage(&after.to_ascii_lowercase(), 0) else {
        return false;
    };
    let adjacent = matches!(
        (pairs[0].0, pairs[0].1, min, max),
        (9000, 15_000, 15_000, 20_000) | (15_000, 20_000, 9000, 15_000)
    );
    start == 0
        && adjacent
        && current_number(after[end..].trim_start().trim_start_matches('@'))
            .is_some_and(|(_, unit, rest)| unit.is_some() && rest.trim().is_empty())
}

fn is_spr_avs_chunk(chunk_kind: &str) -> bool {
    matches!(chunk_kind, "avs" | "spr_avs")
}

fn is_epr_avs_chunk(chunk_kind: &str, pairs: &[(u32, u32, Option<u32>)]) -> bool {
    chunk_kind == "epr_avs" || (chunk_kind == "avs" && pairs.iter().any(|p| p.1 > 20_000))
}

fn spr_avs_currents(chunk: &str, pairs: &[(u32, u32, Option<u32>)]) -> (Option<u32>, Option<u32>) {
    if let Some((a, b)) = dual_amp_pair(chunk) {
        return (Some(a), Some(b));
    }
    if let [(min, max, current)] = pairs {
        // Legacy firmware can report just one range-wide limit. Keep that
        // source's key; only explicitly advertised dual limits need two bands.
        if *min < 15_000
            && *max > 15_000
            && current.is_none_or(|a| a > 0 && a <= 5000 && a % 10 == 0)
        {
            return (None, None);
        }
    }
    let (mut low, mut high) = (None, None);
    for &(min, max, current) in pairs {
        if min < 15_000 {
            low = current;
        }
        if max > 15_000 {
            high = current;
        }
    }
    (low, high)
}

fn is_programmable_kind(kind: &str) -> bool {
    matches!(
        kind,
        "pps" | "avs" | "spr_avs" | "epr_avs" | "battery" | "variable"
    )
}

fn kind_heading(kind: &str) -> String {
    match kind {
        "spr_avs" => "SPR AVS".into(),
        "epr_avs" => "EPR AVS".into(),
        "epr_fixed" => "EPR FIXED".into(),
        other => other.to_ascii_uppercase(),
    }
}

/// Label for SPR/EPR AVS. Dual-current and PDP (W) stay visible; `cur_ma` is separate.
pub fn format_avs_label(
    position: u8,
    kind: &str,
    volt_min_mv: u32,
    volt_max_mv: u32,
    i_9_15_ma: Option<u32>,
    i_15_20_ma: Option<u32>,
    pdp_w: Option<u32>,
) -> String {
    let kind_u = kind_heading(kind);
    let v = format!(
        "{:.2}-{:.2} V",
        volt_min_mv as f64 / 1000.0,
        volt_max_mv as f64 / 1000.0
    );
    match (i_9_15_ma, i_15_20_ma, pdp_w) {
        (Some(a), Some(b), _) => format!(
            "#{position} {kind_u} {v} {:.2}/{:.2} A",
            a as f64 / 1000.0,
            b as f64 / 1000.0
        ),
        (Some(a), None, _) | (None, Some(a), _) => {
            format!("#{position} {kind_u} {v} {:.2} A", a as f64 / 1000.0)
        }
        (None, None, Some(w)) if w > 0 => format!("#{position} {kind_u} {v} {w} W"),
        _ => format!("#{position} {kind_u} {v}"),
    }
}

fn kind_for(chunk_kind: &str, vmin: u32, vmax: u32) -> String {
    match chunk_kind {
        "avs" if vmax > 20_000 => "epr_avs".into(),
        "fixed" if vmax > 20_000 => "epr_fixed".into(),
        "avs" | "spr_avs" | "epr_avs" | "epr_fixed" | "battery" | "variable" | "pps" => {
            chunk_kind.to_string()
        }
        _ if vmin != vmax => "pps".into(),
        _ => "fixed".into(),
    }
}

fn extract_pairs(raw: &str) -> Vec<(u32, u32, Option<u32>)> {
    let lower = raw.to_ascii_lowercase();
    let mut pos = 0;
    let mut out = Vec::new();
    while let Some((vmin, vmax, v_start, v_end)) = next_voltage(&lower, pos) {
        let next_v_start = next_voltage(&lower, v_end)
            .map(|(_, _, start, _)| start)
            .unwrap_or(lower.len());
        let (cur_ma, consumed) = match next_current(&lower, v_end, next_v_start) {
            Some((ma, end)) => (Some(ma), end),
            None => (None, v_end),
        };
        out.push((vmin, vmax, cur_ma));
        let next = consumed.max(v_end);
        pos = if next > pos { next } else { v_start + 1 };
    }
    out
}

fn current_number(raw: &str) -> Option<(f64, Option<u32>, &str)> {
    let (value, end) = parse_number_start(raw)?;
    let rest = raw[end..].trim_start();
    for (unit, scale) in [("ma", 1), ("a", 1000)] {
        if rest
            .get(..unit.len())
            .is_some_and(|s| s.eq_ignore_ascii_case(unit))
            && unit_boundary(rest, unit)
        {
            return Some((value, Some(scale), rest[unit.len()..].trim_start()));
        }
    }
    Some((value, None, rest))
}

fn dual_amp_pair(raw: &str) -> Option<(u32, u32)> {
    let lower = raw.to_ascii_lowercase();
    let (_, _, _, end) = next_voltage(&lower, 0)?;
    let tail = lower[end..].trim_start().trim_start_matches('@');
    let (left, left_unit, rest) = current_number(tail)?;
    let separator = rest.chars().next()?;
    if !matches!(separator, '/' | ',' | '，' | '、') {
        return None;
    }
    let (right, right_unit, rest) = current_number(&rest[separator.len_utf8()..])?;
    if !rest.trim().is_empty() {
        return None;
    }
    Some((
        to_milli(left, left_unit.or(right_unit)?),
        to_milli(right, right_unit.or(left_unit)?),
    ))
}

fn parse_num_at(s: &str, i: usize) -> Option<(f64, usize)> {
    if i >= s.len() {
        return None;
    }
    let b = s.as_bytes()[i];
    if !b.is_ascii_digit() && b != b'.' {
        return None;
    }
    let (n, consumed) = parse_number_start(&s[i..])?;
    Some((n, i + consumed))
}

fn next_voltage(lower: &str, from: usize) -> Option<(u32, u32, usize, usize)> {
    let bytes = lower.as_bytes();
    let mut i = from;
    while i < bytes.len() {
        let Some((left, after_left)) = parse_num_at(lower, i) else {
            i += 1;
            continue;
        };
        let mut vmin = left;
        let mut vmax = left;
        let mut after_num = after_left;
        if lower.get(after_left..).is_some_and(|s| s.starts_with('-')) {
            if let Some((right, after_right)) = parse_num_at(lower, after_left + 1) {
                vmin = left.min(right);
                vmax = left.max(right);
                after_num = after_right;
            }
        }
        let rest = lower[after_num..].trim_start();
        let skipped = lower[after_num..].len() - rest.len();
        let unit_at = after_num + skipped;
        if rest.starts_with("mv") && unit_boundary(&lower[unit_at..], "mv") {
            return Some((to_milli(vmin, 1), to_milli(vmax, 1), i, unit_at + 2));
        }
        if rest.starts_with('v') && unit_boundary(&lower[unit_at..], "v") {
            if rest.starts_with("vooc") {
                i = after_left.max(i + 1);
                continue;
            }
            return Some((to_milli(vmin, 1000), to_milli(vmax, 1000), i, unit_at + 1));
        }
        i = after_left.max(i + 1);
    }
    None
}

fn next_current(lower: &str, from: usize, until: usize) -> Option<(u32, usize)> {
    let end = until.min(lower.len());
    let mut i = from;
    while i < end {
        let Some((n, after)) = parse_num_at(lower, i) else {
            i += 1;
            continue;
        };
        if after > end {
            break;
        }
        let rest = lower[after..].trim_start();
        let skipped = lower[after..].len() - rest.len();
        let unit_at = after + skipped;
        if unit_at > end {
            break;
        }
        if rest.starts_with("ma") && unit_boundary(&lower[unit_at..], "ma") {
            return Some((to_milli(n, 1), unit_at + 2));
        }
        if let Some(stripped) = rest.strip_prefix('/') {
            let after_slash = stripped.trim_start();
            let skipped_slash = stripped.len() - after_slash.len();
            let second_at = unit_at + 1 + skipped_slash;
            if let Some((n2, after2)) = parse_num_at(lower, second_at) {
                if after2 <= end {
                    let rest2 = lower[after2..].trim_start();
                    let skipped2 = lower[after2..].len() - rest2.len();
                    let unit2 = after2 + skipped2;
                    if unit2 <= end
                        && rest2.starts_with('a')
                        && unit_boundary(&lower[unit2..], "a")
                        && !rest2.starts_with("avs")
                        && !rest2.starts_with("afc")
                    {
                        let _ = n2;
                        return Some((to_milli(n, 1000), unit2 + 1));
                    }
                }
            }
        }
        if rest.starts_with('a') && unit_boundary(&lower[unit_at..], "a") {
            if rest.starts_with("avs") || rest.starts_with("afc") {
                i = after.max(i + 1);
                continue;
            }
            return Some((to_milli(n, 1000), unit_at + 1));
        }
        i = after.max(i + 1);
    }
    None
}

pub fn make_pdo(
    position: u8,
    kind: &str,
    volt_min_mv: u32,
    volt_max_mv: u32,
    cur_ma: Option<u32>,
    programmable: bool,
) -> TriggerPdo {
    TriggerPdo {
        position,
        kind: kind.to_string(),
        volt_min_mv,
        volt_max_mv,
        cur_ma,
        label: format_label(position, kind, volt_min_mv, volt_max_mv, cur_ma),
        programmable,
    }
}

pub fn parse_detected_protocols(text: &str) -> Vec<DetectedProtocol> {
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        if line_negative(&lower) {
            continue;
        }
        for p in PROTO_PATS {
            if p.tokens.iter().any(|tok| contains_token(&lower, tok))
                && !out.iter().any(|e: &DetectedProtocol| e.id == p.id)
            {
                out.push(DetectedProtocol {
                    id: p.id.to_string(),
                    label: p.label.to_string(),
                });
            }
        }
    }
    out
}

fn is_cjk(c: char) -> bool {
    matches!(c,
        '\u{4E00}'..='\u{9FFF}'
        | '\u{3400}'..='\u{4DBF}'
        | '\u{F900}'..='\u{FAFF}'
        | '\u{3000}'..='\u{303F}'
    )
}

fn looks_like_binary_mojibake(line: &str) -> bool {
    let chars: Vec<char> = line.chars().collect();
    if chars.is_empty() {
        return false;
    }
    // Typical GBK-misdecoded PDO tail, e.g. ",劝朄<2芾2惲"
    if matches!(chars[0], ',' | ';') && chars.iter().any(|&c| is_cjk(c) || !c.is_ascii()) {
        return true;
    }
    let has_cjk = chars.iter().any(|&c| is_cjk(c));
    if !has_cjk {
        return false;
    }
    // Real firmware phrases are all CJK (失败 / 就绪 / 不支持).
    let non_space: Vec<char> = chars
        .iter()
        .copied()
        .filter(|c| !c.is_whitespace())
        .collect();
    if !non_space.is_empty() && non_space.iter().all(|&c| is_cjk(c)) {
        return false;
    }
    let printable_ascii = chars
        .iter()
        .filter(|c| c.is_ascii_graphic() || **c == ' ')
        .count();
    (printable_ascii as f64) / (chars.len() as f64) < 0.5
}

/// `pdo:7,憗` → `pdo:7`. Binary PDO words are often glued onto the count header.
fn clip_pdo_count_line(line: &str) -> Option<String> {
    let lower = line.to_ascii_lowercase();
    let rest = lower.strip_prefix("pdo:")?;
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    Some(line[..4 + digits].to_string())
}

/// Strip control characters / replacement chars that appear when CDC dumps binary
/// (e.g. `pd pdo` tails) are lossily decoded as text. Keeps newlines.
pub fn sanitize_trigger_text(text: &str) -> String {
    let mut lines = Vec::new();
    for line in text.lines() {
        let cleaned: String = line
            .chars()
            .filter(|&c| c == '\t' || (c >= ' ' && c != '\u{FFFD}'))
            .collect();
        let trimmed = cleaned.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Drop lines that are only punctuation left after binary bytes were stripped
        // (e.g. "," from LE PDO bytes that started with 0x2C).
        if trimmed
            .chars()
            .all(|c| matches!(c, ',' | ';' | '|' | '，' | '、' | '.' | ':' | '：'))
        {
            continue;
        }
        let trimmed = trimmed.trim_end_matches([',', ';', '|', '，', '、']);
        let trimmed = clip_pdo_count_line(trimmed).unwrap_or_else(|| trimmed.to_string());
        let trimmed = trimmed.trim();
        if trimmed.is_empty() || looks_like_binary_mojibake(trimmed) {
            continue;
        }
        if let Some((proto, pd)) = split_glued_proto_pd(trimmed) {
            lines.push(proto);
            lines.push(pd);
        } else {
            lines.push(trimmed.to_string());
        }
    }
    lines.join("\n")
}

fn is_scan_field_name(name: &str) -> bool {
    SCAN_FIELD_NAMES.contains(&name)
}

/// `svooc:PD3.2:60W PDO:7` → (`svooc:`, `PD3.2:60W PDO:7`).
fn split_glued_proto_pd(line: &str) -> Option<(String, String)> {
    let (name, rest) = line.split_once(':')?;
    let rest = rest.trim();
    if rest.is_empty() {
        return None;
    }
    let name_l = name.trim().to_ascii_lowercase();
    if name_l == "pd" || !is_scan_field_name(&name_l) {
        return None;
    }
    if !is_pd_cap_header(rest) {
        return None;
    }
    Some((format!("{}:", name.trim()), rest.to_string()))
}

fn is_pd_cap_header(line: &str) -> bool {
    let t = line.trim().to_ascii_lowercase();
    let Some(rest) = t.strip_prefix("pd") else {
        return false;
    };
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return false;
    }
    let after = &rest[digits..];
    if let Some(after_dot) = after.strip_prefix('.') {
        let frac = after_dot.bytes().take_while(u8::is_ascii_digit).count();
        if frac == 0 {
            return false;
        }
        return after_dot[frac..].starts_with(':');
    }
    after.starts_with(':')
}

fn is_orphan_bare_value(line: &str) -> bool {
    matches!(
        line.trim().to_ascii_lowercase().as_str(),
        "null" | "true" | "false"
    )
}

fn is_incomplete_scan_field(line: &str) -> bool {
    let Some((name, rest)) = line.split_once(':') else {
        return false;
    };
    rest.trim().is_empty() && is_scan_field_name(&name.trim().to_ascii_lowercase())
}

fn is_pd_section_label(block: &[String]) -> bool {
    if block.len() != 1 {
        return false;
    }
    let Some((name, rest)) = block[0].split_once(':') else {
        return false;
    };
    name.trim().eq_ignore_ascii_case("pd") && rest.trim().is_empty()
}

fn follows_pd_label(blocks: &[Vec<String>], i: usize) -> bool {
    i > 0 && is_pd_section_label(&blocks[i - 1])
}

fn pd_table_key(block: &[String]) -> Option<String> {
    if block.first().is_some_and(|l| is_pd_cap_header(l)) {
        Some(block_key(block))
    } else {
        None
    }
}

fn attach_orphan_values(blocks: &mut Vec<Vec<String>>) {
    let mut i = 0;
    while i < blocks.len() {
        let is_orphan = blocks[i].len() == 1 && is_orphan_bare_value(&blocks[i][0]);
        if !is_orphan {
            i += 1;
            continue;
        }
        let value = blocks[i][0].trim().to_string();
        let mut attached = false;
        for j in (0..i).rev() {
            if blocks[j].len() == 1 && is_incomplete_scan_field(&blocks[j][0]) {
                let name = blocks[j][0].trim().trim_end_matches(':').trim();
                blocks[j] = vec![format!("{name}:{value}")];
                attached = true;
                break;
            }
        }
        if attached {
            blocks.remove(i);
        } else {
            i += 1;
        }
    }
}

fn is_protocol_scan_line(lower: &str) -> bool {
    let Some((name, rest)) = lower.split_once(':') else {
        return false;
    };
    let name = name.trim();
    let rest = rest.trim();
    if name.is_empty() || name == "fail" || name == "error" {
        return false;
    }
    rest == "ok"
        || rest == "fail"
        || rest == "n/a"
        || rest == "na"
        || rest == "no"
        || rest.starts_with("fail")
}

fn is_pdo_detail_line(lower: &str) -> bool {
    let t = lower.trim_start();
    t.starts_with("fixed:")
        || t.starts_with("pps:")
        || t.starts_with("battery:")
        || t.starts_with("variable:")
        || t.starts_with("avs:")
        || t.starts_with("epr avs:")
        || t.starts_with("spr avs:")
        || t.starts_with("epr fixed:")
}

fn block_key(lines: &[String]) -> String {
    lines
        .iter()
        .map(|l| {
            l.to_ascii_lowercase()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Deduplicate detailed `entry list` blocks (e.g. repeated PD3.0 + Fixed/PPS tables).
fn dedupe_detail_blocks(text: &str) -> String {
    let cleaned = sanitize_trigger_text(text);
    let mut blocks: Vec<Vec<String>> = Vec::new();
    for line in cleaned.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        if is_pdo_detail_line(&lower) {
            if let Some(last) = blocks.last_mut() {
                last.push(trimmed.to_string());
                continue;
            }
        }
        blocks.push(vec![trimmed.to_string()]);
    }

    attach_orphan_values(&mut blocks);

    let mut pd_keys_under_pd = Vec::new();
    for (i, block) in blocks.iter().enumerate() {
        if let Some(key) = pd_table_key(block) {
            if follows_pd_label(&blocks, i) && !pd_keys_under_pd.iter().any(|s: &String| s == &key)
            {
                pd_keys_under_pd.push(key);
            }
        }
    }

    let mut kept = Vec::new();
    let mut seen = Vec::new();
    for (i, block) in blocks.iter().enumerate() {
        if let Some(pd_key) = pd_table_key(block) {
            if pd_keys_under_pd.iter().any(|s| s == &pd_key) && !follows_pd_label(&blocks, i) {
                continue;
            }
        }
        let key = block_key(block);
        if seen.iter().any(|s: &String| s == &key) {
            continue;
        }
        seen.push(key);
        kept.extend(block.iter().cloned());
    }
    kept.join("\n")
}

/// Normalize `entry list` / `entry list+` replies.
///
/// 1. If classic `Name : OK|FAIL|n/a` lines exist, keep those (deduped).
/// 2. Otherwise keep the detailed firmware format but collapse repeated
///    PD capability blocks (`PD3.0:…` + Fixed/PPS tables).
pub fn normalize_scan_text(text: &str) -> String {
    let mut kept = Vec::new();
    let mut seen = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        if !is_protocol_scan_line(&lower) {
            continue;
        }
        let key: String = lower.split_whitespace().collect::<Vec<_>>().join(" ");
        if seen.iter().any(|s: &String| s == &key) {
            continue;
        }
        seen.push(key);
        kept.push(trimmed.to_string());
    }
    if !kept.is_empty() {
        return kept.join("\n");
    }
    dedupe_detail_blocks(text)
}

fn line_negative(lower: &str) -> bool {
    lower.contains("fail")
        || lower.contains("error")
        || lower.contains("失败")
        || lower.contains("不支持")
        || lower.contains("未支持")
        || lower.contains("not support")
        || lower.contains("unsupported")
        || lower.contains(": no")
        || lower.contains("：no")
        || lower.contains(" n/a")
        || lower.ends_with("n/a")
        || lower.contains(":null")
        || lower.contains(": null")
        || empty_scan_field(lower)
}

fn empty_scan_field(lower: &str) -> bool {
    let Some((key, rest)) = lower.split_once(':') else {
        return false;
    };
    if !rest.trim().is_empty() {
        return false;
    }
    let key = key.trim();
    SCAN_FIELD_NAMES.contains(&key)
}

fn contains_token(hay: &str, needle: &str) -> bool {
    let bytes = hay.as_bytes();
    let n = needle.as_bytes();
    if n.is_empty() {
        return false;
    }
    let mut start = 0;
    while start + n.len() <= bytes.len() {
        if let Some(i) = hay[start..].find(needle) {
            let abs = start + i;
            let before_ok = abs == 0 || !bytes[abs - 1].is_ascii_alphanumeric();
            let after = abs + n.len();
            let after_ok = after >= bytes.len() || !bytes[after].is_ascii_alphanumeric();
            if before_ok && after_ok {
                return true;
            }
            start = abs + 1;
        } else {
            break;
        }
    }
    false
}

fn parse_position(raw: &str) -> Option<u8> {
    let bytes = raw.as_bytes();
    if bytes.first() == Some(&b'[') {
        let end = raw.find(']')?;
        return raw[1..end].trim().parse().ok();
    }
    let lower = raw.to_ascii_lowercase();
    for prefix in ["pdo", "obj", "#"] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            let rest = rest.trim_start_matches(['=', ' ', ':', '：']);
            let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(n) = num.parse::<u8>() {
                if n > 0 {
                    return Some(n);
                }
            }
        }
    }
    let start: String = raw.chars().take_while(|c| c.is_ascii_digit()).collect();
    if start.is_empty() {
        return None;
    }
    let next = raw[start.len()..].chars().next();
    if matches!(
        next,
        Some('.' | '、' | ':' | '：' | ')' | ' ' | '\t' | '|' | '-')
    ) {
        return start.parse().ok();
    }
    None
}

fn skip_pdo_index(lower: &str) -> &str {
    let s = lower.trim();
    if let Some(rest) = s.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            return rest[end + 1..].trim();
        }
    }
    for prefix in ["pdo", "obj", "#"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            let rest = rest.trim_start_matches(['=', ' ', ':', '：']);
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            if digits > 0 {
                return rest[digits..].trim_start_matches([':', '：', '.', ')', '-', ' ']);
            }
        }
    }
    let digits = s.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0 {
        let rest = &s[digits..];
        if rest.starts_with(['.', '、', ':', '：', ')', ' ', '\t', '|', '-']) {
            return rest.trim_start_matches(['.', '、', ':', '：', ')', ' ', '\t', '|', '-']);
        }
    }
    s
}

fn quick_kind_prefix(lower: &str) -> Option<&'static str> {
    let s = skip_pdo_index(lower);
    let tok_len = s.bytes().take_while(u8::is_ascii_alphabetic).count();
    if tok_len == 0 {
        return None;
    }
    let tok = &s[..tok_len];
    let after = s[tok_len..].chars().next();
    if after.is_some_and(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    match tok {
        "ea" => Some("epr_avs"),
        "sa" => Some("spr_avs"),
        "ef" => Some("epr_fixed"),
        "eb" => Some("battery"),
        "ev" => Some("variable"),
        "f" => Some("fixed"),
        "p" => Some("pps"),
        "b" => Some("battery"),
        "v" => Some("variable"),
        _ => None,
    }
}

fn classify_pdo(lower: &str, raw: &str) -> String {
    if lower.contains("epr avs") {
        "epr_avs".into()
    } else if lower.contains("spr avs") {
        "spr_avs".into()
    } else if lower.contains("epr fixed") {
        "epr_fixed".into()
    } else if lower.contains("pps") {
        "pps".into()
    } else if lower.contains("avs") {
        "avs".into()
    } else if lower.contains("battery") {
        "battery".into()
    } else if lower.contains("variable") {
        "variable".into()
    } else if lower.contains("fixed") {
        "fixed".into()
    } else if let Some(kind) = quick_kind_prefix(lower) {
        kind.into()
    } else if voltages_mv(raw).is_some_and(|(a, b)| a != b) {
        "pps".into()
    } else {
        "fixed".into()
    }
}

fn extract_pdp_w(raw: &str) -> Option<u32> {
    let lower = raw.to_ascii_lowercase();
    let mut i = 0;
    while i < lower.len() {
        let Some((n, after)) = parse_num_at(&lower, i) else {
            i += 1;
            continue;
        };
        let rest = lower[after..].trim_start();
        let skipped = lower[after..].len() - rest.len();
        let unit_at = after + skipped;
        if rest.starts_with('w') && unit_boundary(&lower[unit_at..], "w") && n > 0.0 && n <= 1000.0
        {
            return Some(n.round() as u32);
        }
        i = after.max(i + 1);
    }
    None
}

fn voltages_mv(raw: &str) -> Option<(u32, u32)> {
    if let Some((a, b)) = scan_range(raw, "mv", 1) {
        return Some((a, b));
    }
    if let Some((a, b)) = scan_range(raw, "v", 1000) {
        return Some((a.min(b), a.max(b)));
    }
    if let Some(v) = scan_single(raw, "mv", 1) {
        return Some((v, v));
    }
    if let Some(v) = scan_single(raw, "v", 1000) {
        return Some((v, v));
    }
    None
}

fn scan_range(raw: &str, unit: &str, scale: u32) -> Option<(u32, u32)> {
    let lower = raw.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] != b'-' {
            continue;
        }
        let left = parse_number_end(&lower[..i])?;
        let right_src = &lower[i + 1..];
        let (right, consumed) = parse_number_start(right_src)?;
        let after = right_src[consumed..].trim_start();
        if !after.starts_with(unit) {
            continue;
        }
        if unit == "v" && after.starts_with("vooc") {
            continue;
        }
        if unit == "a" && (after.starts_with("avs") || after.starts_with("afc")) {
            continue;
        }
        return Some((to_milli(left, scale), to_milli(right, scale)));
    }
    None
}

fn scan_single(raw: &str, unit: &str, scale: u32) -> Option<u32> {
    let lower = raw.to_ascii_lowercase();
    let mut search_from = 0;
    while search_from < lower.len() {
        let rest = &lower[search_from..];
        let Some(idx) = rest.find(unit) else {
            break;
        };
        let abs = search_from + idx;
        let after = &lower[abs..];
        if !unit_boundary(after, unit) {
            search_from = abs + 1;
            continue;
        }
        if let Some(n) = parse_number_end(&lower[..abs]) {
            if unit == "v" && after.starts_with("vooc") {
                search_from = abs + 1;
                continue;
            }
            if unit == "a" && (after.starts_with("avs") || after.starts_with("afc")) {
                search_from = abs + 1;
                continue;
            }
            return Some(to_milli(n, scale));
        }
        search_from = abs + 1;
    }
    None
}

fn unit_boundary(after: &str, unit: &str) -> bool {
    let rest = &after[unit.len()..];
    // Digit after the unit is concatenation like `5V3A`, not part of the unit name.
    rest.is_empty() || rest.starts_with(|c: char| !c.is_ascii_alphabetic())
}

fn parse_number_end(src: &str) -> Option<f64> {
    let s = src.trim_end_matches(|c: char| !c.is_ascii_digit() && c != '.');
    let start = s
        .rfind(|c: char| !(c.is_ascii_digit() || c == '.'))
        .map(|i| i + 1)
        .unwrap_or(0);
    let num = s[start..].trim();
    if num.is_empty() || num == "." {
        return None;
    }
    num.parse().ok()
}

fn parse_number_start(src: &str) -> Option<(f64, usize)> {
    let s = src.trim_start();
    let skipped = src.len() - s.len();
    let mut end = 0;
    let bytes = s.as_bytes();
    while end < bytes.len() && (bytes[end].is_ascii_digit() || bytes[end] == b'.') {
        end += 1;
    }
    if end == 0 {
        return None;
    }
    let n = s[..end].parse().ok()?;
    Some((n, skipped + end))
}

fn to_milli(v: f64, scale: u32) -> u32 {
    (v * scale as f64).round() as u32
}

fn format_label(
    position: u8,
    kind: &str,
    volt_min_mv: u32,
    volt_max_mv: u32,
    cur_ma: Option<u32>,
) -> String {
    let kind_u = kind_heading(kind);
    let v = if volt_min_mv == volt_max_mv {
        format!("{:.2} V", volt_min_mv as f64 / 1000.0)
    } else {
        format!(
            "{:.2}-{:.2} V",
            volt_min_mv as f64 / 1000.0,
            volt_max_mv as f64 / 1000.0
        )
    };
    match cur_ma {
        Some(c) => format!("#{position} {kind_u} {v} {:.2} A", c as f64 / 1000.0),
        None => format!("#{position} {kind_u} {v}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_fixed_and_pps_lines() {
        let text = "\
[1] Fixed 5.00V 3.00A
[2] Fixed 9.00V 3.00A
[3] PPS 3.30-21.00V 3.00A
ready
";
        let pdos = parse_pdos(text);
        assert_eq!(pdos.len(), 3);
        assert_eq!(pdos[0].position, 1);
        assert_eq!(pdos[0].kind, "fixed");
        assert_eq!(pdos[0].volt_min_mv, 5000);
        assert_eq!(pdos[0].volt_max_mv, 5000);
        assert_eq!(pdos[0].cur_ma, Some(3000));
        assert!(!pdos[0].programmable);
        assert_eq!(pdos[2].kind, "pps");
        assert_eq!(pdos[2].volt_min_mv, 3300);
        assert_eq!(pdos[2].volt_max_mv, 21000);
        assert!(pdos[2].programmable);
    }

    #[test]
    fn parse_pdo_prefix_and_obj() {
        let pdos = parse_pdos("PDO1: 5V/3A\nobj=2  12.00V  2.00A  Fixed\n");
        assert_eq!(pdos.len(), 2);
        assert_eq!(pdos[0].position, 1);
        assert_eq!(pdos[0].volt_max_mv, 5000);
        assert_eq!(pdos[1].position, 2);
        assert_eq!(pdos[1].volt_max_mv, 12000);
    }

    #[test]
    fn parse_list_skips_failed_protocols() {
        let text = "\
PD : OK
QC2.0 : OK
QC3.0 : OK
FCP : FAIL
AFC : n/a
UFCS : OK
";
        let found = parse_detected_protocols(text);
        let ids: Vec<_> = found.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["pd", "qc", "qc3", "ufcs"]);
    }

    #[test]
    fn parse_spaced_index_and_unnumbered() {
        let pdos = parse_pdos("1  5.00V  3.00A\n2  9.00V  3.00A\nPPS 3.30-21.00V 3.00A\n");
        assert_eq!(pdos.len(), 3);
        assert_eq!(pdos[0].position, 1);
        assert_eq!(pdos[0].volt_max_mv, 5000);
        assert_eq!(pdos[1].position, 2);
        assert_eq!(pdos[2].kind, "pps");
        assert_eq!(pdos[2].position, 3);
    }

    #[test]
    fn qc3_not_confused_with_qc2() {
        let found = parse_detected_protocols("QC3.0 : OK\n");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "qc3");
    }

    #[test]
    fn parse_multiple_protocols_on_one_line() {
        let found = parse_detected_protocols("PD QC2.0 QC3.0 FCP AFC UFCS\n");
        let ids: Vec<_> = found.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["pd", "qc3", "qc", "fcp", "afc", "ufcs"]);
    }

    #[test]
    fn parse_concatenated_and_comma_pdos() {
        let a = parse_pdos("5V3A 9V3A 12V3A");
        assert_eq!(a.len(), 3);
        assert_eq!(a[0].volt_max_mv, 5000);
        assert_eq!(a[0].cur_ma, Some(3000));
        assert_eq!(a[1].volt_max_mv, 9000);
        assert_eq!(a[2].volt_max_mv, 12000);
        assert_eq!(a[0].position, 1);
        assert_eq!(a[2].position, 3);

        let b = parse_pdos("5V/3A, 9V/3A, PPS 3.3-21V 3A");
        assert_eq!(b.len(), 3);
        assert_eq!(b[0].kind, "fixed");
        assert_eq!(b[1].volt_max_mv, 9000);
        assert_eq!(b[2].kind, "pps");
        assert_eq!(b[2].volt_min_mv, 3300);
        assert_eq!(b[2].volt_max_mv, 21000);
    }

    #[test]
    fn parse_semicolon_and_mv_units() {
        let pdos = parse_pdos("[1] 5000mV 3000mA; [2] 9.00V 3.00A");
        assert_eq!(pdos.len(), 2);
        assert_eq!(pdos[0].position, 1);
        assert_eq!(pdos[0].volt_max_mv, 5000);
        assert_eq!(pdos[0].cur_ma, Some(3000));
        assert_eq!(pdos[1].position, 2);
        assert_eq!(pdos[1].volt_max_mv, 9000);
    }

    #[test]
    fn sanitize_drops_control_and_punct_only_lines() {
        let raw = "ok\npdo:7\u{000b},\u{FFFD}\u{0001}\n,\u{FFFD}\u{0002}\nready:5217mV,0mA";
        let clean = sanitize_trigger_text(raw);
        assert_eq!(clean, "ok\npdo:7\nready:5217mV,0mA");
    }

    #[test]
    fn sanitize_drops_gbk_mojibake_pdo_tail() {
        let raw = "pdo:7\n,劝朄<2芾2惲\nready:5217mV,0mA\nmax power 30W";
        let clean = sanitize_trigger_text(raw);
        assert_eq!(clean, "pdo:7\nready:5217mV,0mA\nmax power 30W");
        assert!(!clean.contains('劝'));
    }

    #[test]
    fn sanitize_clips_inline_cjk_on_pdo_count_line() {
        let raw = "ok\npdo:7,憗\nready:5100mV,0mA\nmax power 100W\npdo:9,憗";
        let clean = sanitize_trigger_text(raw);
        assert_eq!(clean, "ok\npdo:7\nready:5100mV,0mA\nmax power 100W\npdo:9");
        assert!(!clean.contains('憗'));
    }

    #[test]
    fn sanitize_keeps_real_firmware_chinese() {
        let raw = "失败\n就绪\n不支持\n最大功率 100W";
        let clean = sanitize_trigger_text(raw);
        assert_eq!(clean, raw);
    }

    #[test]
    fn normalize_scan_keeps_first_ok_line() {
        let text = "PD\nready\nPD : OK\nQC2.0 : OK\nPD : OK\nFCP : FAIL";
        let norm = normalize_scan_text(text);
        assert_eq!(norm, "PD : OK\nQC2.0 : OK\nFCP : FAIL");
    }

    #[test]
    fn normalize_scan_fallback_when_no_scan_lines() {
        let text = "ok\ncc1 attach\nready";
        assert_eq!(normalize_scan_text(text), text);
    }

    #[test]
    fn normalize_scan_dedupes_repeated_pd_detail_block() {
        let text = "\
starting
bc1.2:true 5216mV,0mA
Apple 2.4A
ufcs:null
vfcp:null
qc2.0:5V,9V,12V
qc3.0:3.6-12V
afc:5V,9V,12V
fcp:5V,9V,12V
scp:22.0W,5.00V-12.00V,0.03A-4.20A
sfcp:null
tfcp:null
pd:
PD3.0:30W PDO:7
Fixed:     5.00V 3.00A
Fixed:     9.00V 3.00A
Fixed:    12.00V 2.50A
Fixed:    15.00V 2.00A
Fixed:    20.00V 1.50A
PPS: 5.00-11.00V 3.00A
PPS: 5.00-20.00V 1.50A
PD3.0:30W PDO:7
Fixed:     5.00V 3.00A
Fixed:     9.00V 3.00A
Fixed:    12.00V 2.50A
Fixed:    15.00V 2.00A
Fixed:    20.00V 1.50A
PPS: 5.00-11.00V 3.00A
PPS: 5.00-20.00V 1.50A
done
";
        let norm = normalize_scan_text(text);
        assert_eq!(norm.matches("PD3.0:30W PDO:7").count(), 1);
        assert_eq!(norm.matches("Fixed:").count(), 5);
        assert_eq!(norm.matches("PPS:").count(), 2);
        assert!(norm.contains("qc2.0:5V,9V,12V"));
        assert!(norm.contains("pd:"));
        assert!(norm.contains("done"));
        assert!(norm.contains("starting"));
        // Second identical PD block removed; order preserved.
        let pd_pos = norm.find("PD3.0:30W PDO:7").unwrap();
        let done_pos = norm.find("done").unwrap();
        assert!(pd_pos < done_pos);
    }

    #[test]
    fn sanitize_splits_pd_glued_to_svooc() {
        let clean = sanitize_trigger_text("svooc:PD3.2:60W PDO:7");
        assert_eq!(clean, "svooc:\nPD3.2:60W PDO:7");
    }

    #[test]
    fn parse_pd32_skips_null_and_empty_protocol_fields() {
        for text in [
            "svooc:null\nvooc:null\npd:\nPD3.2:60W PDO:7\n",
            "svooc:\nPD3.2:60W PDO:7\n",
        ] {
            let found = parse_detected_protocols(text);
            let ids: Vec<_> = found.iter().map(|p| p.id.as_str()).collect();
            assert!(ids.contains(&"pd"), "{text:?}: {ids:?}");
            assert!(!ids.contains(&"vooc"), "{text:?}: {ids:?}");
        }
    }

    #[test]
    fn normalize_scan_moves_pd_off_svooc() {
        let text = "\
starting
bc1.2:true 5100mV,0mA
Apple 2.4A
ufcs:null
vfcp:null
qc2.0:5V,9V,12V
qc3.0:3.6-12V
afc:5V,9V,12V
fcp:5V,9V,12V
scp:25.0W,5.00V-12.00V,0.03A-2.50A
sfcp:null
tfcp:null
svooc:PD3.2:60W PDO:7
Fixed:     5.00V 3.00A
Fixed:     9.00V 3.00A
Fixed:    12.00V 3.00A
Fixed:    15.00V 3.00A
Fixed:    20.00V 3.00A
AVS: 9-20V3.00A,3.00A
PPS: 5.00-21.00V 3.00A
null
vooc:null
mtkpe:
mtkpe2.0:
pd:
PD3.2:60W PDO:7
Fixed:     5.00V 3.00A
Fixed:     9.00V 3.00A
Fixed:    12.00V 3.00A
Fixed:    15.00V 3.00A
Fixed:    20.00V 3.00A
AVS: 9-20V3.00A,3.00A
PPS: 5.00-21.00V 3.00A
done
";
        let norm = normalize_scan_text(text);
        assert_eq!(norm.matches("PD3.2:60W PDO:7").count(), 1);
        assert_eq!(norm.matches("Fixed:").count(), 5);
        assert_eq!(norm.matches("AVS:").count(), 1);
        assert_eq!(norm.matches("PPS:").count(), 1);
        assert!(norm.contains("svooc:null"));
        assert!(!norm.to_ascii_lowercase().contains("svooc:pd"));
        assert!(norm.contains("pd:"));
        assert!(norm.contains("vooc:null"));
        assert!(norm.contains("done"));
        let pd_label = norm.find("pd:").unwrap();
        let pd_table = norm.find("PD3.2:60W PDO:7").unwrap();
        assert!(pd_label < pd_table);
    }

    #[test]
    fn parse_avs_dual_current_keeps_both_in_label() {
        let pdos = parse_pdos("#6 AVS 9.00-20.00 V 3.00/5.00 A");
        assert_eq!(pdos.len(), 2, "{pdos:?}");
        assert_eq!(pdos[0].position, 6);
        assert_eq!(pdos[1].position, 6);
        assert_eq!(pdos[0].kind, "avs");
        assert_eq!(pdos[0].volt_min_mv, 9000);
        assert_eq!(pdos[0].volt_max_mv, 15_000);
        assert_eq!(pdos[0].cur_ma, Some(3000));
        assert_eq!(pdos[1].volt_min_mv, 15_000);
        assert_eq!(pdos[1].volt_max_mv, 20_000);
        assert_eq!(pdos[1].cur_ma, Some(5000));
        assert!(pdos[0].label.contains("3.00 A"), "{}", pdos[0].label);
        assert!(pdos[1].label.contains("5.00 A"), "{}", pdos[1].label);
    }

    #[test]
    fn spr_avs_text_encodings_preserve_bands_and_physical_positions() {
        for text in [
            "AVS: 9-20V2.95A,4.95A",
            "SPR AVS 9-20V 2.95 / 4.95 A",
            "SPR AVS 9-20V 2.95A / 4.95A",
            "SPR AVS 9-20V 2.95,4.95A",
            "SPR AVS 9-20V 2950mA，4950mA",
            "SA 9-15V@2.95A,15-20V@4.95A",
            "SA 15-20V@4.95A、9-15V@2.95A",
        ] {
            let pdos = parse_pdos(&format!("#5 Fixed 20V4.95A; #6 {text}, PPS 3.3-21V3A"));
            assert_eq!(pdos.len(), 4, "{text}: {pdos:?}");
            assert_eq!(
                pdos.iter()
                    .map(|p| (p.position, p.volt_min_mv, p.volt_max_mv, p.cur_ma))
                    .collect::<Vec<_>>(),
                [
                    (5, 20_000, 20_000, Some(4950)),
                    (6, 9000, 15_000, Some(2950)),
                    (6, 15_000, 20_000, Some(4950)),
                    (7, 3300, 21_000, Some(3000)),
                ],
                "{text}"
            );
        }
        // A single advertised limit applies to its stated range, without
        // inventing a 15–20 V band for a source whose maximum is 15 V.
        for (text, expected) in [
            ("AVS 9-15V2.95A", vec![(9000, 15_000, Some(2950))]),
            ("AVS 9-20V2.95A,0A", vec![(9000, 15_000, Some(2950))]),
            ("AVS 9-20V0A,4.95A", vec![(15_000, 20_000, Some(4950))]),
            ("AVS 12-20V3A", vec![(12_000, 20_000, Some(3000))]),
        ] {
            let pdos = parse_pdos(text);
            assert_eq!(
                pdos.iter()
                    .map(|p| (p.volt_min_mv, p.volt_max_mv, p.cur_ma))
                    .collect::<Vec<_>>(),
                expected,
                "{text}"
            );
        }
        for text in [
            "AVS 9-20V0A,0A",
            "AVS 9-20V3A,5.01A",
            "AVS 9-20V5.01A,3A",
            "AVS 9-20V3.001A,3A",
        ] {
            let pdos = parse_pdos(&format!("#6 {text}\nPPS 3.3-21V3A"));
            assert_eq!(pdos.len(), 1, "{text}: {pdos:?}");
            assert_eq!(pdos[0].position, 7, "{text}");
            assert_eq!(pdos[0].kind, "pps", "{text}");
        }
    }

    #[test]
    fn pdp_at_vmax_converts_to_current() {
        assert_eq!(pdp_to_current_ma(240, 48_000), Some(5000));
        assert_eq!(pdp_to_current_ma(140, 28_000), Some(5000));
        assert_eq!(pdp_to_current_ma(0, 48_000), None);
        assert_eq!(pdp_to_current_ma(240, 0), None);
        assert_eq!(
            avs_current_ma(Some(5000), Some(3000), None, 20_000),
            Some(5000)
        );
        assert_eq!(avs_current_ma(None, Some(3000), None, 20_000), Some(3000));
        assert_eq!(avs_current_ma(None, None, Some(240), 48_000), Some(5000));
        assert_eq!(
            expand_spr_avs_bands(Some(3000), Some(5000)),
            vec![(9000, 15_000, 3000), (15_000, 20_000, 5000)]
        );
        assert_eq!(
            expand_spr_avs_bands(Some(3000), None),
            vec![(9000, 15_000, 3000)]
        );
        assert!(expand_spr_avs_bands(None, None).is_empty());
        assert!(spr_avs_pdos(6, "spr_avs", Some(5010), Some(3000)).is_empty());
        assert!(spr_avs_pdos(6, "spr_avs", Some(3000), Some(5010)).is_empty());
    }

    #[test]
    fn parse_sa_ea_ef_quick_summaries() {
        let sa = parse_pdos("SA 9-15V@3.0A 15-20V@5.0A");
        assert_eq!(sa.len(), 2, "{sa:?}");
        assert_eq!(sa[0].kind, "spr_avs");
        assert_eq!(sa[0].position, sa[1].position);
        assert_eq!(sa[0].volt_min_mv, 9000);
        assert_eq!(sa[0].volt_max_mv, 15_000);
        assert_eq!(sa[0].cur_ma, Some(3000));
        assert_eq!(sa[1].volt_min_mv, 15_000);
        assert_eq!(sa[1].volt_max_mv, 20_000);
        assert_eq!(sa[1].cur_ma, Some(5000));
        assert!(sa[0].programmable);
        assert!(sa[1].programmable);

        let ea = parse_pdos("EA 15-48V@240W");
        assert_eq!(ea.len(), 1, "{ea:?}");
        assert_eq!(ea[0].kind, "epr_avs");
        assert_eq!(ea[0].volt_min_mv, 15_000);
        assert_eq!(ea[0].volt_max_mv, 48_000);
        assert_eq!(ea[0].cur_ma, Some(5000));
        assert!(ea[0].label.contains("240 W"), "{}", ea[0].label);

        let ef = parse_pdos("EF 28V@5A");
        assert_eq!(ef.len(), 1, "{ef:?}");
        assert_eq!(ef[0].kind, "epr_fixed");
        assert_eq!(ef[0].volt_min_mv, 28_000);
        assert_eq!(ef[0].volt_max_mv, 28_000);
        assert_eq!(ef[0].cur_ma, Some(5000));
        assert!(!ef[0].programmable);
    }

    #[test]
    fn parse_spr_epr_avs_words_and_at_watts() {
        let spr = parse_pdos("SPR AVS: 9.00-20.00V 3.00/5.00A");
        assert_eq!(spr.len(), 2, "{spr:?}");
        assert_eq!(spr[0].kind, "spr_avs");
        assert_eq!(spr[0].position, spr[1].position);
        assert_eq!(spr[0].cur_ma, Some(3000));
        assert_eq!(spr[1].cur_ma, Some(5000));
        assert_eq!(spr[0].volt_max_mv, 15_000);
        assert_eq!(spr[1].volt_max_mv, 20_000);

        let epr = parse_pdos("EPR AVS: 15.00-48.00V 240W");
        assert_eq!(epr.len(), 1, "{epr:?}");
        assert_eq!(epr[0].kind, "epr_avs");
        assert_eq!(epr[0].cur_ma, Some(5000));
        assert_eq!(epr[0].volt_max_mv, 48_000);
    }
}

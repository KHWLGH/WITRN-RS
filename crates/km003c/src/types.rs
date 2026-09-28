//! Values exchanged with callers: trigger commands, their outcome, and the parsed
//! capability lists. JSON shapes are part of the app's IPC contract.

use serde::{Deserialize, Serialize};

/// One protocol-trigger command, sent to the meter as CDC text.
///
/// Serialized with a `type` tag in snake_case, e.g. `{"type":"pd_req","position":2}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TriggerCommand {
    Entry {
        protocol: String,
    },
    PdPdo,
    PdReq {
        position: u8,
        volt_mv: Option<u32>,
        cur_ma: Option<u32>,
    },
    PdCmd {
        cmd: u8,
    },
    PdData {
        hex: String,
    },
    Qc {
        voltage: String,
    },
    Qc3 {
        volt_mv: u32,
    },
    Qc3Adjust {
        steps: i32,
    },
    Fcp {
        voltage: String,
    },
    Afc {
        voltage: String,
    },
    Sfcp {
        voltage: String,
    },
    Scp {
        volt_mv: u32,
        cur_ma: u32,
    },
    Vfcp {
        volt_mv: u32,
        cur_ma: u32,
    },
    Ufcs {
        req: u8,
        volt_mv: Option<u32>,
        cur_ma: Option<u32>,
    },
    UfcsCmd {
        cmd: u32,
    },
    Reset,
    Raw {
        command: String,
    },
    List {
        plus: bool,
    },
    PdmSet {
        pd_type: u8,
        em: u8,
        sink: u8,
    },
    PdmOpen,
    PdmClose,
}

/// A source capability the trigger can request, as the meter reported it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TriggerPdo {
    /// 1-based object position; SPR AVS bands share their physical position.
    pub position: u8,
    pub kind: String,
    pub volt_min_mv: u32,
    pub volt_max_mv: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cur_ma: Option<u32>,
    pub label: String,
    pub programmable: bool,
}

/// A fast-charge protocol the meter's `entry list` scan reported as supported.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DetectedProtocol {
    pub id: String,
    pub label: String,
}

/// Sink-emulation settings applied with `pdm set type=..,em=..,sink=..`.
///
/// `pd_type`: 0 auto, 1 PD 3.0, 2 PD 3.1, 3 private PPS. `em` (E-Marker): 0 off,
/// 1 20 V 5 A, 2 50 V 5 A EPR, 3 LA135 6.75 A. `sink`: 0 3 A PPS, 1 5 A PPS.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PdmConfig {
    pub pd_type: u8,
    pub em: u8,
    pub sink: u8,
}

impl Default for PdmConfig {
    fn default() -> Self {
        Self {
            pd_type: 1,
            em: 1,
            sink: 0,
        }
    }
}

/// What one trigger command produced.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TriggerOutcome {
    pub ok: bool,
    pub message: String,
    pub pdos: Vec<TriggerPdo>,
    pub protocols: Vec<DetectedProtocol>,
    /// `pdm_required`, `protocol_rejected`, `transport_error` or `cancelled`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// Session state after the command, authoritative for the UI's PDM indicator.
    pub pdm_open: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn commands_keep_their_snake_case_json_shape() {
        let cmd: TriggerCommand = serde_json::from_value(
            json!({"type": "pd_req", "position": 2, "volt_mv": 9000, "cur_ma": null}),
        )
        .unwrap();
        assert_eq!(
            cmd,
            TriggerCommand::PdReq {
                position: 2,
                volt_mv: Some(9000),
                cur_ma: None
            }
        );
        assert_eq!(
            serde_json::to_value(TriggerCommand::List { plus: true }).unwrap(),
            json!({"type": "list", "plus": true})
        );
        assert_eq!(
            serde_json::to_value(TriggerCommand::PdmOpen).unwrap(),
            json!({"type": "pdm_open"})
        );
        assert_eq!(
            serde_json::from_value::<TriggerCommand>(json!({"type": "qc3_adjust", "steps": -1}))
                .unwrap(),
            TriggerCommand::Qc3Adjust { steps: -1 }
        );
    }

    #[test]
    fn outcome_omits_absent_code_and_optional_current() {
        let outcome = TriggerOutcome {
            ok: true,
            message: "ok".into(),
            pdos: vec![TriggerPdo {
                position: 1,
                kind: "fixed".into(),
                volt_min_mv: 5000,
                volt_max_mv: 5000,
                cur_ma: None,
                label: "#1 FIXED 5.00 V".into(),
                programmable: false,
            }],
            protocols: Vec::new(),
            code: None,
            pdm_open: true,
        };
        let value = serde_json::to_value(outcome).unwrap();
        assert!(value.get("code").is_none());
        assert!(value["pdos"][0].get("cur_ma").is_none());
        assert_eq!(value["pdm_open"], json!(true));
    }
}

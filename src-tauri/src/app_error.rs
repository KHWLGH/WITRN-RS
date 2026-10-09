use serde::Serialize;
use std::collections::BTreeMap;

/// Stable, language-independent IPC description. Raw diagnostics stay in `detail`.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct AppError {
    pub code: &'static str,
    pub params: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl AppError {
    pub fn message(
        code: &'static str,
        params: impl IntoIterator<Item = (&'static str, String)>,
    ) -> Self {
        Self {
            code,
            params: params
                .into_iter()
                .map(|(key, value)| (key.to_owned(), value))
                .collect(),
            detail: None,
        }
    }

    pub fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            params: BTreeMap::new(),
            detail: Some(detail.into()),
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}: {}",
            self.code,
            self.detail.as_deref().unwrap_or_default()
        )
    }
}

impl std::error::Error for AppError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipc_preserves_code_params_and_diagnostics() {
        let value =
            serde_json::to_value(AppError::new("deviceOpenFailed", "original diagnostic")).unwrap();
        assert_eq!(value["code"], "deviceOpenFailed");
        assert_eq!(value["params"], serde_json::json!({}));
        assert_eq!(value["detail"], "original diagnostic");
        let description = serde_json::to_value(AppError::message(
            "deviceInterface",
            [("index", "2".to_owned()), ("usage", "FF00".to_owned())],
        ))
        .unwrap();
        assert_eq!(description["params"]["index"], "2");
        assert_eq!(description["params"]["usage"], "FF00");
        assert!(description.get("detail").is_none());
    }
}

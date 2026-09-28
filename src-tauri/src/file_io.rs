//! File handles for CSV export, CSV import and the live recording spool.
//!
//! The frontend never names a path. Export and import paths come from native dialogs
//! opened here; recording spools live in the application cache and are removed after a
//! clean close. Bytes then stream through numbered handles, so no file ever has to exist
//! as one string in the WebView.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::AppState;

/// Open handles per kind; a leak from a crashed page cannot exhaust descriptors.
const MAX_OPEN: usize = 8;
/// Largest slice `csv_read_chunk` returns.
const READ_CHUNK: usize = 4 * 1024 * 1024;
/// Writes are buffered; `sync` and `close` flush.
const WRITE_BUFFER: usize = 1024 * 1024;
/// The cache subdirectory used for crash-recovery files.
const SPOOL_FOLDER: &str = "recording-recovery";
const SPOOL_SUFFIX: &str = ".partial.csv";

struct Writer {
    file: BufWriter<File>,
    path: PathBuf,
    /// Leading bytes that may later be rewritten in place (the spool's fixed-width header).
    patchable: u64,
}

struct Reader {
    file: BufReader<File>,
}

#[derive(Default)]
pub(crate) struct FileRegistry {
    next: u32,
    writers: HashMap<u32, Arc<Mutex<Writer>>>,
    readers: HashMap<u32, Arc<Mutex<Reader>>>,
}

impl FileRegistry {
    fn id(&mut self) -> u32 {
        self.next = self.next.wrapping_add(1).max(1);
        self.next
    }

    fn add_writer(&mut self, writer: Writer) -> Result<u32, String> {
        if self.writers.len() >= MAX_OPEN {
            return Err("打开的写入文件过多".into());
        }
        let id = self.id();
        self.writers.insert(id, Arc::new(Mutex::new(writer)));
        Ok(id)
    }

    fn add_reader(&mut self, reader: Reader) -> Result<u32, String> {
        if self.readers.len() >= MAX_OPEN {
            return Err("打开的读取文件过多".into());
        }
        let id = self.id();
        self.readers.insert(id, Arc::new(Mutex::new(reader)));
        Ok(id)
    }

    /// Flush and close every writer. Used on exit so nothing buffered is lost.
    pub(crate) fn close_all(&mut self) {
        for (_, writer) in self.writers.drain() {
            if let Ok(mut writer) = writer.lock() {
                if writer.file.flush().is_ok() {
                    let _ = writer.file.get_ref().sync_all();
                }
            }
        }
        self.readers.clear();
    }
}

/// A file handed to the frontend.
#[derive(Serialize)]
pub(crate) struct Opened {
    handle: u32,
    /// File name only, for messages.
    name: String,
    /// Full path, shown so the user can find the file.
    path: String,
    /// Byte length at open time; 0 for new files.
    size: u64,
}

fn opened(handle: u32, path: &Path, size: u64) -> Opened {
    Opened {
        handle,
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.display().to_string(),
        size,
    }
}

fn registry<'a>(
    state: &'a State<'_, AppState>,
) -> Result<std::sync::MutexGuard<'a, FileRegistry>, String> {
    state
        .files
        .lock()
        .map_err(|_| "文件句柄状态已损坏".to_string())
}

fn writer(state: &State<'_, AppState>, handle: u32) -> Result<Arc<Mutex<Writer>>, String> {
    registry(state)?
        .writers
        .get(&handle)
        .cloned()
        .ok_or_else(|| "写入句柄已关闭".to_string())
}

fn header_u64(request: &Request<'_>, name: &str) -> Result<u64, String> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| format!("缺少请求头 {name}"))
}

fn raw_body<'a>(request: &'a Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
        InvokeBody::Json(_) => Err("需要二进制请求体".into()),
    }
}

/// Run a blocking native dialog off the async runtime, parented to the main window.
async fn dialog_path<R: Runtime + 'static>(
    app: AppHandle<R>,
    pick: impl FnOnce(tauri_plugin_dialog::FileDialogBuilder<R>) -> Option<tauri_plugin_dialog::FilePath>
        + Send
        + 'static,
) -> Result<Option<PathBuf>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app.dialog().file();
        if let Some(window) = app.get_webview_window("main") {
            builder = builder.set_parent(&window);
        }
        pick(builder)
    })
    .await
    .map_err(|error| error.to_string())?
    .map(|path| path.into_path().map_err(|error| error.to_string()))
    .transpose()
}

/// Ask where to save an export and open it for writing.
#[tauri::command]
pub(crate) async fn csv_export_pick(
    default_name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<Opened>, String> {
    let Some(path) = dialog_path(app, move |builder| {
        builder
            .add_filter("CSV File", &["csv"])
            .set_file_name(default_name)
            .blocking_save_file()
    })
    .await?
    else {
        return Ok(None);
    };
    let file = File::create(&path).map_err(|error| format!("无法创建文件: {error}"))?;
    let handle = registry(&state)?.add_writer(Writer {
        file: BufWriter::with_capacity(WRITE_BUFFER, file),
        path: path.clone(),
        patchable: 0,
    })?;
    Ok(Some(opened(handle, &path, 0)))
}

/// Ask which CSV to import and open it for reading.
#[tauri::command]
pub(crate) async fn csv_import_pick(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<Opened>, String> {
    let Some(path) = dialog_path(app, |builder| {
        builder
            .add_filter("CSV File", &["csv"])
            .blocking_pick_file()
    })
    .await?
    else {
        return Ok(None);
    };
    let file = File::open(&path).map_err(|error| format!("无法打开文件: {error}"))?;
    let size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let handle = registry(&state)?.add_reader(Reader {
        file: BufReader::with_capacity(READ_CHUNK, file),
    })?;
    Ok(Some(opened(handle, &path, size)))
}

/// The next slice of an import, up to 4 MiB; empty once the file is exhausted.
#[tauri::command(async)]
pub(crate) fn csv_read_chunk(handle: u32, state: State<'_, AppState>) -> Result<Response, String> {
    let reader = registry(&state)?
        .readers
        .get(&handle)
        .cloned()
        .ok_or("读取句柄已关闭")?;
    let mut reader = reader.lock().map_err(|_| "读取句柄已损坏")?;
    let mut buf = vec![0u8; READ_CHUNK];
    let mut filled = 0;
    // Fill the whole slice unless the file ends: fewer, larger IPC round trips.
    while filled < buf.len() {
        match reader.file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(format!("读取文件失败: {error}")),
        }
    }
    buf.truncate(filled);
    Ok(Response::new(buf))
}

#[tauri::command(async)]
pub(crate) fn csv_read_close(handle: u32, state: State<'_, AppState>) -> Result<(), String> {
    registry(&state)?.readers.remove(&handle);
    Ok(())
}

/// Append the raw request body to a writer (`x-handle` names it).
#[tauri::command(async)]
pub(crate) fn csv_write_chunk(
    request: Request<'_>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let handle = header_u64(&request, "x-handle")? as u32;
    let bytes = raw_body(&request)?;
    let writer = writer(&state, handle)?;
    let mut writer = writer.lock().map_err(|_| "写入句柄已损坏")?;
    writer
        .file
        .write_all(bytes)
        .map_err(|error| format!("写入文件失败: {error}"))
}

/// Overwrite bytes inside the patchable header (`x-handle`, `x-offset`), same length only.
#[tauri::command(async)]
pub(crate) fn csv_write_patch(
    request: Request<'_>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let handle = header_u64(&request, "x-handle")? as u32;
    let offset = header_u64(&request, "x-offset")?;
    let bytes = raw_body(&request)?;
    let writer = writer(&state, handle)?;
    let mut writer = writer.lock().map_err(|_| "写入句柄已损坏")?;
    let end = offset.saturating_add(bytes.len() as u64);
    if end > writer.patchable {
        return Err("回写超出表头范围".into());
    }
    let file = &mut writer.file;
    file.flush()
        .and_then(|()| file.get_mut().seek(SeekFrom::Start(offset)))
        .and_then(|_| file.get_mut().write_all(bytes))
        .and_then(|()| file.get_mut().seek(SeekFrom::End(0)))
        .map(|_| ())
        .map_err(|error| format!("回写表头失败: {error}"))
}

/// Push buffered bytes to the OS and ask it to persist them.
#[tauri::command(async)]
pub(crate) fn csv_write_sync(handle: u32, state: State<'_, AppState>) -> Result<(), String> {
    let writer = writer(&state, handle)?;
    let mut writer = writer.lock().map_err(|_| "写入句柄已损坏")?;
    writer
        .file
        .flush()
        .and_then(|()| writer.file.get_ref().sync_data())
        .map_err(|error| format!("同步文件失败: {error}"))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct CloseOptions {
    /// Persist before closing.
    sync: bool,
    /// Delete the file after closing. Used for failed exports and clean spool shutdown.
    abort: bool,
}

#[tauri::command(async)]
pub(crate) fn csv_write_close(
    handle: u32,
    options: Option<CloseOptions>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let options = options.unwrap_or_default();
    let Some(writer) = registry(&state)?.writers.remove(&handle) else {
        return Ok(());
    };
    let mut writer = writer.lock().map_err(|_| "写入句柄已损坏")?;
    let path = writer.path.clone();
    if options.abort {
        let flush_result = writer.file.flush().and_then(|()| {
            if options.sync {
                writer.file.get_ref().sync_all()
            } else {
                Ok(())
            }
        });
        drop(writer);
        let remove_result = std::fs::remove_file(&path)
            .or_else(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    Ok(())
                } else {
                    Err(error)
                }
            })
            .map_err(|error| format!("删除临时文件失败: {error}"));
        if let Err(error) = flush_result {
            return Err(format!("写入文件失败: {error}"));
        }
        return remove_result;
    }
    writer
        .file
        .flush()
        .and_then(|()| {
            if options.sync {
                writer.file.get_ref().sync_all()
            } else {
                Ok(())
            }
        })
        .map_err(|error| format!("写入文件失败: {error}"))
}

fn spool_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|dir| dir.join(SPOOL_FOLDER))
        .map_err(|error| format!("找不到应用缓存目录: {error}"))
}

/// A file name stem made only of characters every file system accepts.
fn sanitize_stem(stem: &str) -> String {
    let clean: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    if clean.trim_matches('_').is_empty() {
        "recording".into()
    } else {
        clean
    }
}

/// `dir/stem.csv`, or `dir/stem-2.csv` and onward when taken. Created exclusively, so
/// an existing recording is never overwritten.
fn create_unique(dir: &Path, stem: &str) -> Result<(File, PathBuf), String> {
    for attempt in 1..1000 {
        let name = if attempt == 1 {
            format!("{stem}.csv")
        } else {
            format!("{stem}-{attempt}.csv")
        };
        let path = dir.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((file, path)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("无法创建临时文件: {error}")),
        }
    }
    Err("临时目录里同名文件过多".into())
}

/// Create the temporary spool file for one recording. `header_len` leading bytes, written
/// next by the caller, may later be rewritten in place with `csv_write_patch`.
#[tauri::command(async)]
pub(crate) fn spool_open(
    stem: String,
    header_len: u64,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Opened, String> {
    let dir = spool_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("无法创建临时目录: {error}"))?;
    let (file, path) = create_unique(
        &dir,
        &format!(
            "{}{}",
            sanitize_stem(&stem),
            SPOOL_SUFFIX.trim_end_matches(".csv")
        ),
    )?;
    let handle = registry(&state)?.add_writer(Writer {
        file: BufWriter::with_capacity(WRITE_BUFFER, file),
        path: path.clone(),
        patchable: header_len,
    })?;
    Ok(opened(handle, &path, 0))
}

#[derive(Serialize)]
pub(crate) struct RecoveryEntry {
    id: String,
    name: String,
    size: u64,
    modified_ms: u128,
}

fn recovery_path<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<PathBuf, String> {
    let name = Path::new(id)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| *value == id && value.ends_with(SPOOL_SUFFIX))
        .ok_or_else(|| "无效的临时文件标识".to_string())?;
    Ok(spool_dir(app)?.join(name))
}

#[tauri::command(async)]
pub(crate) fn spool_recovery_list(app: AppHandle) -> Result<Vec<RecoveryEntry>, String> {
    let dir = spool_dir(&app)?;
    let mut entries = Vec::new();
    let Ok(read_dir) = std::fs::read_dir(&dir) else {
        return Ok(entries);
    };
    for item in read_dir.flatten() {
        let path = item.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("csv")
            || !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(SPOOL_SUFFIX))
        {
            continue;
        }
        let metadata = match item.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        entries.push(RecoveryEntry {
            id: name.clone(),
            name,
            size: metadata.len(),
            modified_ms,
        });
    }
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.modified_ms));
    Ok(entries)
}

#[tauri::command(async)]
pub(crate) fn spool_recovery_open(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Opened, String> {
    let path = recovery_path(&app, &id)?;
    let file = File::open(&path).map_err(|error| format!("无法打开临时文件: {error}"))?;
    let size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let handle = registry(&state)?.add_reader(Reader {
        file: BufReader::with_capacity(READ_CHUNK, file),
    })?;
    Ok(opened(handle, &path, size))
}

#[tauri::command(async)]
pub(crate) fn spool_recovery_delete(id: String, app: AppHandle) -> Result<(), String> {
    let path = recovery_path(&app, &id)?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("删除临时文件失败: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("witrn-file-io-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn stems_are_reduced_to_portable_characters() {
        assert_eq!(
            sanitize_stem("KM003C_20260928-143000"),
            "KM003C_20260928-143000"
        );
        assert_eq!(sanitize_stem("../../evil name"), "______evil_name");
        assert_eq!(sanitize_stem("///"), "recording");
        assert_eq!(sanitize_stem(&"x".repeat(100)).len(), 64);
    }

    #[test]
    fn unique_creation_never_reuses_an_existing_recording() {
        let dir = temp_dir("unique");
        let (_, first) = create_unique(&dir, "rec").unwrap();
        let (_, second) = create_unique(&dir, "rec").unwrap();
        let (_, third) = create_unique(&dir, "rec").unwrap();
        assert_eq!(first.file_name().unwrap(), "rec.csv");
        assert_eq!(second.file_name().unwrap(), "rec-2.csv");
        assert_eq!(third.file_name().unwrap(), "rec-3.csv");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_header_patch_rewrites_in_place_and_appends_resume_at_the_end() {
        let dir = temp_dir("patch");
        let (file, path) = create_unique(&dir, "rec").unwrap();
        let mut writer = Writer {
            file: BufWriter::new(file),
            path: path.clone(),
            patchable: 8,
        };
        writer.file.write_all(b"SUM,0000\nrow1\n").unwrap();
        // Same sequence as csv_write_patch.
        let file = &mut writer.file;
        file.flush().unwrap();
        file.get_mut().seek(SeekFrom::Start(4)).unwrap();
        file.get_mut().write_all(b"0002").unwrap();
        file.get_mut().seek(SeekFrom::End(0)).unwrap();
        writer.file.write_all(b"row2\n").unwrap();
        writer.file.flush().unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "SUM,0002\nrow1\nrow2\n"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}

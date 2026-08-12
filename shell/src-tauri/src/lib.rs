// 壳进程职责（docs/decisions/0002）：拉起 core sidecar（node 直起，--parent-pid 交给 core 孤儿守护），
// 从 stdout 解析 {event:"ready",port,token} 供前端 core_info 取用；Tauri updater Day-1 接入（占位端点，失败静默）。
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri_plugin_updater::UpdaterExt;

/// 协议契约版本（core 侧自报，docs/decisions/0007）。壳只认这个版本，不匹配即拒接。
const EXPECTED_PROTOCOL: u64 = 1;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreInfo {
  port: u16,
  token: String,
  work_dir: String,
  version: String,
  commit: String,
  protocol: u64,
}

/// 握手校验（D2）：core ready 行自报的 protocol 必须等于 EXPECTED_PROTOCOL，
/// 否则视为不兼容版本，壳拒绝接线（客户端与引擎脱节的快速失败）。
fn validate_protocol(protocol: Option<u64>) -> Result<(), String> {
  match protocol {
    Some(p) if p == EXPECTED_PROTOCOL => Ok(()),
    Some(p) => Err(format!(
      "core 协议版本不兼容：实际 v{p}，壳期望 v{EXPECTED_PROTOCOL}（见 docs/decisions/0007-协议契约-v1.md）"
    )),
    None => Err("core ready 行缺少 protocol 字段（core 版本过旧？）".to_string()),
  }
}

enum CoreState {
  Starting,
  Ready(CoreInfo),
  Failed(String),
}

type Shared = Arc<Mutex<CoreState>>;

#[tauri::command]
fn core_info(state: tauri::State<'_, Shared>) -> Result<CoreInfo, String> {
  match &*state.inner().lock().map_err(|e| e.to_string())? {
    CoreState::Ready(info) => Ok(info.clone()),
    CoreState::Starting => Err("core sidecar 启动中".to_string()),
    CoreState::Failed(msg) => Err(format!("core sidecar 启动失败: {msg}")),
  }
}

/// 仓库根（shell/src-tauri 的上两级）。用 std::path::absolute 词法归一化，
/// 不用 canonicalize——后者在 Windows 返回 \\?\ 前缀路径，node 解析入口脚本会炸（EISDIR，已实测）。
fn repo_root() -> Result<PathBuf, String> {
  std::path::absolute(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
    .map_err(|e| format!("定位仓库根失败: {e}"))
}

/// 作品目录：NOVEL_WORK_DIR 可覆盖，缺省 <repo>/.demo-work。
fn work_dir() -> Result<PathBuf, String> {
  if let Ok(dir) = std::env::var("NOVEL_WORK_DIR") {
    return std::path::absolute(PathBuf::from(dir)).map_err(|e| format!("NOVEL_WORK_DIR 非法: {e}"));
  }
  Ok(repo_root()?.join(".demo-work"))
}

/// 拉起 core：node --import tsx core/src/main.ts（cwd=仓库根解析依赖），NOVEL_DIR=<作品>/.novel。
fn spawn_core() -> Result<Child, String> {
  let root = repo_root()?;
  let work = work_dir()?;
  let novel_dir = work.join(".novel");
  std::fs::create_dir_all(&novel_dir).map_err(|e| format!("创建 .novel 目录失败: {e}"))?;
  log::info!("[shell] 作品目录: {}", work.display());

  let mut cmd = Command::new("node");
  cmd
    .arg("--import")
    .arg("tsx")
    .arg(root.join("core").join("src").join("main.ts"))
    .arg("--parent-pid")
    .arg(std::process::id().to_string())
    .current_dir(&root)
    .env("NOVEL_DIR", &novel_dir)
    .stdout(Stdio::piped())
    .stderr(Stdio::inherit());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
  }
  let child = cmd
    .spawn()
    .map_err(|e| format!("启动 core 失败（node 需在 PATH）: {e}"))?;
  Ok(child)
}

/// 读 core stdout：首个 {"event":"ready"} 行给出 port+token；EOF 且未就绪视为启动失败。
fn watch_core(child: &mut Child, shared: Shared, work_dir: String) {
  let stdout = child.stdout.take().expect("core stdout 已 pipe");
  std::thread::spawn(move || {
    for line in BufReader::new(stdout).lines() {
      let Ok(line) = line else { break };
      log::info!("[core] {line}");
      if !line.contains("\"event\":\"ready\"") {
        continue;
      }
      match serde_json::from_str::<serde_json::Value>(&line) {
        Ok(v) => {
          let port = v.get("port").and_then(|p| p.as_u64());
          let token = v.get("token").and_then(|t| t.as_str());
          let version = v.get("version").and_then(|t| t.as_str()).unwrap_or("unknown").to_string();
          let commit = v.get("commit").and_then(|t| t.as_str()).unwrap_or("unknown").to_string();
          let protocol = v.get("protocol").and_then(|p| p.as_u64());
          if let (Some(port), Some(token)) = (port, token) {
            if let Err(e) = validate_protocol(protocol) {
              log::error!("[shell] 握手校验失败: {e}");
              if let Ok(mut guard) = shared.lock() {
                *guard = CoreState::Failed(e);
              }
              return;
            }
            let info = CoreInfo {
              port: port as u16,
              token: token.to_string(),
              work_dir: work_dir.clone(),
              version,
              commit,
              protocol: protocol.unwrap_or(0),
            };
            log::info!(
              "[shell] core 就绪于 127.0.0.1:{port}（v{}, commit {}, 协议 v{}）",
              info.version,
              info.commit,
              info.protocol
            );
            if let Ok(mut guard) = shared.lock() {
              *guard = CoreState::Ready(info);
            }
          }
        }
        Err(e) => log::warn!("[shell] 解析 core ready 行失败: {e}"),
      }
    }
    // stdout 关闭（core 退出或管道断裂）
    if let Ok(mut guard) = shared.lock() {
      if matches!(*guard, CoreState::Starting) {
        *guard = CoreState::Failed("core 进程提前退出（检查 LLM_* 环境变量）".to_string());
      }
    }
  });
}

/// Tauri updater Day-1：启动即后台检查；端点是占位，失败只记日志不打扰作者。
fn check_updates(app: &tauri::AppHandle) {
  let handle = app.clone();
  tauri::async_runtime::spawn(async move {
    match handle.updater() {
      Ok(updater) => match updater.check().await {
        Ok(Some(update)) => log::info!("[updater] 发现新版本 {}", update.version),
        Ok(None) => log::info!("[updater] 已是最新"),
        Err(e) => log::warn!("[updater] 检查失败（占位端点，预期内）: {e}"),
      },
      Err(e) => log::warn!("[updater] 初始化失败: {e}"),
    }
  });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let shared: Shared = Arc::new(Mutex::new(CoreState::Starting));
  let shared_for_spawn = Arc::clone(&shared);

  tauri::Builder::default()
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(
      tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .build(),
    )
    .manage(shared)
    .invoke_handler(tauri::generate_handler![core_info])
    .setup(move |app| {
      match spawn_core() {
        Ok(mut child) => {
          let work = work_dir().unwrap_or_default().to_string_lossy().to_string();
          watch_core(&mut child, Arc::clone(&shared_for_spawn), work);
          // Child 不随 drop 被杀；壳退出后由 core 孤儿守护（--parent-pid）收尾
          std::mem::forget(child);
        }
        Err(e) => {
          log::error!("[shell] {e}");
          if let Ok(mut guard) = shared_for_spawn.lock() {
            *guard = CoreState::Failed(e);
          }
        }
      }
      check_updates(app.handle());
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
  use super::*;

  /// 回归：canonicalize 在 Windows 返回 \\?\ 前缀路径，node 解析入口脚本会 EISDIR（已实测炸过一次）。
  #[test]
  fn repo_root_is_plain_absolute_without_extended_prefix() {
    let root = repo_root().expect("repo_root");
    let s = root.to_string_lossy().to_string();
    assert!(!s.starts_with(r"\\?\"), "不得带 \\\\?\\ 前缀: {s}");
    assert!(root.join("core").join("src").join("main.ts").is_file());
  }

  #[test]
  fn default_work_dir_is_demo_work_under_repo() {
    let w = work_dir().expect("work_dir");
    assert!(w.ends_with(".demo-work"), "缺省作品目录应为 <repo>/.demo-work: {w:?}");
  }

  /// 握手校验：协议版本不匹配或缺失必须拒接（快速失败，防新旧壳/core 混接）。
  #[test]
  fn handshake_validates_protocol() {
    assert!(validate_protocol(Some(1)).is_ok(), "期望协议 v1 通过");
    assert!(
      validate_protocol(Some(2)).is_err(),
      "协议 v2 与壳期望不符必须拒绝"
    );
    assert!(validate_protocol(None).is_err(), "缺 protocol 字段必须拒绝");
  }
}

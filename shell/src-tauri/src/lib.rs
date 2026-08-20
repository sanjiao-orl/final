// 壳进程职责（docs/decisions/0002）：拉起 core sidecar（node 直起，--parent-pid 交给 core 孤儿守护），
// 从 stdout 解析 {event:"ready",port,token} 供前端 core_info 取用；Tauri updater 真实端点（GitHub Releases latest.json）。
// 应用配置持久化（第二步）：config.json（app_config_dir）存作品目录 + LLM 双档模型，字段可空=回落环境变量/缺省；
// 设置面板经 read_config/write_config/config_status 读写，restart_core 杀旧起新让配置立即生效。
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

/// 协议契约版本（core 侧自报，docs/decisions/0007）。壳只认这个版本，不匹配即拒接。
const EXPECTED_PROTOCOL: u64 = 2;

/// 应用配置文件（app_config_dir 下）。字段可空：空=回落环境变量/缺省。
const CONFIG_FILE: &str = "config.json";

/// apiKey 脱敏占位串：read_config/config_status 回传前端前把非空 key 替换为该串；
/// write_config 侧收到占位串或空串时保留磁盘原值（「占位即保留」）。
const API_KEY_MASK: &str = "********";

// ---------- 应用配置（serde JSON，字段可空=回落环境变量） ----------

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
  /// 作品目录；空=缺省（dev 仓库 .demo-work / prod app_data_dir/.demo-work）。
  work_dir: Option<String>,
  /// 作品注册表：作品目录绝对路径列表（顶栏作品菜单展示与切换用）。
  works: Option<Vec<String>>,
  llm: Option<LlmConfig>,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmConfig {
  base_url: Option<String>,
  api_key: Option<String>,
  model: Option<String>,
  model_cheap: Option<String>,
  presets: Option<Vec<LlmPreset>>,
  assign: Option<LlmAssign>,
}

/// 单个模型预设（D4）：id 为稳定身份，其余字段可空=不注入环境变量。
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmPreset {
  id: String,
  name: Option<String>,
  base_url: Option<String>,
  api_key: Option<String>,
  model: Option<String>,
}

/// 用途→预设 id 分配（D4）：未分配用途回落第一预设（core 侧规则）。
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmAssign {
  writing: Option<String>,
  background: Option<String>,
  review: Option<String>,
}

/// 单字段当前生效值与来源（config/env/default），设置面板占位符展示用。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedField {
  value: String,
  source: String,
}

/// config_status 返回值：已存配置 + 各字段生效值/来源（apiKey 打码）。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigStatus {
  config: AppConfig,
  work_dir: ResolvedField,
  base_url: ResolvedField,
  api_key: ResolvedField,
  model: ResolvedField,
  model_cheap: ResolvedField,
}

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

/// core 子进程句柄 + 换代计数：restart_core 杀旧起新；watcher 按代判断归属，防旧管道 EOF 误报失败。
struct CoreProcess {
  child: Mutex<Option<Child>>,
  generation: Arc<AtomicU64>,
}

#[tauri::command]
fn core_info(state: tauri::State<'_, Shared>) -> Result<CoreInfo, String> {
  match &*state.inner().lock().map_err(|e| e.to_string())? {
    CoreState::Ready(info) => Ok(info.clone()),
    CoreState::Starting => Err("core sidecar 启动中".to_string()),
    CoreState::Failed(msg) => Err(format!("core sidecar 启动失败: {msg}")),
  }
}

// ---------- 配置读写（app_config_dir/config.json；写=tmp+rename 原子替换） ----------

fn config_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  let dir = plain_path(
    &app
      .path()
      .app_config_dir()
      .map_err(|e| format!("定位应用配置目录失败: {e}"))?,
  );
  Ok(dir.join(CONFIG_FILE))
}

fn read_config_at(file: &Path) -> Result<AppConfig, String> {
  if !file.is_file() {
    return Ok(AppConfig::default());
  }
  let raw = std::fs::read_to_string(file).map_err(|e| format!("读取配置文件失败: {e}"))?;
  serde_json::from_str(&raw).map_err(|e| format!("配置文件格式非法: {e}"))
}

/// 原子写配置：先写同目录 .tmp 再 rename 覆盖，避免写一半断电/崩溃留下半截 JSON。
fn write_config_at(file: &Path, cfg: &AppConfig) -> Result<(), String> {
  if let Some(dir) = file.parent() {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
  }
  let raw = serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化配置失败: {e}"))?;
  let tmp = file.with_extension("json.tmp");
  std::fs::write(&tmp, raw).map_err(|e| format!("写入配置失败: {e}"))?;
  std::fs::rename(&tmp, file).map_err(|e| format!("替换配置失败: {e}"))?;
  Ok(())
}

/// apiKey 脱敏：回传前端前把非空 apiKey 替换为占位串（llm.api_key 与每个 preset.api_key），
/// 空/缺值保持原样（无 key 可脱敏）。返回克隆，不改原配置——core 启动注入环境变量仍用明文。
fn mask_api_keys(cfg: &AppConfig) -> AppConfig {
  let mut out = cfg.clone();
  if let Some(llm) = out.llm.as_mut() {
    if llm.api_key.as_deref().is_some_and(|s| !s.trim().is_empty()) {
      llm.api_key = Some(API_KEY_MASK.to_string());
    }
    if let Some(presets) = llm.presets.as_mut() {
      for preset in presets {
        if preset.api_key.as_deref().is_some_and(|s| !s.trim().is_empty()) {
          preset.api_key = Some(API_KEY_MASK.to_string());
        }
      }
    }
  }
  out
}

/// write_config「占位即保留」：前端拿到的是脱敏配置（apiKey=占位串），用户不改动直接保存时
/// 会原样回传占位串/空串；此时用磁盘上的原值顶回，避免把真实 key 覆盖成占位符。
/// 按 preset id 对齐磁盘上的旧预设；磁盘没有的新预设按传入值照写。非 key 字段一律照写。
fn merge_api_key_placeholders(incoming: &mut AppConfig, disk: &AppConfig) {
  let keep = |v: &mut Option<String>, saved: &Option<String>| {
    if v.as_deref().is_some_and(|s| s.trim().is_empty() || s == API_KEY_MASK) {
      *v = saved.clone();
    }
  };
  let Some(in_llm) = incoming.llm.as_mut() else { return };
  let Some(disk_llm) = disk.llm.as_ref() else { return };
  keep(&mut in_llm.api_key, &disk_llm.api_key);
  if let (Some(in_presets), Some(disk_presets)) = (in_llm.presets.as_mut(), disk_llm.presets.as_ref()) {
    for in_p in in_presets {
      if let Some(disk_p) = disk_presets.iter().find(|p| p.id == in_p.id) {
        keep(&mut in_p.api_key, &disk_p.api_key);
      }
    }
  }
}

#[tauri::command]
fn read_config(app: tauri::AppHandle) -> Result<AppConfig, String> {
  let cfg = read_config_at(&config_file(&app)?)?;
  Ok(mask_api_keys(&cfg))
}

#[tauri::command]
fn write_config(app: tauri::AppHandle, config: AppConfig) -> Result<(), String> {
  let file = config_file(&app)?;
  let mut incoming = config;
  // 磁盘配置损坏（非法 JSON）时按无旧值继续写：保留「保存新配置覆盖坏文件」的自愈能力；
  // 此时占位串/空串在 merge 中落为 None（不会把占位串当真 key 落盘），用户重填 key 即可。
  let disk = read_config_at(&file).unwrap_or_else(|e| {
    log::warn!("[shell] 读取旧配置失败，按无旧值写入: {e}");
    AppConfig::default()
  });
  merge_api_key_placeholders(&mut incoming, &disk);
  write_config_at(&file, &incoming)
}

// ---------- 作者笔记（作者私人笔记，AI 物理不可见） ----------
// 约束：读写只走本壳 Tauri 命令（read_note / write_note），绝不经 core/domain MCP 工具集；
// 文件落 <workDir>/.novel/notes/ 下。路径必须相对、无 .. / . 段、不以 / \ 或盘符开头、
// 以 .md 结尾，拼接 canonical 目标后仍须位于笔记根内（防目录穿越 / symlink 逃逸）。

/// 笔记根目录：<workDir>/.novel/notes/（作品目录解析复用 resolve_work_dir）。
fn notes_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  let cfg = read_config_at(&config_file(app)?)?;
  Ok(resolve_work_dir(app, &cfg)?.join(".novel").join("notes"))
}

/// 纯函数（可单测）：校验 rel_path 相对安全——非空、以 .md 结尾、不以 / \ 或盘符开头、
/// 不含 .. 或 . 路径段。返回可安全 join 的 rel_path；非法返回带原因的 Err。
fn sanitize_note_rel_path(rel_path: &str) -> Result<&str, String> {
  if rel_path.is_empty() {
    return Err("笔记路径非法：为空".to_string());
  }
  if !rel_path.ends_with(".md") {
    return Err(format!("笔记路径非法：{rel_path}（必须以 .md 结尾）"));
  }
  let first = rel_path.as_bytes()[0];
  if first == b'/' || first == b'\\' {
    return Err(format!("笔记路径非法：{rel_path}（不能以 / 或 \\ 开头）"));
  }
  let bytes = rel_path.as_bytes();
  if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
    return Err(format!("笔记路径非法：{rel_path}（不能是盘符绝对路径）"));
  }
  for seg in rel_path.split(|c| c == '/' || c == '\\') {
    if seg == ".." || seg == "." {
      return Err(format!("笔记路径非法：{rel_path}（不能包含 {seg} 路径段）"));
    }
  }
  Ok(rel_path)
}

/// 拼接笔记目标路径并做 canonical 包含校验：目标必须仍位于笔记根内。
/// 文件/目录可能尚不存在（读缺文件、写新子目录），对最近存在的祖先 canonicalize 后
/// 拼回剩余后缀，防 .. 残留与 symlink 逃逸（canonicalize 会解析符号链接到真实路径）。
fn note_target(root: &Path, rel_path: &str) -> Result<PathBuf, String> {
  let rel = sanitize_note_rel_path(rel_path)?;
  let candidate = root.join(rel);
  let root_canon = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());

  let mut missing: Vec<std::ffi::OsString> = Vec::new();
  let mut cur = candidate.as_path();
  let canon = loop {
    if let Ok(c) = std::fs::canonicalize(cur) {
      let mut out = c;
      for seg in missing.iter().rev() {
        out.push(seg);
      }
      break out;
    }
    match (cur.parent(), cur.file_name()) {
      (Some(p), Some(name)) => {
        missing.push(name.to_os_string());
        cur = p;
      }
      // 整条链都不存在：词法已滤掉 ..，按 root + rel 归位
      _ => break root_canon.join(rel),
    }
  };

  if !canon.starts_with(&root_canon) {
    return Err(format!("笔记路径非法：{rel_path}（超出 .novel/notes/ 范围）"));
  }
  Ok(canon)
}

/// 读笔记：缺文件返回空串（作者笔记从空白起步）。
fn read_note_at(root: &Path, rel_path: &str) -> Result<String, String> {
  let target = note_target(root, rel_path)?;
  if !target.is_file() {
    return Ok(String::new());
  }
  std::fs::read_to_string(&target).map_err(|e| format!("读取笔记失败: {e}"))
}

/// 原子写笔记：先写同目录 .tmp 再 rename 覆盖（仿 write_config_at），需要时 create_dir_all。
fn write_note_at(root: &Path, rel_path: &str, content: &str) -> Result<(), String> {
  let target = note_target(root, rel_path)?;
  if let Some(dir) = target.parent() {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建笔记目录失败: {e}"))?;
  }
  let tmp = target.with_extension("md.tmp");
  std::fs::write(&tmp, content).map_err(|e| format!("写入笔记失败: {e}"))?;
  std::fs::rename(&tmp, &target).map_err(|e| format!("替换笔记失败: {e}"))?;
  Ok(())
}

#[tauri::command]
fn read_note(app: tauri::AppHandle, rel_path: String) -> Result<String, String> {
  read_note_at(&notes_root(&app)?, &rel_path)
}

#[tauri::command]
fn write_note(app: tauri::AppHandle, rel_path: String, content: String) -> Result<(), String> {
  write_note_at(&notes_root(&app)?, &rel_path, &content)
}

/// 纯函数：在 parent 下新建作品目录（parent/<name>/manuscript）。
/// .novel 目录由 spawn_core 按需创建，这里不建。
fn create_work_dir(parent: &Path, name: &str) -> Result<PathBuf, String> {
  let name = name.trim();
  if name.is_empty() {
    return Err("作品名非法：名称不能为空".to_string());
  }
  if name.chars().any(|c| matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')) {
    return Err(format!("作品名非法：{name}（不能包含 \\ / : * ? \" < > |）"));
  }
  let target = parent.join(name);
  if target.exists() {
    // 已存在时只容忍空目录（用户复用自己建好的空文件夹）；非空目录直接拒，避免误入旧作品。
    match std::fs::read_dir(&target) {
      Ok(mut entries) => {
        if entries.next().is_some() {
          return Err("目标目录已存在且非空".to_string());
        }
      }
      Err(_) => return Err("目标路径已存在且不是目录".to_string()),
    }
  }
  std::fs::create_dir_all(target.join("manuscript"))
    .map_err(|e| format!("创建作品目录失败: {e}"))?;
  let abs = std::path::absolute(&target).map_err(|e| format!("作品目录路径非法: {e}"))?;
  Ok(plain_path(&abs))
}

/// 新建作品：在 parentDir 下创建 <name>/manuscript，返回归一化后的作品目录绝对路径。
#[tauri::command]
fn create_work(parent_dir: String, name: String) -> Result<String, String> {
  let dir = create_work_dir(Path::new(&parent_dir), &name)?;
  Ok(dir.to_string_lossy().to_string())
}

/// 单字段生效值解析：配置 > 环境变量 > 缺省（空）；source 供面板标注来源。
fn resolve_field(cfg_value: Option<&str>, env_key: &str) -> ResolvedField {
  if let Some(v) = cfg_value.filter(|s| !s.trim().is_empty()) {
    return ResolvedField { value: v.to_string(), source: "config".into() };
  }
  if let Ok(v) = std::env::var(env_key) {
    if !v.is_empty() {
      return ResolvedField { value: v, source: "env".into() };
    }
  }
  ResolvedField { value: String::new(), source: "default".into() }
}

/// apiKey 打码：占位符只回显前 4 位，不把整把 key 摊在面板上。
fn resolve_field_masked(cfg_value: Option<&str>, env_key: &str) -> ResolvedField {
  let f = resolve_field(cfg_value, env_key);
  if f.value.is_empty() {
    return f;
  }
  let head: String = f.value.chars().take(4).collect();
  ResolvedField { value: format!("{head}••••"), source: f.source }
}

/// 设置面板一次拿全：已存配置 + 各字段生效值/来源（apiKey 打码）。
#[tauri::command]
fn config_status(app: tauri::AppHandle) -> Result<ConfigStatus, String> {
  let cfg = read_config_at(&config_file(&app)?)?;
  let work = resolve_work_dir(&app, &cfg)?;
  let work_source = if cfg.work_dir.as_deref().is_some_and(|s| !s.trim().is_empty()) {
    "config"
  } else if std::env::var_os("NOVEL_WORK_DIR").is_some_and(|v| !v.is_empty()) {
    "env"
  } else {
    "default"
  };
  let llm = cfg.llm.clone().unwrap_or_default();
  Ok(ConfigStatus {
    config: mask_api_keys(&cfg),
    work_dir: ResolvedField {
      value: work.to_string_lossy().to_string(),
      source: work_source.into(),
    },
    base_url: resolve_field(llm.base_url.as_deref(), "LLM_BASE_URL"),
    api_key: resolve_field_masked(llm.api_key.as_deref(), "LLM_API_KEY"),
    model: resolve_field(llm.model.as_deref(), "LLM_MODEL"),
    model_cheap: resolve_field(llm.model_cheap.as_deref(), "LLM_MODEL_CHEAP"),
  })
}

/// 仓库根（shell/src-tauri 的上两级）。用 std::path::absolute 词法归一化，
/// 不用 canonicalize——后者在 Windows 返回 \\?\ 前缀路径，node 解析入口脚本会炸（EISDIR，已实测）。
fn repo_root() -> Result<PathBuf, String> {
  std::path::absolute(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
    .map_err(|e| format!("定位仓库根失败: {e}"))
}

/// Tauri 在 Windows 上给的 resource_dir 可能是 \\?\ 前缀的 verbatim 路径，
/// Node 解析入口脚本会 EISDIR（已实测）；这里剥成普通绝对路径。
fn plain_path(path: &Path) -> PathBuf {
  let s = path.to_string_lossy();
  match s.strip_prefix(r"\\?\") {
    Some(stripped) => PathBuf::from(stripped),
    None => path.to_path_buf(),
  }
}

/// dev 缺省作品目录：<repo>/.demo-work（prod 用 app_data_dir，见 default_work_dir）。
fn repo_default_work_dir() -> Result<PathBuf, String> {
  Ok(repo_root()?.join(".demo-work"))
}

/// 无配置无环境变量时的缺省作品目录：dev 仓库 .demo-work；prod 应用数据目录 .demo-work。
fn default_work_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  if cfg!(debug_assertions) {
    return repo_default_work_dir();
  }
  let data_dir = plain_path(
    &app
      .path()
      .app_data_dir()
      .map_err(|e| format!("定位应用数据目录失败: {e}"))?,
  );
  Ok(data_dir.join(".demo-work"))
}

/// 作品目录优先级：配置 workDir > NOVEL_WORK_DIR 环境变量 > 缺省（纯函数，便于单测）。
fn pick_work_dir(cfg_work: Option<&str>, env_work: Option<&str>, default: &Path) -> Result<PathBuf, String> {
  if let Some(d) = cfg_work.filter(|s| !s.trim().is_empty()) {
    return std::path::absolute(PathBuf::from(d)).map_err(|e| format!("配置 workDir 非法: {e}"));
  }
  if let Some(d) = env_work.filter(|s| !s.trim().is_empty()) {
    return std::path::absolute(PathBuf::from(d)).map_err(|e| format!("NOVEL_WORK_DIR 非法: {e}"));
  }
  Ok(default.to_path_buf())
}

fn resolve_work_dir(app: &tauri::AppHandle, cfg: &AppConfig) -> Result<PathBuf, String> {
  pick_work_dir(
    cfg.work_dir.as_deref(),
    std::env::var("NOVEL_WORK_DIR").ok().as_deref(),
    &default_work_dir(app)?,
  )
}

/// 计算 core 启动所需的 work 目录与（生产模式下的）资源目录。
/// dev 保持现状（仓库 .demo-work，无资源目录）；prod 用 Tauri 应用数据目录做作品根，资源目录指向安装包 resources。
fn resolve_startup_paths(app: &tauri::AppHandle, cfg: &AppConfig) -> Result<(PathBuf, Option<PathBuf>), String> {
  let work = resolve_work_dir(app, cfg)?;
  if cfg!(debug_assertions) {
    return Ok((work, None));
  }
  let resource_dir = plain_path(
    &app
      .path()
      .resource_dir()
      .map_err(|e| format!("定位资源目录失败: {e}"))?,
  );
  Ok((work, Some(resource_dir)))
}

/// 预设 id 归一化（与 core 侧规则一致）：大写，非字母数字→下划线。
fn normalize_preset_id(raw: &str) -> String {
  raw
    .to_uppercase()
    .chars()
    .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
    .collect()
}

/// 配置里的 LLM 字段转成 core 子进程环境变量覆盖：仅非空值（空=继承壳进程环境变量，即"环境变量档"）。
/// legacy 四字段照旧注入；presets 非空时追加 LLM_PRESET_<ID>_* 与 LLM_ASSIGN_<PURPOSE>（只注非空）。
fn llm_env_overrides(cfg: &AppConfig) -> Vec<(String, String)> {
  let Some(llm) = &cfg.llm else {
    return Vec::new();
  };
  let mut out: Vec<(String, String)> = Vec::new();
  if let Some(v) = llm.base_url.as_deref().filter(|s| !s.trim().is_empty()) {
    out.push(("LLM_BASE_URL".to_string(), v.to_string()));
  }
  if let Some(v) = llm.api_key.as_deref().filter(|s| !s.trim().is_empty()) {
    out.push(("LLM_API_KEY".to_string(), v.to_string()));
  }
  if let Some(v) = llm.model.as_deref().filter(|s| !s.trim().is_empty()) {
    out.push(("LLM_MODEL".to_string(), v.to_string()));
  }
  if let Some(v) = llm.model_cheap.as_deref().filter(|s| !s.trim().is_empty()) {
    out.push(("LLM_MODEL_CHEAP".to_string(), v.to_string()));
  }

  if let Some(presets) = &llm.presets {
    for preset in presets.iter().filter(|p| !p.id.trim().is_empty()) {
      let id = normalize_preset_id(preset.id.trim());
      if let Some(v) = preset.base_url.as_deref().filter(|s| !s.trim().is_empty()) {
        out.push((format!("LLM_PRESET_{id}_BASE_URL"), v.to_string()));
      }
      if let Some(v) = preset.api_key.as_deref().filter(|s| !s.trim().is_empty()) {
        out.push((format!("LLM_PRESET_{id}_API_KEY"), v.to_string()));
      }
      if let Some(v) = preset.model.as_deref().filter(|s| !s.trim().is_empty()) {
        out.push((format!("LLM_PRESET_{id}_MODEL"), v.to_string()));
      }
    }
  }

  if let Some(assign) = &llm.assign {
    for (purpose, id) in [
      ("WRITING", assign.writing.as_deref()),
      ("BACKGROUND", assign.background.as_deref()),
      ("REVIEW", assign.review.as_deref()),
    ] {
      if let Some(v) = id.filter(|s| !s.trim().is_empty()) {
        out.push((format!("LLM_ASSIGN_{purpose}"), v.to_string()));
      }
    }
  }

  out
}

/// 拉起 core。
/// dev（debug build）保持现状：node --import tsx core/src/main.ts，cwd=仓库根解析依赖。
/// prod（release build）：从 Tauri resource_dir 找 node.exe + core/domain 编译产物，
/// 并通过 MCP_DOMAIN_CMD 让 core 拉起资源目录里的 domain bundle；CORE_RUNTIME_FILE 落到作品目录。
/// 环境变量组装遵循 配置 > 环境变量 > 默认：作品目录已由 resolve_work_dir 落定（NOVEL_WORK_DIR 透传子进程），
/// LLM_* 仅在配置非空时覆盖。
fn spawn_core(resource_dir: Option<PathBuf>, work: &Path, prompt_dir: &Path, cfg: &AppConfig) -> Result<Child, String> {
  let novel_dir = work.join(".novel");
  std::fs::create_dir_all(&novel_dir).map_err(|e| format!("创建 .novel 目录失败: {e}"))?;
  log::info!("[shell] 作品目录: {}", work.display());

  let mut cmd;
  if let Some(resources) = resource_dir {
    let node_exe = resources.join("sidecar").join("node.exe");
    let core_js = resources.join("sidecar").join("core").join("main.mjs");
    let domain_js = resources.join("sidecar").join("domain").join("server.mjs");
    for (file, label) in [
      (&node_exe, "node 运行时"),
      (&core_js, "core 编译产物"),
      (&domain_js, "domain 编译产物"),
    ] {
      if !file.is_file() {
        return Err(format!("安装包资源缺失{label}: {}", file.display()));
      }
    }

    log::info!(
      "[shell] prod sidecar: node={} core={} domain={}",
      node_exe.display(),
      core_js.display(),
      domain_js.display()
    );
    cmd = Command::new(&node_exe);
    cmd
      .arg(&core_js)
      .arg("--parent-pid")
      .arg(std::process::id().to_string())
      .current_dir(&resources)
      .env("NOVEL_DIR", &novel_dir)
      .env("CORE_RUNTIME_FILE", novel_dir.join("core-runtime.local.json"))
      .env("NOVEL_PROMPT_DIR", prompt_dir)
      .env(
        "MCP_DOMAIN_CMD",
        format!("\"{}\" \"{}\"", node_exe.display(), domain_js.display()),
      );
  } else {
    let root = repo_root()?;
    cmd = Command::new("node");
    cmd
      .arg("--import")
      .arg("tsx")
      .arg(root.join("core").join("src").join("main.ts"))
      .arg("--parent-pid")
      .arg(std::process::id().to_string())
      .current_dir(&root)
      .env("NOVEL_DIR", &novel_dir);
  }

  // 配置 > 环境变量 > 默认 的优先级已由 resolve_work_dir 落定；NOVEL_WORK_DIR 透传子进程，
  // LLM_* 仅配置非空时覆盖（空=继承壳进程环境变量）。
  cmd.env("NOVEL_WORK_DIR", work);
  for (key, value) in llm_env_overrides(cfg) {
    cmd.env(key, value);
  }

  cmd.stdout(Stdio::piped()).stderr(Stdio::inherit());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
  }
  let child = cmd
    .spawn()
    .map_err(|e| format!("启动 core 失败: {e}"))?;
  Ok(child)
}

/// 读 core stdout：首个 {"event":"ready"} 行给出 port+token；EOF 且未就绪视为启动失败。
/// generation 换代防串台：restart_core 后旧 watcher 的 EOF/ready 不再写状态（归新 watcher 管）。
fn watch_core(child: &mut Child, shared: Shared, generation: Arc<AtomicU64>, work_dir: String) {
  let stdout = child.stdout.take().expect("core stdout 已 pipe");
  let my_gen = generation.load(Ordering::SeqCst);
  std::thread::spawn(move || {
    for line in BufReader::new(stdout).lines() {
      let Ok(line) = line else { break };
      // ready 行含明文 token：不打原始日志，解析后只打脱敏摘要；其余行照常
      if !line.contains("\"event\":\"ready\"") {
        log::info!("[core] {line}");
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
            log::info!("[core] ready port={port} token=***");
            if let Err(e) = validate_protocol(protocol) {
              log::error!("[shell] 握手校验失败: {e}");
              if generation.load(Ordering::SeqCst) == my_gen {
                if let Ok(mut guard) = shared.lock() {
                  *guard = CoreState::Failed(e);
                }
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
            if generation.load(Ordering::SeqCst) == my_gen {
              if let Ok(mut guard) = shared.lock() {
                *guard = CoreState::Ready(info);
              }
            }
          } else {
            log::warn!("[core] ready 行缺 port/token，不打原始日志");
          }
        }
        Err(e) => log::warn!("[shell] 解析 core ready 行失败: {e}"),
      }
    }
    // stdout 关闭（core 退出或管道断裂）：仅当仍是当前代且未就绪时置失败（重启换代防旧 watcher 误报）
    if generation.load(Ordering::SeqCst) == my_gen {
      if let Ok(mut guard) = shared.lock() {
        if matches!(*guard, CoreState::Starting) {
          *guard = CoreState::Failed("core 进程提前退出（检查 LLM_* 环境变量）".to_string());
        }
      }
    }
  });
}

/// 读配置 → 解析作品目录/资源目录 → spawn core → watch → 收句柄。setup 与 restart_core 共用。
fn spawn_and_watch(app: &tauri::AppHandle, core: &CoreProcess, shared: &Shared) -> Result<(), String> {
  let outcome = (|| -> Result<(Child, PathBuf), String> {
    let cfg = read_config_at(&config_file(app)?)?;
    let (work, resource_dir) = resolve_startup_paths(app, &cfg)?;
    let prompt_dir = plain_path(
      &app
        .path()
        .app_config_dir()
        .map_err(|e| format!("定位应用配置目录失败: {e}"))?,
    )
    .join("prompts");
    Ok((spawn_core(resource_dir, &work, &prompt_dir, &cfg)?, work))
  })();
  match outcome {
    Ok((mut child, work)) => {
      let gen = Arc::clone(&core.generation);
      watch_core(&mut child, Arc::clone(shared), gen, work.to_string_lossy().to_string());
      // Child 不随 drop 被杀；壳退出后由 core 孤儿守护（--parent-pid）收尾
      *core.child.lock().map_err(|e| e.to_string())? = Some(child);
      Ok(())
    }
    Err(e) => {
      log::error!("[shell] {e}");
      if let Ok(mut guard) = shared.lock() {
        *guard = CoreState::Failed(e.clone());
      }
      Err(e)
    }
  }
}

/// 让配置（作品目录 / LLM_*）立即生效：杀掉当前 core 子进程并按最新配置重新拉起。
/// 模型/作品目录是 core 启动时读的，只能整进程重启；前端随后重连（core_info 轮询新 port/token/workDir）。
#[tauri::command]
fn restart_core(
  app: tauri::AppHandle,
  state: tauri::State<'_, Shared>,
  core: tauri::State<'_, Arc<CoreProcess>>,
) -> Result<(), String> {
  {
    let mut child_guard = core.child.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = child_guard.take() {
      let _ = child.kill();
      let _ = child.wait();
    }
  }
  core.generation.fetch_add(1, Ordering::SeqCst); // 旧 stdout watcher 作废，防旧管道 EOF 误报失败
  if let Ok(mut guard) = state.lock() {
    *guard = CoreState::Starting;
  }
  spawn_and_watch(&app, &core, state.inner())
}

/// Tauri updater 启动后台检查：真实端点（GitHub Releases latest.json）；
/// 发现新版本后下载校验；**安装前先杀 core sidecar 并等其退出**——Windows 不允许覆盖运行中的 exe，
/// 否则 NSIS 写 sidecar\node.exe 会弹「文件被占用」;随后由安装器接管/重启。安装失败则重启 core 恢复。
fn check_updates(app: &tauri::AppHandle) {
  let handle = app.clone();
  tauri::async_runtime::spawn(async move {
    let updater = match handle.updater() {
      Ok(updater) => updater,
      Err(e) => {
        log::warn!("[updater] 初始化失败: {e}");
        return;
      }
    };
    let update = match updater.check().await {
      Ok(Some(update)) => update,
      Ok(None) => {
        log::info!("[updater] 已是最新");
        return;
      }
      Err(e) => {
        log::warn!("[updater] 检查失败: {e}");
        return;
      }
    };

    log::info!(
      "[updater] 发现新版本 v{}（当前 v{}）",
      update.version,
      update.current_version
    );
    log::info!("[updater] 开始下载 {}", update.download_url);

    let downloaded = Arc::new(AtomicU64::new(0));
    let downloaded_for_log = Arc::clone(&downloaded);
    let bytes = match update
      .download(
        move |chunk, total| {
          let n = downloaded_for_log.fetch_add(chunk as u64, Ordering::SeqCst) + chunk as u64;
          // 每跨过约 8 MiB 记一次进度，避免刷屏
          if n % (8 * 1024 * 1024) < chunk as u64 {
            match total {
              Some(total) => log::info!(
                "[updater] 下载进度 {}%（{} / {} 字节）",
                n * 100 / total,
                n,
                total
              ),
              None => log::info!("[updater] 已下载 {n} 字节"),
            }
          }
        },
        || log::info!("[updater] 下载完成"),
      )
      .await
    {
      Ok(bytes) => bytes,
      Err(e) => {
        log::error!("[updater] 下载失败: {e}");
        return;
      }
    };

    // 杀 sidecar 并等其退出(口径同 restart_core),再换代作废旧 stdout watcher 防 EOF 误报。
    let core = handle.state::<Arc<CoreProcess>>().inner().clone();
    {
      if let Ok(mut child_guard) = core.child.lock() {
        if let Some(mut child) = child_guard.take() {
          let _ = child.kill();
          let _ = child.wait();
        }
      }
      core.generation.fetch_add(1, Ordering::SeqCst);
    }
    log::info!("[updater] core sidecar 已停止，启动安装器（passive）");

    match update.install(&bytes) {
      Ok(()) => log::info!("[updater] 安装器已启动，等待安装完成并重启"),
      Err(e) => {
        log::error!("[updater] 安装失败: {e}；重启 core 恢复运行");
        let shared = handle.state::<Shared>().inner().clone();
        if let Ok(mut guard) = shared.lock() {
          *guard = CoreState::Starting;
        }
        if let Err(e2) = spawn_and_watch(&handle, &core, &shared) {
          log::error!("[updater] 安装失败后重启 core 失败: {e2}");
        }
      }
    }
  });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let shared: Shared = Arc::new(Mutex::new(CoreState::Starting));
  let shared_for_spawn = Arc::clone(&shared);
  let core_process = Arc::new(CoreProcess {
    child: Mutex::new(None),
    generation: Arc::new(AtomicU64::new(0)),
  });

  tauri::Builder::default()
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_dialog::init())
    .plugin(
      tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .build(),
    )
    .manage(shared)
    .manage(Arc::clone(&core_process))
    .invoke_handler(tauri::generate_handler![
      core_info,
      read_config,
      write_config,
      create_work,
      config_status,
      restart_core,
      read_note,
      write_note
    ])
    .setup(move |app| {
      let handle = app.handle().clone();
      // 失败已在 spawn_and_watch 内记日志并置 CoreState::Failed
      let _ = spawn_and_watch(&handle, &core_process, &shared_for_spawn);
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
    let w = repo_default_work_dir().expect("repo_default_work_dir");
    assert!(w.ends_with(".demo-work"), "缺省作品目录应为 <repo>/.demo-work: {w:?}");
  }

  /// 握手校验：协议版本不匹配或缺失必须拒接（快速失败，防新旧壳/core 混接）。
  #[test]
  fn handshake_validates_protocol() {
    assert!(validate_protocol(Some(2)).is_ok(), "期望协议 v2 通过（决策 0010）");
    assert!(
      validate_protocol(Some(3)).is_err(),
      "协议 v3 与壳期望不符必须拒绝"
    );
    assert!(validate_protocol(None).is_err(), "缺 protocol 字段必须拒绝");
  }

  /// 作品目录优先级：配置 > 环境变量 > 缺省；空白配置视为未设置。
  #[test]
  fn work_dir_priority_config_over_env_over_default() {
    let default = PathBuf::from("C:/default-work");
    let cfg = Some("C:/cfg-work");
    let env = Some("C:/env-work");
    assert_eq!(
      pick_work_dir(cfg, env, &default).expect("cfg"),
      std::path::absolute("C:/cfg-work").expect("abs")
    );
    assert_eq!(
      pick_work_dir(None, env, &default).expect("env"),
      std::path::absolute("C:/env-work").expect("abs")
    );
    assert_eq!(pick_work_dir(None, None, &default).expect("default"), default);
    // 空白配置=未设置，回落环境变量
    assert_eq!(
      pick_work_dir(Some("   "), env, &default).expect("blank-cfg"),
      std::path::absolute("C:/env-work").expect("abs")
    );
  }

  /// 单测临时目录：进程 id + 时间戳拼后缀，避免并行/残留冲突。
  fn temp_test_dir(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .expect("系统时间")
      .as_nanos();
    std::env::temp_dir().join(format!("novel-ws-{tag}-{}-{nanos}", std::process::id()))
  }

  /// 作品名非法字符逐个拒；空名/纯空白拒。
  #[test]
  fn create_work_dir_rejects_invalid_names() {
    let parent = temp_test_dir("creatework-invalid");
    std::fs::create_dir_all(&parent).expect("create parent");
    for ch in ['\\', '/', ':', '*', '?', '"', '<', '>', '|'] {
      let name = format!("a{ch}b");
      let err = create_work_dir(&parent, &name).expect_err(&format!("name {name:?} 应拒"));
      assert!(err.contains("作品名非法"), "错误应为作品名非法: {err}");
    }
    assert!(create_work_dir(&parent, "   ").is_err(), "纯空白名称应拒");
    let _ = std::fs::remove_dir_all(&parent);
  }

  /// 目标目录已存在且非空时拒绝。
  #[test]
  fn create_work_dir_rejects_existing_non_empty_dir() {
    let parent = temp_test_dir("creatework-exists");
    let target = parent.join("旧书");
    std::fs::create_dir_all(&target).expect("create target");
    std::fs::write(target.join("a.md"), "x").expect("write file");
    let err = create_work_dir(&parent, "旧书").expect_err("非空目录应拒");
    assert!(err.contains("目标目录已存在且非空"), "错误应为目录非空: {err}");
    let _ = std::fs::remove_dir_all(&parent);
  }

  /// 正例：建出 manuscript/，返回 plain 绝对路径（不带 Windows verbatim 前缀）。
  #[test]
  fn create_work_dir_creates_manuscript_and_returns_plain_abs_path() {
    let parent = temp_test_dir("creatework-ok");
    std::fs::create_dir_all(&parent).expect("create parent");
    let dir = create_work_dir(&parent, "新书").expect("create work dir");
    assert!(dir.is_absolute(), "返回路径应为绝对路径: {dir:?}");
    assert!(
      !dir.to_string_lossy().starts_with(r"\\?\"),
      "不得带 \\\\?\\ 前缀: {}",
      dir.display()
    );
    assert!(dir.join("manuscript").is_dir(), "应建出 manuscript/ 子目录");
    assert_eq!(dir, std::path::absolute(parent.join("新书")).expect("abs"));
    let _ = std::fs::remove_dir_all(&parent);
  }

  /// 配置读写：缺文件返回默认；roundtrip；原子写后 tmp 不残留。
  #[test]
  fn config_write_read_roundtrip() {
    let dir = std::env::temp_dir().join(format!("novel-ws-config-test-{}", std::process::id()));
    let file = dir.join("config.json");
    let _ = std::fs::remove_dir_all(&dir);

    let missing = read_config_at(&file).expect("read missing");
    assert!(
      missing.work_dir.is_none() && missing.llm.is_none() && missing.works.is_none(),
      "缺文件应返回全空配置"
    );

    let cfg = AppConfig {
      work_dir: Some("C:/works/新书".to_string()),
      works: Some(vec!["C:/works/新书".to_string(), "C:/works/旧书".to_string()]),
      llm: Some(LlmConfig {
        base_url: Some("https://llm.example/v1".to_string()),
        api_key: Some("sk-test-123".to_string()),
        model: Some("m1".to_string()),
        model_cheap: Some("m2".to_string()),
        presets: Some(vec![LlmPreset {
          id: "main-writer".to_string(),
          name: Some("主笔".to_string()),
          base_url: Some("https://w.example/v1".to_string()),
          api_key: Some("sk-w".to_string()),
          model: Some("writer-m".to_string()),
        }]),
        assign: Some(LlmAssign {
          writing: Some("main-writer".to_string()),
          background: None,
          review: Some("main-writer".to_string()),
        }),
      }),
    };
    write_config_at(&file, &cfg).expect("write");
    assert!(file.is_file(), "配置文件应已落盘");
    assert!(
      !file.with_extension("json.tmp").exists(),
      "原子写后 .tmp 应已被 rename 掉"
    );

    let back = read_config_at(&file).expect("read back");
    assert_eq!(back.work_dir.as_deref(), Some("C:/works/新书"));
    assert_eq!(
      back.works.as_deref(),
      Some(vec!["C:/works/新书".to_string(), "C:/works/旧书".to_string()].as_slice())
    );
    let llm = back.llm.expect("llm");
    assert_eq!(llm.base_url.as_deref(), Some("https://llm.example/v1"));
    assert_eq!(llm.api_key.as_deref(), Some("sk-test-123"));
    assert_eq!(llm.model.as_deref(), Some("m1"));
    assert_eq!(llm.model_cheap.as_deref(), Some("m2"));
    let presets = llm.presets.expect("presets");
    assert_eq!(presets.len(), 1);
    assert_eq!(presets[0].id, "main-writer");
    assert_eq!(presets[0].name.as_deref(), Some("主笔"));
    assert_eq!(presets[0].base_url.as_deref(), Some("https://w.example/v1"));
    assert_eq!(presets[0].model.as_deref(), Some("writer-m"));
    let assign = llm.assign.expect("assign");
    assert_eq!(assign.writing.as_deref(), Some("main-writer"));
    assert_eq!(assign.background.as_deref(), None);
    assert_eq!(assign.review.as_deref(), Some("main-writer"));

    let _ = std::fs::remove_dir_all(&dir);
  }

  /// LLM 环境变量覆盖：只生成配置非空字段（空=继承壳进程环境变量，不覆盖）。
  #[test]
  fn llm_env_overrides_only_non_empty_config_fields() {
    assert!(llm_env_overrides(&AppConfig::default()).is_empty(), "全空配置不产生任何覆盖");
    let cfg = AppConfig {
      llm: Some(LlmConfig {
        base_url: Some("https://llm.example/v1".to_string()),
        api_key: None,
        model: Some("m1".to_string()),
        model_cheap: Some("  ".to_string()),
        presets: None,
        assign: None,
      }),
      ..Default::default()
    };
    assert_eq!(
      llm_env_overrides(&cfg),
      vec![
        ("LLM_BASE_URL".to_string(), "https://llm.example/v1".to_string()),
        ("LLM_MODEL".to_string(), "m1".to_string())
      ]
    );
  }

  /// D4：presets 非空时按归一化 id 注入 LLM_PRESET_<ID>_*，assign 只注非空。
  #[test]
  fn llm_env_overrides_injects_presets_and_non_empty_assign() {
    let cfg = AppConfig {
      llm: Some(LlmConfig {
        base_url: Some("https://legacy.example/v1".to_string()),
        api_key: Some("sk-legacy".to_string()),
        model: Some("legacy-m".to_string()),
        model_cheap: None,
        presets: Some(vec![
          LlmPreset {
            id: "main-writer".to_string(),
            name: Some("主笔".to_string()),
            base_url: Some("https://w.example/v1".to_string()),
            api_key: Some("sk-w".to_string()),
            model: Some("writer-m".to_string()),
          },
          LlmPreset {
            id: "bg helper".to_string(),
            name: Some("后台".to_string()),
            base_url: Some("https://b.example/v1".to_string()),
            api_key: Some("sk-b".to_string()),
            model: Some("bg-m".to_string()),
          },
        ]),
        assign: Some(LlmAssign {
          writing: Some("main-writer".to_string()),
          background: Some("  ".to_string()),
          review: Some("bg helper".to_string()),
        }),
      }),
      ..Default::default()
    };
    assert_eq!(
      llm_env_overrides(&cfg),
      vec![
        ("LLM_BASE_URL".to_string(), "https://legacy.example/v1".to_string()),
        ("LLM_API_KEY".to_string(), "sk-legacy".to_string()),
        ("LLM_MODEL".to_string(), "legacy-m".to_string()),
        ("LLM_PRESET_MAIN_WRITER_BASE_URL".to_string(), "https://w.example/v1".to_string()),
        ("LLM_PRESET_MAIN_WRITER_API_KEY".to_string(), "sk-w".to_string()),
        ("LLM_PRESET_MAIN_WRITER_MODEL".to_string(), "writer-m".to_string()),
        ("LLM_PRESET_BG_HELPER_BASE_URL".to_string(), "https://b.example/v1".to_string()),
        ("LLM_PRESET_BG_HELPER_API_KEY".to_string(), "sk-b".to_string()),
        ("LLM_PRESET_BG_HELPER_MODEL".to_string(), "bg-m".to_string()),
        ("LLM_ASSIGN_WRITING".to_string(), "main-writer".to_string()),
        ("LLM_ASSIGN_REVIEW".to_string(), "bg helper".to_string()),
      ]
    );
  }

  /// resolve_field：配置 > 环境变量 > 缺省；apiKey 打码只露前 4 位。
  #[test]
  fn resolve_field_priority_and_api_key_mask() {
    let cfg = resolve_field(Some("cfg-url"), "LLM_BASE_URL");
    assert_eq!((cfg.value.as_str(), cfg.source.as_str()), ("cfg-url", "config"));

    let env = resolve_field(None, "LLM_BASE_URL");
    if env.source == "env" {
      assert!(!env.value.is_empty());
    } else {
      assert_eq!(env.source, "default");
      assert!(env.value.is_empty());
    }

    let masked = resolve_field_masked(Some("sk-abcdef123456"), "LLM_API_KEY");
    assert_eq!(masked.source, "config");
    assert!(masked.value.starts_with("sk-a"), "打码应保留前 4 位: {}", masked.value);
    assert_ne!(masked.value, "sk-abcdef123456", "打码不得回显整把 key");
    assert!(resolve_field_masked(None, "LLM_THIS_ENV_DOES_NOT_EXIST").value.is_empty());
  }

  /// 脱敏：llm.api_key 与每个 preset.api_key 非空即替换为占位串；空/缺值保持原样；
  /// 原配置不被改动（克隆语义，core 启动注入环境变量仍用明文）。
  #[test]
  fn mask_api_keys_masks_all_keys_and_keeps_empty() {
    let cfg = AppConfig {
      llm: Some(LlmConfig {
        base_url: Some("https://llm.example/v1".to_string()),
        api_key: Some("sk-secret-legacy".to_string()),
        model: Some("m1".to_string()),
        model_cheap: None,
        presets: Some(vec![
          LlmPreset {
            id: "main-writer".to_string(),
            name: Some("主笔".to_string()),
            base_url: Some("https://w.example/v1".to_string()),
            api_key: Some("sk-w".to_string()),
            model: Some("writer-m".to_string()),
          },
          LlmPreset {
            id: "bg-helper".to_string(),
            name: Some("后台".to_string()),
            base_url: Some("https://b.example/v1".to_string()),
            api_key: None,
            model: Some("bg-m".to_string()),
          },
        ]),
        assign: None,
      }),
      ..Default::default()
    };
    let masked = mask_api_keys(&cfg);
    let llm = masked.llm.expect("llm");
    assert_eq!(llm.api_key.as_deref(), Some(API_KEY_MASK), "llm.api_key 应打码");
    let presets = llm.presets.expect("presets");
    assert_eq!(presets[0].api_key.as_deref(), Some(API_KEY_MASK), "preset key 应打码");
    assert_eq!(presets[1].api_key, None, "缺值保持原样");
    assert_eq!(llm.base_url.as_deref(), Some("https://llm.example/v1"), "非 key 字段不动");
    assert_eq!(
      cfg.llm.as_ref().unwrap().api_key.as_deref(),
      Some("sk-secret-legacy"),
      "原配置不得被改动"
    );
  }

  /// write_config「占位即保留」：收到的 apiKey 为占位串或空串时用磁盘原值顶回；
  /// 真实新值照写；按 preset id 对齐，磁盘没有的新预设照写；非 key 字段一律照写。
  #[test]
  fn merge_api_key_placeholders_preserves_disk_keys() {
    let disk = AppConfig {
      llm: Some(LlmConfig {
        base_url: Some("https://disk.example/v1".to_string()),
        api_key: Some("sk-disk-legacy".to_string()),
        model: Some("m-disk".to_string()),
        model_cheap: None,
        presets: Some(vec![
          LlmPreset {
            id: "main-writer".to_string(),
            name: Some("主笔".to_string()),
            base_url: Some("https://w.example/v1".to_string()),
            api_key: Some("sk-disk-w".to_string()),
            model: Some("writer-m".to_string()),
          },
          LlmPreset {
            id: "bg-helper".to_string(),
            name: Some("后台".to_string()),
            base_url: Some("https://b.example/v1".to_string()),
            api_key: Some("sk-disk-b".to_string()),
            model: Some("bg-m".to_string()),
          },
        ]),
        assign: None,
      }),
      ..Default::default()
    };

    // 前端不改动直接保存：legacy 与 main-writer 是占位串、bg-helper 空串 → 全保留磁盘值；
    // base_url 等普通字段照写；new-preset 是磁盘没有的新预设，真实 key 照写
    let mut incoming = AppConfig {
      llm: Some(LlmConfig {
        base_url: Some("https://new.example/v1".to_string()),
        api_key: Some(API_KEY_MASK.to_string()),
        model: Some("m-new".to_string()),
        model_cheap: None,
        presets: Some(vec![
          LlmPreset {
            id: "main-writer".to_string(),
            name: Some("主笔".to_string()),
            base_url: Some("https://w.example/v1".to_string()),
            api_key: Some(API_KEY_MASK.to_string()),
            model: Some("writer-m".to_string()),
          },
          LlmPreset {
            id: "bg-helper".to_string(),
            name: Some("后台".to_string()),
            base_url: Some("https://b.example/v1".to_string()),
            api_key: Some(String::new()),
            model: Some("bg-m".to_string()),
          },
          LlmPreset {
            id: "new-preset".to_string(),
            name: Some("新档".to_string()),
            base_url: Some("https://n.example/v1".to_string()),
            api_key: Some("sk-brand-new".to_string()),
            model: Some("n-m".to_string()),
          },
        ]),
        assign: None,
      }),
      ..Default::default()
    };
    merge_api_key_placeholders(&mut incoming, &disk);
    let llm = incoming.llm.expect("llm");
    assert_eq!(llm.api_key.as_deref(), Some("sk-disk-legacy"), "占位串保留磁盘 legacy key");
    let presets = llm.presets.expect("presets");
    assert_eq!(presets[0].api_key.as_deref(), Some("sk-disk-w"), "占位串保留磁盘 preset key");
    assert_eq!(presets[1].api_key.as_deref(), Some("sk-disk-b"), "空串保留磁盘 preset key");
    assert_eq!(presets[2].api_key.as_deref(), Some("sk-brand-new"), "新预设真实 key 照写");
    assert_eq!(llm.base_url.as_deref(), Some("https://new.example/v1"), "非 key 字段照写");
  }

  // ---------- 作者笔记：路径守卫 + 读写 roundtrip ----------

  /// 笔记路径守卫：非法相对路径逐个拒（.. / . / 盘符 / 以分隔符开头 / 非 .md / 空）。
  #[test]
  fn sanitize_note_rel_path_rejects_unsafe_and_accepts_relative_md() {
    for bad in [
      "",
      "..",
      "../escape.md",
      "..\\escape.md",
      "a/../b.md",
      "a/./b.md",
      "./a.md",
      "/abs.md",
      "\\abs.md",
      "C:/abs.md",
      "C:\\abs.md",
      "book.txt",
      "book",
      "a/b.md/",
      "chapters/..",
    ] {
      let err = sanitize_note_rel_path(bad).expect_err(&format!("{bad:?} 应被拒"));
      assert!(err.contains("笔记路径非法"), "错误应为路径非法: {err}");
    }
    for good in ["book.md", "chapters/ch-1.md", "a/b/c.md", "章节笔记.md", "a\\b.md"] {
      sanitize_note_rel_path(good).expect(&format!("{good:?} 应通过"));
    }
  }

  /// 笔记读写 roundtrip：写→读回；缺文件返回空串；写后 .tmp 不残留；子目录自动创建。
  #[test]
  fn note_write_read_roundtrip_and_missing_returns_empty() {
    let dir = temp_test_dir("notes-roundtrip");
    let root = dir.join("work").join(".novel").join("notes");
    std::fs::create_dir_all(&root).expect("create root");

    // 缺文件：返回空串
    assert_eq!(read_note_at(&root, "book.md").expect("read missing"), "");

    write_note_at(&root, "book.md", "作者私房话第一版").expect("write book");
    assert_eq!(
      read_note_at(&root, "book.md").expect("read back"),
      "作者私房话第一版"
    );
    assert!(!root.join("book.md.tmp").exists(), "原子写后 .tmp 应已被 rename 掉");

    // 子目录（chapters/<id>.md）需要时 create_dir_all
    write_note_at(&root, "chapters/ch-42.md", "本章私房话").expect("write chapter note");
    assert_eq!(
      read_note_at(&root, "chapters/ch-42.md").expect("read chapter note"),
      "本章私房话"
    );

    let _ = std::fs::remove_dir_all(&dir);
  }

  /// 目录穿越必须整体拒绝：.. 逃逸写不出去、也读不回，笔记根外不得落盘。
  #[test]
  fn note_at_rejects_traversal() {
    let dir = temp_test_dir("notes-traversal");
    let root = dir.join("work").join(".novel").join("notes");
    std::fs::create_dir_all(&root).expect("create root");

    let err = write_note_at(&root, "../evil.md", "x").expect_err(".. 应被拒");
    assert!(err.contains("笔记路径非法"), "错误应为路径非法: {err}");
    assert!(
      !dir.join("work").join("evil.md").exists(),
      "不得在笔记根外落盘"
    );

    assert!(read_note_at(&root, "a/../../evil.md").is_err(), "深层 .. 应被拒");
    assert!(write_note_at(&root, "a\\..\\evil.md", "x").is_err(), "反斜杠 .. 应被拒");

    let _ = std::fs::remove_dir_all(&dir);
  }
}

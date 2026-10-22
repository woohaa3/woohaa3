//! 主题快照 DTO、token 校验与规范 hex 解析
//! （change: refactor-bevy-rust-file-size，任务 2.1 / design D3）。

use serde::Deserialize;

/// theme id 最大长度。
pub(crate) const MAX_THEME_ID_LENGTH: usize = 80;
/// 单个 token 值最大长度。
pub(crate) const MAX_THEME_TOKEN_LENGTH: usize = 16;
/// theme token 数量上限（当前 schema 为 80；留有余量同时封顶）。
pub(crate) const MAX_THEME_TOKENS: usize = 160;

/// 主题 token 集合（change: unify-application-theme-tokens，design D4/D5）。
///
/// 与 Web `AppThemeSnapshot` 对应的纯 serde DTO：只承载**已验证**的规范 hex 值。
/// Rust 边界独立做防御校验（版本、颜色格式、token 数量、payload/值大小、id 长度）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Theme {
    pub(crate) id: String,
    pub(crate) version: String,
    pub(crate) fingerprint: String,
    /// 按名称索引的规范 hex（小写 `#rrggbb` / `#rrggbbaa`）。
    pub(crate) tokens: std::collections::HashMap<String, String>,
}

impl Theme {
    /// 取一个 token 的规范 hex。`validate` 保证集合完整，因此缺失只可能出现在未校验的构造；
    /// 此时返回默认主题同名词作为安全兜底（change: 2026-10-07-remove-residual-compatibility）。
    pub(crate) fn token(&self, name: &str) -> &str {
        self.tokens
            .get(name)
            .map(String::as_str)
            .unwrap_or_else(|| default_token(name))
    }

    /// 校验版本、id、fingerprint 形态与每个 token 的颜色格式/大小。
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.version != crate::theme_generated::APP_THEME_SCHEMA_VERSION {
            return Err("Unknown theme version");
        }
        if self.id.is_empty() || self.id.len() > MAX_THEME_ID_LENGTH {
            return Err("Invalid theme id");
        }
        if !is_safe_theme_id(&self.id) {
            return Err("Invalid theme id");
        }
        if self.fingerprint.len() > 32 || !self.fingerprint.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("Invalid theme fingerprint");
        }
        if self.tokens.len() > MAX_THEME_TOKENS {
            return Err("Theme has too many tokens");
        }
        // change: 2026-10-07-remove-residual-compatibility —— 必须具备完整已登记 token 集合；
        // 缺失任一 token 即拒绝，不再由 `token()` 回退默认值。
        if self.tokens.len() != crate::theme_generated::APP_THEME_DEFAULT_TOKENS.len() {
            return Err("Incomplete theme tokens");
        }
        for (name, value) in &self.tokens {
            if !is_known_theme_token(name) {
                return Err("Unknown theme token");
            }
            if value.len() > MAX_THEME_TOKEN_LENGTH || parse_theme_hex(value).is_none() {
                return Err("Invalid theme token");
            }
        }
        Ok(())
    }
}

/// theme JSON 的反序列化 DTO（serde）；未知字段忽略（前向兼容），字段级校验在 `Deserialize` 内完成。
#[derive(Clone, Deserialize)]
pub(crate) struct ThemeSnapshot {
    #[serde(default)]
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) version: String,
    #[serde(default)]
    pub(crate) fingerprint: String,
    #[serde(default)]
    pub(crate) tokens: std::collections::HashMap<String, String>,
}

/// 自定义反序列化：解析后立即做边界校验；未知版本/畸形颜色/超限 payload 直接报错，
/// 绝不静默生成混合主题（design D4/D7）。
impl<'de> Deserialize<'de> for Theme {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = ThemeSnapshot::deserialize(deserializer)?;
        if raw.tokens.len() > MAX_THEME_TOKENS {
            return Err(serde::de::Error::custom("Theme has too many tokens"));
        }
        let theme = Theme {
            id: raw.id,
            version: raw.version,
            fingerprint: raw.fingerprint,
            tokens: raw.tokens,
        };
        theme.validate().map_err(serde::de::Error::custom)?;
        Ok(theme)
    }
}

/// 默认 preset：由 canonical token source 生成，供应用初始化与测试 factory 使用。
///
/// change: 2026-10-07-remove-residual-compatibility —— 不再作为**场景**缺失主题时的回退；
/// scene 必须携带完整合法 theme，缺失/非法在 `Scene::validate` 处拒绝。
impl Default for Theme {
    fn default() -> Self {
        generated_default_theme()
    }
}

/// 由 canonical preset 生成的默认主题（应用初始化/测试 factory）。
pub(crate) fn generated_default_theme() -> Theme {
    let tokens: std::collections::HashMap<String, String> =
        crate::theme_generated::APP_THEME_DEFAULT_TOKENS
            .iter()
            .map(|(name, hex)| ((*name).to_owned(), (*hex).to_owned()))
            .collect();
    Theme {
        id: crate::theme_generated::APP_THEME_DEFAULT_ID.to_owned(),
        version: crate::theme_generated::APP_THEME_SCHEMA_VERSION.to_owned(),
        fingerprint: crate::theme_generated::APP_THEME_DEFAULT_FINGERPRINT.to_owned(),
        tokens,
    }
}

/// 默认主题中一个 token 的规范 hex（供 `Theme::token` 兜底缺失项）。
fn default_token(name: &str) -> &'static str {
    crate::theme_generated::APP_THEME_DEFAULT_TOKENS
        .iter()
        .find(|(known, _)| *known == name)
        .map(|(_, hex)| *hex)
        .unwrap_or("#00000000")
}

/// 规范 hex：`#RRGGBB` / `#RRGGBBAA`（大小写不敏感）。
pub(crate) fn parse_theme_hex(value: &str) -> Option<(u8, u8, u8, u8)> {
    let bytes = value.as_bytes();
    if bytes.len() != 7 && bytes.len() != 9 {
        return None;
    }
    if bytes[0] != b'#' {
        return None;
    }
    if !bytes[1..].iter().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let nibble = |index: usize| -> u8 {
        let c = bytes[index];
        match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            b'A'..=b'F' => c - b'A' + 10,
            _ => 0,
        }
    };
    let channel = |index: usize| -> u8 { (nibble(index) << 4) | nibble(index + 1) };
    let r = channel(1);
    let g = channel(3);
    let b = channel(5);
    let a = if bytes.len() == 9 { channel(7) } else { 255 };
    Some((r, g, b, a))
}

/// 已知 token 名集合（与 canonical preset 一致；未知名整体拒绝）。
pub(crate) fn is_known_theme_token(name: &str) -> bool {
    crate::theme_generated::APP_THEME_DEFAULT_TOKENS
        .iter()
        .any(|(known, _)| *known == name)
}

fn is_safe_theme_id(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

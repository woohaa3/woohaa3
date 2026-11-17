//! Cumulative CPU geometry work, independent of retained-resource lifetime.
#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ResourceWork {
    pub cache_hits: u64,
    pub build_attempts: u64,
    pub built_meshes: u64,
    pub build_ms: f64,
    pub max_build_ms: f64,
}
impl ResourceWork {
    pub fn built(&mut self, success: bool, milliseconds: f64) {
        self.build_attempts += 1;
        self.built_meshes += u64::from(success);
        self.build_ms += milliseconds;
        self.max_build_ms = self.max_build_ms.max(milliseconds);
    }
}

/// 总览 LOD 的实际工作量计数（change: 2026-10-15-add-film-set-overview-lod，design D6）。
///
/// 统计来源是既有接受场景与准备路径，读取诊断不额外遍历源码、求值动作或准备几何；稳定档位、
/// 纯平移与稳定播放不应反复累加。
#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OverviewWork {
    /// 投影 bounds 重算次数（投影 key 未命中）。
    pub bounds_rebuilds: u64,
    /// 单活动准备推进帧数（每帧至多推进一次预算）。
    pub prepare_calls: u64,
    /// 已推进的 source spec 累计数（含缓存命中）。
    pub specs_prepared: u64,
    /// 原子发布次数。
    pub publishes: u64,
    /// 在途准备作废次数（换目标、内容/代数变化、无候选）。
    pub cancels: u64,
    /// replacement 准备失败次数（保持旧表示）。
    pub prepare_failures: u64,
    /// 因 250ms 保持时间而推迟的非 High 发布次数。
    pub hold_deferrals: u64,
}

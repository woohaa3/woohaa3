//! 画布级 3D 根的地面排序与整对象深度分离
//! （change: 2026-10-27-order-canvas-layers-by-ground-anchor，design D1/D3/D4）。
//!
//! 2D 与 3D 共用**可见地面底边**作为锚点：group/普通节点取节点矩形底边，片场/复合资产取
//! 地面范围外包框底边（与范围绘制、命中同一 `canvas_query::scope` 几何）。片场的节点矩形
//! 只是内容适配框，用它的底边会把可见地面更靠下的小片场排到后面。
//!
//! 3D 遮挡分两层：
//! - **根与根之间**整对象分离：只有屏幕外包框相交的根组成重叠簇，簇内按锚点/id 升序分配
//!   前后深度带，相邻根至少相隔一个「可见尺寸」量级的分离量，使靠前的根整体盖住靠后的根；
//! - **同一根内部**仍由深度缓冲逐像素比较真实片元深度。
//!
//! 纯逐像素（根都留在同一深度平面）无法实现前者：两个片场的地台是真实三维地面，靠上片场
//! 靠近相机的前缘在对叠处本就比靠下片场的远端更近，逐像素只会稳定地让上方的地台压住下方。
//!
//! 本模块是纯几何 + 线程本地已接受表：不依赖 ECS、bridge、wasm 或模型资源。锚点、外包框与
//! 分离量只由结构几何与可见地面派生；模型尚未驻留或徽标范围缺失都不影响顺序。
//! [`apply_deltas`] 从基线重算，深度只在完整场景接受与位置增量接受时结算。

use std::cell::RefCell;
use std::collections::HashMap;

use crate::protocol::{GraphNode, Scene};

/// 相邻深度带之间的额外间距（世界单位），避免刚好相等的边界互相穿插。
const SEPARATION_MARGIN: f32 = 8.0;
/// 单个重叠簇的深度总跨度上限（世界单位）。
///
/// 必须远小于网格深度 `GRID_DEPTH = -20000`，保证后退最多的根仍在网格之前；超出时按根数
/// 均分并记录压缩诊断，宁可牺牲极端簇的完全分离也不越过网格或相机平面。
const MAX_CLUSTER_SPAN: f32 = 8000.0;
/// 可见外包框最大边到真实视线厚度的放大系数。
///
/// 等距正交投影下，内容沿视线方向的厚度不会被投影宽度/高度直接限制；取 2.5 倍最大边作为
/// 保守上界（实测片场地台厚度约为最大边的 1.2–1.6 倍），只用于相邻根的分离量，不写回几何。
const DEPTH_EXTENT_FACTOR: f32 = 2.5;

/// 画布坐标下的节点可见外包框（用于重叠聚类）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ScreenBounds {
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) width: f32,
    pub(crate) height: f32,
}

impl ScreenBounds {
    fn overlaps(&self, other: &Self) -> bool {
        self.x < other.x + other.width
            && other.x < self.x + self.width
            && self.y < other.y + other.height
            && other.y < self.y + self.height
    }

    fn union(self, other: Self) -> Self {
        let min_x = self.x.min(other.x);
        let min_y = self.y.min(other.y);
        let max_x = (self.x + self.width).max(other.x + other.width);
        let max_y = (self.y + self.height).max(other.y + other.height);
        Self {
            x: min_x,
            y: min_y,
            width: (max_x - min_x).max(0.0),
            height: (max_y - min_y).max(0.0),
        }
    }

    fn max_extent(&self) -> f32 {
        self.width.max(self.height).max(1.0)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RootBase {
    pub(crate) id: String,
    /// 可见地面底边（画布 y 向下，值越大越靠前）。
    pub(crate) anchor: f32,
    /// 可见外包框：片场为地面范围与节点矩形的并集，其余为节点矩形。
    pub(crate) bounds: ScreenBounds,
}

/// 深度表规模诊断（每帧不重排，只报告接受点结算结果）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct DepthDiagnostics {
    pub(crate) roots: usize,
    /// 参与整对象分离的重叠簇数量（单根簇不计）。
    pub(crate) clusters: usize,
    /// 因总跨度封顶而压缩步长的簇数量。
    pub(crate) compressed_clusters: usize,
}

#[derive(Default)]
struct State {
    base: Vec<RootBase>,
    depths: HashMap<String, f32>,
    diagnostics: DepthDiagnostics,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

/// 节点的可见地面底边（画布 y 向下，值越大越靠前）。
///
/// 复合资产（片场、第三方）复用绘制/命中的范围几何：地面矩形时取外包框底边，
/// `rect` 形状时即基准矩形底边（含最小值归一化）。普通节点与组取节点矩形底边。
pub(crate) fn ground_anchor(node: &GraphNode) -> f32 {
    if node.composite_asset.is_some() {
        let scope = crate::canvas_query::scope::node_scope(node);
        return scope.aabb.y + scope.aabb.height;
    }
    node.y + node.height
}

/// 节点的可见外包框：复合资产把地面范围并入节点矩形（高模型/范围可能互不完全包含）。
pub(crate) fn screen_bounds(node: &GraphNode) -> ScreenBounds {
    let rect = ScreenBounds {
        x: node.x,
        y: node.y,
        width: node.width.max(0.0),
        height: node.height.max(0.0),
    };
    if node.composite_asset.is_some() {
        let scope = crate::canvas_query::scope::node_scope(node);
        return rect.union(ScreenBounds {
            x: scope.aabb.x,
            y: scope.aabb.y,
            width: scope.aabb.width,
            height: scope.aabb.height,
        });
    }
    rect
}

/// 接受完整场景：重建 3D 根表并发布深度带。
///
/// 只读 `node.model` 引用与可见几何本身：payload 尚未驻留的根照常参与，模型异步到达不会让
/// 前后顺序跳变（change: 2026-10-27-order-canvas-layers-by-ground-anchor，design D1）。
pub(crate) fn accept_scene(scene: &Scene) {
    let roots: Vec<RootBase> = scene
        .nodes
        .iter()
        .filter(|node| node.model.is_some())
        .map(|node| RootBase {
            id: node.id.clone(),
            anchor: ground_anchor(node),
            bounds: screen_bounds(node),
        })
        .collect();
    publish(roots);
}

/// 位置增量接受点：位置是相对最近完整场景的绝对值，因此每次都从基线重算，不累积漂移。
pub(crate) fn apply_deltas<'a>(deltas: impl Iterator<Item = (&'a str, f32, f32)>) {
    let moved: HashMap<&str, (f32, f32)> = deltas.map(|(id, dx, dy)| (id, (dx, dy))).collect();
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        let roots = state
            .base
            .iter()
            .map(|root| match moved.get(root.id.as_str()) {
                Some((dx, dy)) => RootBase {
                    id: root.id.clone(),
                    anchor: root.anchor + dy,
                    bounds: ScreenBounds {
                        x: root.bounds.x + dx,
                        y: root.bounds.y + dy,
                        ..root.bounds
                    },
                },
                None => root.clone(),
            })
            .collect();
        publish_into(&mut state, roots);
    });
}

/// 当前根的观察深度；未知根（无 `model` 引用 / 尚未接受）为 0。
pub(crate) fn depth_of(id: &str) -> f32 {
    STATE.with(|state| state.borrow().depths.get(id).copied().unwrap_or(0.0))
}

pub(crate) fn diagnostics() -> DepthDiagnostics {
    STATE.with(|state| state.borrow().diagnostics)
}

fn publish(roots: Vec<RootBase>) {
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        state.base = roots;
        let roots = state.base.clone();
        publish_into(&mut state, roots);
    });
}

fn publish_into(state: &mut State, roots: Vec<RootBase>) {
    let (depths, diagnostics) = assign_depths(&roots);
    state.depths = depths;
    state.diagnostics = diagnostics;
}

/// 纯结算：按可见外包框把根分成重叠簇，簇内按锚点/id 升序分配前后深度带。
///
/// 簇内最后一个（锚点最大）根的深度保持 0，其余依次向相机后方后退 `step`，因此不需要移动
/// 相机、不改变投影，也不会让后退最多的根越过网格。互不重叠的根无需分离，保持 0。
pub(crate) fn assign_depths(roots: &[RootBase]) -> (HashMap<String, f32>, DepthDiagnostics) {
    let count = roots.len();
    let mut diagnostics = DepthDiagnostics {
        roots: count,
        ..DepthDiagnostics::default()
    };
    let mut depths = HashMap::with_capacity(count);
    if count == 0 {
        return (depths, diagnostics);
    }
    let mut parent: Vec<usize> = (0..count).collect();
    for left in 0..count {
        for right in (left + 1)..count {
            if roots[left].bounds.overlaps(&roots[right].bounds) {
                union(&mut parent, left, right);
            }
        }
    }
    let mut clusters: HashMap<usize, Vec<usize>> = HashMap::new();
    for index in 0..count {
        let root = find(&mut parent, index);
        clusters.entry(root).or_default().push(index);
    }
    for members in clusters.values() {
        if members.len() < 2 {
            depths.insert(roots[members[0]].id.clone(), 0.0);
            continue;
        }
        diagnostics.clusters += 1;
        let mut ordered = members.clone();
        ordered.sort_by(|left, right| {
            roots[*left]
                .anchor
                .total_cmp(&roots[*right].anchor)
                .then_with(|| roots[*left].id.cmp(&roots[*right].id))
        });
        let max_extent = ordered
            .iter()
            .map(|index| roots[*index].bounds.max_extent())
            .fold(0.0_f32, f32::max);
        let mut step = max_extent * DEPTH_EXTENT_FACTOR + SEPARATION_MARGIN;
        let span = step * (ordered.len() - 1) as f32;
        if span > MAX_CLUSTER_SPAN {
            step = MAX_CLUSTER_SPAN / (ordered.len() - 1) as f32;
            diagnostics.compressed_clusters += 1;
        }
        let last = ordered.len() - 1;
        for (rank, index) in ordered.into_iter().enumerate() {
            depths.insert(
                roots[index].id.clone(),
                rank as f32 * step - last as f32 * step,
            );
        }
    }
    (depths, diagnostics)
}

fn find(parent: &mut [usize], index: usize) -> usize {
    let mut current = index;
    while parent[current] != current {
        parent[current] = parent[parent[current]];
        current = parent[current];
    }
    current
}

fn union(parent: &mut [usize], left: usize, right: usize) {
    let left_root = find(parent, left);
    let right_root = find(parent, right);
    if left_root != right_root {
        parent[right_root] = left_root;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(id: &str, anchor: f32) -> RootBase {
        RootBase {
            id: id.to_owned(),
            anchor,
            bounds: ScreenBounds {
                x: 0.0,
                y: anchor - 300.0,
                width: 400.0,
                height: 300.0,
            },
        }
    }

    fn centered(id: &str, anchor: f32, bounds: ScreenBounds) -> RootBase {
        RootBase {
            id: id.to_owned(),
            anchor,
            bounds,
        }
    }

    /// 重叠根按锚点顺序整对象分离：锚点更大（可见地面更靠下）的根深度更大（更近相机）。
    #[test]
    fn overlapping_roots_separate_along_the_anchor_order() {
        let roots = vec![root("b", 100.0), root("a", 100.0), root("c", 300.0)];
        let (depths, diag) = assign_depths(&roots);
        assert_eq!(diag.roots, 3);
        assert_eq!(diag.clusters, 1);
        assert_eq!(diag.compressed_clusters, 0);
        assert!(depths["a"] < depths["b"]);
        assert!(depths["b"] < depths["c"]);
        // 最后一名的深度保持 0，其余整体后退；相邻间隔覆盖可见尺寸量级。
        assert_eq!(depths["c"], 0.0);
        let step = -depths["b"];
        assert!(step >= 2.5 * 400.0);
        assert!((depths["b"] - depths["a"] - step).abs() < 1e-3);
    }

    /// 互不重叠的根不建立簇，都留在自然深度平面（逐像素只在真正重叠时介入）。
    #[test]
    fn disjoint_roots_keep_the_same_plane() {
        let left = centered(
            "left",
            300.0,
            ScreenBounds {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
        );
        let right = centered(
            "right",
            900.0,
            ScreenBounds {
                x: 500.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
        );
        let (depths, diag) = assign_depths(&[left, right]);
        assert_eq!(diag.clusters, 0);
        assert_eq!(depths["left"], 0.0);
        assert_eq!(depths["right"], 0.0);
    }

    /// 重叠簇的总跨度有上限：根很多时压缩步长并记录诊断，仍保持锚点顺序。
    #[test]
    fn cluster_span_stays_bounded() {
        let roots: Vec<RootBase> = (0..12)
            .map(|index| {
                centered(
                    &format!("n{index}"),
                    index as f32,
                    ScreenBounds {
                        x: 0.0,
                        y: 0.0,
                        width: 1600.0,
                        height: 1000.0,
                    },
                )
            })
            .collect();
        let (depths, diag) = assign_depths(&roots);
        assert_eq!(diag.clusters, 1);
        assert_eq!(diag.compressed_clusters, 1);
        let span = depths["n11"] - depths["n0"];
        assert!(span <= MAX_CLUSTER_SPAN + 1e-3, "span {span}");
        assert_eq!(depths["n11"], 0.0);
        for index in 1..12 {
            assert!(depths[&format!("n{}", index)] > depths[&format!("n{}", index - 1)]);
        }
    }

    /// 位置增量从基线重算：越过相邻锚点后立即换序，不需要下一次完整场景。
    #[test]
    fn position_deltas_recompute_from_baseline() {
        publish(vec![root("a", 0.0), root("b", 10.0)]);
        assert!(depth_of("a") < depth_of("b"));
        apply_deltas([("b", 0.0, -40.0)].into_iter());
        assert!(depth_of("b") < depth_of("a"));
        apply_deltas([("b", 0.0, 0.0)].into_iter());
        assert!(depth_of("a") < depth_of("b"));
    }

    /// `set_scene` 与位置增量两个接受点都必须发布深度：否则模型仍读旧表，
    /// 拖动容器要等下一次完整场景才换序（change: 2026-10-27-...，任务 3.3）。
    #[cfg(feature = "canvas-core")]
    #[test]
    fn accepted_scene_and_position_increments_publish_depths() {
        use crate::protocol::{
            CANVAS_POSITION_UPDATE_VERSION, NodePosition, PositionUpdateRequest,
        };
        declare_test_descriptor();
        let node = |id: &str, y: f32| {
            format!(
                r#"{{"id":"{id}","type":"group","x":0,"y":{y},"width":400,"height":300,
                "group":{{"modelBounds":{{"aabb":{{"min":[-1,-1,-1],"max":[1,1,1]}},"extent":2}}}},
                "model":{{"resourceKey":"test:box","signature":"box"}}}}"#
            )
        };
        let json = test_scene_json(&[node("a", 0.0), node("b", 10.0)]);
        let generation = crate::set_scene(&json).expect("scene accepted");
        // a 的底边更低（300 < 310），整对象分离因此让 a 在后。
        assert!(depth_of("a") < depth_of("b"));
        let request = PositionUpdateRequest {
            version: CANVAS_POSITION_UPDATE_VERSION.to_owned(),
            base_scene_generation: generation,
            positions: vec![NodePosition {
                id: "a".to_owned(),
                x: 0.0,
                y: 25.0,
            }],
            viewport: None,
        };
        crate::canvas_query::interaction::accept_positions(&request).expect("position accepted");
        assert!(depth_of("b") < depth_of("a"));
    }

    /// 片场锚点取**可见地面**底边：片场矩形底边更低时仍按地面菱形底角排序。
    ///
    /// 几何取用户画布里的重叠对（映射层真实派生的 `scopeGround`）。小复合资产的地面
    /// 停在更靠下的地面坐标上，因此它的**可见地面底边**比导演场更低，而它的**矩形底边**
    /// 更高：按矩形会把导演场排在前面，按可见地面则小复合资产在前。
    ///
    /// 注意 `ay` 由全局俯仰角派生（`scope_axis_y()`），导演场的地面范围更大，`ay` 变大时
    /// 它的地面底边下降得更快 —— 原夹具（prop 地面中心 3038.47）在俯仰角调到 37° 后
    /// 两者顺序会翻转、夹具失去意义。这里把 prop 的地面中心下移到 3200，让「小资产地面更低」
    /// 这个前提在常见俯仰角区间内都成立，而不是绑定到某一个角度。
    #[cfg(feature = "canvas-core")]
    #[test]
    fn composite_asset_anchor_follows_visible_ground_not_content_rect() {
        declare_test_descriptor();
        let stage = r#"{"id":"stage","type":"composite-asset","x":-1479,"y":2286.25,
            "width":1254,"height":941,
            "compositeAsset":{"x":-852,"y":2744.00,"width":1254,"height":941,
              "scopeShape":"isometric-diamond",
              "scopeGround":{"cx":-852,"cy":2744.00,"hx":510.61,"hz":381.43}},
            "model":{"resourceKey":"test:box","signature":"box"}}"#
            .to_owned();
        let prop = r#"{"id":"prop","type":"composite-asset","x":-739.25,"y":2915.75,
            "width":260,"height":195,
            "compositeAsset":{"x":-609.25,"y":3200.00,"width":260,"height":195,
              "scopeShape":"isometric-diamond",
              "scopeGround":{"cx":-609.25,"cy":3200.00,"hx":95.47,"hz":75.20}},
            "model":{"resourceKey":"test:box","signature":"box"}}"#
            .to_owned();
        let ground_bottom = |cy: f32, hx: f32, hz: f32| {
            cy + crate::isometric_grid::plan::scope_axis_y() * (hx + hz)
        };
        let stage_rect = 2286.25 + 941.0;
        let prop_rect = 2915.75 + 195.0;
        let stage_ground = ground_bottom(2744.00, 510.61, 381.43);
        let prop_ground = ground_bottom(3200.00, 95.47, 75.20);
        // 先确认矩形底边顺序确实与可见地面顺序相反，测试才有意义。
        assert!(stage_rect > prop_rect, "按矩形应把导演场排在前面");
        assert!(prop_ground > stage_ground, "按可见地面应把小复合资产排在前面");
        crate::set_scene(&test_scene_json(&[stage, prop])).expect("scene accepted");
        // 可见地面更靠下的小复合资产必须获得更大的观察深度（更靠近相机）。
        assert!(depth_of("prop") > depth_of("stage"));
    }

    #[cfg(feature = "canvas-core")]
    fn declare_test_descriptor() {
        use crate::protocol::ModelDescriptorDto;
        // 深度表只读 `node.model` 引用，但 `set_scene` 仍要求 descriptor 已声明。
        crate::bridge::declare_model_descriptor_dto(ModelDescriptorDto {
            resource_version: crate::protocol::MODEL_DESCRIPTOR_VERSION.to_owned(),
            resource_key: "test:box".to_owned(),
            scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
            signature: "box".to_owned(),
            extent: 2.0,
            aabb: None,
        })
        .expect("descriptor declared");
    }

    #[cfg(feature = "canvas-core")]
    fn test_scene_json(nodes: &[String]) -> String {
        let mut tokens = String::new();
        for (index, (name, hex)) in crate::theme_generated::APP_THEME_DEFAULT_TOKENS
            .iter()
            .enumerate()
        {
            if index > 0 {
                tokens.push(',');
            }
            tokens.push_str(&format!("\"{name}\":\"{hex}\""));
        }
        let theme = format!(
            r#"{{"id":"default","version":"{}","fingerprint":"{}","tokens":{{{tokens}}}}}"#,
            crate::theme_generated::APP_THEME_SCHEMA_VERSION,
            crate::theme_generated::APP_THEME_DEFAULT_FINGERPRINT,
        );
        format!(
            r#"{{"version":"{}","nodes":[{}],"edges":[],"theme":{theme}}}"#,
            crate::protocol::CANVAS_RENDER_SCENE_VERSION,
            nodes.join(","),
        )
    }
}

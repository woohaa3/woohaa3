//! U74/U75 的 `Editor` 入口：历史快照、按范围清理、动作录制与 ATN
//! （change: 2026-10-22-add-photocraft-history-automation-workflows）。
//!
//! 本文件由 `editor/tools.rs` 以 `#[path]` 挂载，因此与其它域共享同一个 `Editor`——不新建会话、
//! 不复制文档或历史。事务规则与全局一致：内容写入走一次 `Session::execute` / `Session::edit`
//! （一步历史），失败保留现场；查询不写内容。
//!
//! 两道本域自己的门：
//!
//! 1. **命令门**：所有内容命令先过 [`crate::capability::command_allowed`]。域内入口不能成为绕过
//!    唯一命令门的第二条写路径。
//! 2. **清理确认门**：`edit.purge.*` 不可恢复，必须显式带 `{"confirm": true}`，否则返回说明
//!    影响范围的中文错误（U74「清理前说明不可恢复范围并确认」）。
use serde_json::{Value, json};

use crate::editor::*;
use super::command_error;

/// 清理范围 → (上游命令, 面向用户的影响说明)。
fn purge_scope(what: &str) -> Option<(&'static str, &'static str)> {
    Some(match what {
        "undo" => ("edit.purge.undo", "当前文档的可撤销记录"),
        "clipboard" => ("edit.purge.clipboard", "工作区内复制的像素与图层"),
        "histories" => ("edit.purge.histories", "所有打开文档的历史状态（含重做）"),
        "videoCache" => ("edit.purge.videoCache", "视频缓存（当前没有视频图层时为 0）"),
        "all" => ("edit.purge.all", "所有文档的历史、剪贴板与各类缓存"),
        _ => return None,
    })
}

impl Editor {
    /// 历史面板的完整只读视图：状态、重做、快照与来源句柄。
    ///
    /// `epoch` 是历史源的身份：文档身份 + 状态标签序列（含重做）的摘要，见 [`history_epoch`]。
    /// 清理、删除状态或切快照都会改变它；不产生历史步骤的编辑（如 `image.variables.define`）
    /// **不会**改变它——归档状态本身没变，有效源不能被误判失效。跨域消费者（历史画笔）据此
    /// 判定旧源是否仍可用，而不是继续按旧索引取样。
    pub fn history_state(&self) -> Result<Value> {
        let state = self.active_doc()?;
        let entries = state.history.entries();
        let redo: Vec<String> = state.history.redo_labels().map(str::to_string).collect();
        let epoch = history_epoch(state.doc.id.0, &entries, &redo);
        Ok(json!({
            "entries": entries,
            "redo": redo,
            "current": entries.len().saturating_sub(1),
            "canUndo": state.history.can_undo(),
            "canRedo": state.history.can_redo(),
            "snapshots": state.snapshots.iter().map(|snap| json!({
                "id": snap.id,
                "name": snap.name,
                // 快照记的是「取样时的活动图层」，不是图层数：命名必须与含义一致，
                // 否则消费方会拿它当计数用。
                "activeLayer": snap.layers.active.map(|layer| layer.0),
            })).collect::<Vec<_>>(),
            "epoch": epoch,
            // 历史源句柄：过去的状态保存着归档文档，最后一个就是当前工作文档本身。
            // `live` 是消费者唯一需要区分的：取样当前状态要用活文档，取过去状态要用归档快照。
            "sources": entries.iter().enumerate().map(|(index, label)| json!({
                "index": index,
                "label": label,
                "live": index + 1 == entries.len(),
            })).collect::<Vec<_>>(),
        }))
    }

    /// 历史/快照/清理命令的统一入口：先过命令门，再走同一 `Session::execute`。
    ///
    /// 只接受本域登记的历史类命令；其它 id 一律按「未开放」拒绝，避免这个入口变成通用转发器。
    pub fn history_command(&mut self, id: &str, params: Value) -> Result<Value> {
        if !HISTORY_COMMANDS.contains(&id) {
            return Err(EditorError::CapabilityDisabled(id.into()));
        }
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        if !crate::capability::command_allowed(id) {
            return Err(EditorError::CapabilityDisabled(id.into()));
        }
        let result = self
            .session
            .execute(id, params)
            .map_err(|failure| command_error(id, failure))?;
        // 快照与删除状态都改变历史结构：快照本身不进历史，但界面需要最新的快照/epoch。
        let mut value = self.history_state()?;
        if let Some(object) = value.as_object_mut() {
            object.insert("result".into(), result);
        }
        Ok(value)
    }

    /// 新建命名快照（`from`: fullDocument|mergedLayers|currentLayer）。
    pub fn history_new_snapshot(&mut self, params: Value) -> Result<Value> {
        self.history_command("history.newSnapshot", params)
    }

    /// 回到某个快照，作为一个新的、可撤销的历史步骤。
    pub fn history_select_snapshot(&mut self, params: Value) -> Result<Value> {
        self.history_command("history.selectSnapshot", params)
    }

    /// 重命名快照。
    pub fn history_rename_snapshot(&mut self, params: Value) -> Result<Value> {
        self.history_command("history.renameSnapshot", params)
    }

    /// 删除快照（文档与其历史不变）。
    pub fn history_delete_snapshot(&mut self, params: Value) -> Result<Value> {
        self.history_command("history.deleteSnapshot", params)
    }

    /// 删除历史状态（含其后的所有状态）；最旧状态不可删除。
    pub fn history_delete_state(&mut self, params: Value) -> Result<Value> {
        self.history_command("history.deleteState", params)
    }

    /// 从某个历史状态建立**独立**的新文档（本会话内新条目，历史从一步开始）。
    ///
    /// 新文档的登记仍归共享工作区（标签、代际与保存），本入口只负责创建内核文档并如实返回它
    /// 在会话中的索引；宿主是否需要新标签由集成负责人接线。
    pub fn history_new_document(&mut self, params: Value) -> Result<Value> {
        self.history_command("history.newDocument", params)
    }

    /// 取历史源的像素样本（历史画笔、`edit.fillHistory` 这类消费者的读取路径）。
    ///
    /// `params`：`{epoch, state?, maxSide?}`。`epoch` 是调用方取源时 [`Self::history_state`]
    /// 给出的身份；`state` 是该源在 `entries` 里的下标（省略 = 活文档）；`maxSide` 是预览边长
    /// 上限（1..=2048，默认 256）。`preview: false` 只做身份与索引校验、不分配像素——
    /// 历史画笔只需要知道「这个源还能用吗」，不该为了问一句话合成一张图。
    ///
    /// 这是「正确失效历史画笔源」真正落地的地方：只把 `epoch` 显示出来、让消费方自己比对是不够的，
    /// 消费方可能拿着旧句柄直接按索引取样，而清理后**同一个索引指向别的内容**。这里在读取点先比对
    /// `epoch`，不一致就拒绝并说明「源已失效」，**绝不**按旧索引返回新内容：
    ///
    /// - 清理历史 / 删除状态 / 回到快照 → 状态序列变化 → 旧 `epoch` 被拒；
    /// - 不产生历史步骤的编辑（如改变量）→ `epoch` 不变 → 旧源仍可取样（归档内容确实没变）；
    /// - 另一份文档的历史按下标可能完全相同 → `epoch` 含文档身份，跨文档的旧句柄也会被拒。
    ///
    /// 返回的样本来自**归档文档**（不是当前文档），因此取样旧状态不会把现在的像素当成过去的像素。
    pub fn history_sample(&self, params: Value) -> Result<Value> {
        let state_index = params.get("state").and_then(Value::as_u64).map(|value| value as usize);
        let max_side = params
            .get("maxSide")
            .and_then(Value::as_u64)
            .map_or(DEFAULT_SAMPLE_SIDE, |value| value.clamp(1, u64::from(MAX_SAMPLE_SIDE)) as u32);
        // 默认带预览（现有调用方与测试依赖它）；显式 `preview: false` 才跳过合成。
        let want_preview = params.get("preview").and_then(Value::as_bool).unwrap_or(true);
        let epoch = params
            .get("epoch")
            .and_then(Value::as_str)
            .ok_or_else(|| command_error("history.sample", "缺少 epoch（取源时由 historyState 给出）"))?;
        let state = self.active_doc()?;
        let entries = state.history.entries();
        let redo: Vec<String> = state.history.redo_labels().map(str::to_string).collect();
        let current = history_epoch(state.doc.id.0, &entries, &redo);
        if epoch != current {
            // 说清楚是哪一类失效：用户刚清理过历史，还是切到了另一份文档。
            return Err(command_error(
                "history.sample",
                format!(
                    "历史源已失效（取源时为 {epoch}，当前为 {current}）：状态序列或文档已经变化。请重新取源后再取样；不会按旧索引返回新内容"
                ),
            ));
        }
        let last = entries.len().saturating_sub(1);
        let index = state_index.unwrap_or(last);
        if index > last {
            return Err(command_error(
                "history.sample",
                format!("`state` = {index} 不是一个历史状态（0..={last}）"),
            ));
        }
        // 归档状态用历史里的那份文档，活状态用当前文档本身：取样不能把现在的像素当成过去的像素。
        let source = if index == last {
            state.doc.clone()
        } else {
            state
                .history
                .state(index)
                .ok_or_else(|| command_error("history.sample", format!("状态 {index} 不再被保留")))?
        };
        let label = entries.get(index).cloned().unwrap_or_default();
        if !want_preview {
            // 只要「源还能用吗」的答案：校验与上文完全一致，但不再合成缩略图。
            return Ok(json!({
                "epoch": current,
                "state": index,
                "label": label,
                "live": index == last,
                "width": source.size.width,
                "height": source.size.height,
                "sources": entries.len(),
            }));
        }
        let image = photocraft_compose::thumbnail(&source, max_side);
        let bytes = photocraft_paint::tile::b64_encode(&image.pixels);
        Ok(json!({
            "epoch": current,
            "state": index,
            "label": label,
            "live": index == last,
            "width": image.width,
            "height": image.height,
            "pixels": bytes,
            "sources": entries.len(),
        }))
    }

    /// 清理前的范围说明：列出会被丢弃的内容与估计释放字节，供界面展示后确认。
    ///
    /// 这些数字都必须是**这个范围真的会释放的量**，否则确认框会骗人：
    ///
    /// - `videoCache` 在本内核里没有视频图层可清（上游命令恒返回 `bytes: 0`），不能拿整份
    ///   历史的字节去吓人——用户确认后会看到「什么都没清」。
    /// - `undo` 只丢**最后一个**可撤销状态，不是整份历史。这里克隆历史（只复制指针）真的丢一次
    ///   再相减，得到的差额就是实际释放量；用整份历史字节会严重高估。
    /// - `all` 除了各文档的历史，还会丢掉剪贴板与渲染缓存（效果图/合并蒙版/智能滤镜阶段/形状
    ///   描边）。只算历史会**低报**：剪贴板往往是几百 KiB 到几 MiB。形状描边缓存没有公开的
    ///   字节读数（上游只提供「清空并返回释放量」的 `purge_cache`），因此 `all` 的 `bytes` 是
    ///   「已可测部分之和」——只会低报不会高报，用 `approximate: true` 标出来，界面按「约」呈现。
    /// - 范围可用但字节为 0 是**正常**情况（例如各状态共用同一批 tile），不能写成「当前为空」：
    ///   那会让用户以为点「确认清理」什么也不会发生，而实际会丢掉整个撤销栈。
    /// - `available` 直接问内核自己的启用判定（`disabled_reason_with`），不另写一套规则：
    ///   范围为空时确认框应该当场说「这个范围现在没有可清理的内容」，而不是让用户确认后再报
    ///   `nothing to purge`。
    pub fn history_purge_plan(&self, what: &str) -> Result<Value> {
        let (command, scope) = purge_scope(what)
            .ok_or_else(|| command_error("edit.purge", format!("未知的清理范围 `{what}`")))?;
        let state = self.active_doc()?;
        let keep_of = |doc: &photocraft_engine::DocState| -> Vec<photocraft_doc::Document> {
            doc.snapshots.iter().map(|snap| (*snap.doc).clone()).collect()
        };
        let bytes = match what {
            // 上游只清 `clipboard` 与 `style_clipboard`（后者没有像素/tile），因此只算前者。
            "clipboard" => self
                .session
                .clipboard
                .as_ref()
                .map_or(0, |clip| clip.surface.tiles().map(|(_, tile)| tile.bytes().len()).sum::<usize>()),
            // 没有视频图层时上游恒返回 0 字节：不能把历史字节算进这个范围。
            "videoCache" => 0,
            "undo" => {
                let keep = keep_of(state);
                let keep_refs: Vec<&photocraft_doc::Document> = keep.iter().collect();
                let before = state.history.unique_bytes_besides(&state.doc, &keep_refs);
                // `History` 的克隆只复制 `Arc` 指针，不复制像素；丢一次再相减就是真实差额。
                let mut dropped = state.history.clone();
                if !dropped.purge_last() {
                    return Ok(json!({
                        "command": command,
                        "scope": scope,
                        "bytes": 0,
                        "available": false,
                        "reason": "当前没有可取消的撤销记录",
                        "recoverable": false,
                        "confirm": {"required": true, "param": "confirm", "value": true},
                    }));
                }
                before.saturating_sub(dropped.unique_bytes_besides(&state.doc, &keep_refs))
            }
            // `histories` 只清各文档的历史；`all` 还会丢掉剪贴板与渲染缓存（见上游
            // `edit_menu_cmds::purge`）。两者不能共用同一个求和，否则「全部」的范围说明会**少报**
            // 用户实际会释放的量——这正是「数字必须等于实际释放量」的反例。
            "histories" => self
                .session
                .documents()
                .iter()
                .map(|doc| {
                    let keep = keep_of(doc);
                    let keep_refs: Vec<&photocraft_doc::Document> = keep.iter().collect();
                    doc.history.unique_bytes_besides(&doc.doc, &keep_refs)
                })
                .sum(),
            "all" => {
                let histories: usize = self
                    .session
                    .documents()
                    .iter()
                    .map(|doc| {
                        let keep = keep_of(doc);
                        let keep_refs: Vec<&photocraft_doc::Document> = keep.iter().collect();
                        doc.history.unique_bytes_besides(&doc.doc, &keep_refs)
                    })
                    .sum();
                let clipboard = self.session.clipboard.as_ref().map_or(0, |clip| {
                    clip.surface.tiles().map(|(_, tile)| tile.bytes().len()).sum::<usize>()
                });
                histories
                    .saturating_add(clipboard)
                    .saturating_add(photocraft_compose::effect_cache_bytes())
                    .saturating_add(photocraft_compose::masks::cache_bytes())
                    .saturating_add(photocraft_engine::smart_cmds::stack_cache_bytes())
            }
            _ => {
                let keep = keep_of(state);
                let keep_refs: Vec<&photocraft_doc::Document> = keep.iter().collect();
                state.history.unique_bytes_besides(&state.doc, &keep_refs)
            }
        };
        // 可用性问内核自己的前置条件，避免界面与命令门各写一套「什么算空」。
        let blocked = self.session.disabled_reason_with(command, &Value::Null);
        Ok(json!({
            "command": command,
            "scope": scope,
            "bytes": bytes,
            // `all` 里的形状描边缓存没有公开读数（见上面的文档注释），其余范围都是精确值。
            // 界面据此决定说「约」还是「正好」，而不是一律用约数掩盖差异。
            "approximate": what == "all",
            "available": blocked.is_none(),
            "reason": blocked,
            "recoverable": false,
            "confirm": {"required": true, "param": "confirm", "value": true},
        }))
    }

    /// 按范围清理历史/剪贴板/缓存。
    ///
    /// 必须显式 `{"confirm": true}`：没有确认时返回带范围说明的错误，**不执行任何清理**。清理
    /// 不改当前像素、修订或保存基线（上游只丢弃历史与剪贴板里的 tile），返回的 `epoch` 供历史
    /// 画笔等消费者判定旧源失效。
    pub fn history_purge(&mut self, what: &str, params: Value) -> Result<Value> {
        let plan = self.history_purge_plan(what)?;
        if params.get("confirm").and_then(Value::as_bool) != Some(true) {
            let scope = plan.get("scope").and_then(Value::as_str).unwrap_or("历史");
            return Err(command_error(
                "edit.purge",
                format!("清理「{scope}」不可恢复；请确认后再执行（confirm: true）"),
            ));
        }
        let id = plan
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| command_error("edit.purge", "未知的清理范围"))?
            .to_string();
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        if !crate::capability::command_allowed(&id) {
            return Err(EditorError::CapabilityDisabled(id));
        }
        let revision = self.active_doc()?.revision;
        let hash = self.content_hash().ok();
        let result = self
            .session
            .execute(&id, Value::Null)
            .map_err(|failure| command_error(&id, failure))?;
        let after = self.active_doc()?;
        if after.revision != revision || self.content_hash().ok() != hash {
            return Err(command_error(&id, "清理不应改变内容；已停止并保留现场"));
        }
        let state = self.history_state()?;
        Ok(json!({
            "purged": result.get("purged").cloned().unwrap_or(Value::Null),
            "freed": result.get("bytes").cloned().unwrap_or(Value::Null),
            "plan": plan,
            "history": state,
        }))
    }

    /// 动作面板视图：动作清单、录制状态、选中动作的逐步骤预检与快捷键。
    pub fn actions_state(&mut self, params: Value) -> Result<Value> {
        let mut list = self
            .session
            .execute("actions.list", Value::Null)
            .map_err(|failure| command_error("actions.list", failure))?;
        let selected = params.get("action").cloned();
        let preflight = match &selected {
            Some(action) => Some(self.actions_command("actions.get", json!({ "action": action.clone() }))?),
            None => None,
        };
        let report = match &preflight {
            Some(detail) => Some(self.actions_preflight(detail)?),
            None => None,
        };
        if let Some(object) = list.as_object_mut() {
            if let Some(detail) = preflight {
                object.insert("detail".into(), detail);
            }
            if let Some(report) = report {
                object.insert("preflight".into(), report);
            }
            object.insert("budget".into(), actions_budget());
        }
        Ok(list)
    }

    /// 逐步骤能力预检：每个步骤是否仍在命令门内、属于哪种拒绝原因。
    ///
    /// 这是播放前的能力核对：动作可能是在更早的运行时录下的，或引用了后来关闭的命令。判定规则
    /// **只在 [`crate::features::history::preflight::preflight`] 里实现一次**（先看运行时注册表，再看唯一命令门），
    /// 这里只补上动作特有的「启停」标记，避免两处规则漂移给出互相矛盾的拒绝原因。
    pub fn actions_preflight(&self, action: &Value) -> Result<Value> {
        let steps = action
            .get("steps")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| command_error("actions.get", "动作没有步骤"))?;
        let disabled: Vec<u64> = action
            .get("disabled")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(Value::as_u64).collect())
            .unwrap_or_default();
        // 播放只关心命令与参数；参数在这里不参与能力判定。
        let pairs: Vec<(String, Value)> = steps
            .iter()
            .map(|step| {
                let pair = step.as_array();
                let id = pair
                    .and_then(|pair| pair.first())
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let params = pair.and_then(|pair| pair.get(1)).cloned().unwrap_or(Value::Null);
                (id, params)
            })
            .collect();
        let report: Vec<Value> = crate::features::history::preflight::preflight(&pairs)
            .into_iter()
            .map(|row| {
                json!({
                    "step": row.step,
                    "id": row.id,
                    "enabled": !disabled.contains(&(row.step as u64)),
                    "playable": row.playable,
                    "reason": row.reason,
                })
            })
            .collect();
        let blocked: Vec<Value> = report
            .iter()
            .filter(|row| row.get("playable").and_then(Value::as_bool) == Some(false))
            .cloned()
            .collect();
        Ok(json!({ "steps": report, "blocked": blocked, "playable": blocked.is_empty() }))
    }

    /// 录制/停止：录制只收成功提交的规范命令（上游 `journal` 语义），查询与动作编辑不收。
    pub fn actions_record(&mut self, params: Value) -> Result<Value> {
        if params.get("stop").and_then(Value::as_bool) == Some(true) {
            return self.actions_command("actions.stop", Value::Null);
        }
        self.actions_command("actions.record", params)
    }

    /// 播放动作：先逐步骤能力预检，再一步一个已有命令事务（失败停在明确步骤，已成功结果保留）。
    pub fn actions_play(&mut self, params: Value) -> Result<Value> {
        let action = params
            .get("action")
            .cloned()
            .ok_or_else(|| command_error("actions.play", "缺少 action"))?;
        let detail = self
            .session
            .execute("actions.get", json!({ "action": action.clone() }))
            .map_err(|failure| command_error("actions.get", failure))?;
        let preflight = self.actions_preflight(&detail)?;
        if preflight.get("playable").and_then(Value::as_bool) != Some(true) {
            let blocked = preflight.get("blocked").cloned().unwrap_or(Value::Array(Vec::new()));
            return Err(command_error(
                "actions.play",
                format!("动作里有步骤在当前运行时不可播放：{blocked}"),
            ));
        }
        let mut result = self.actions_command("actions.play", params)?;
        if let Some(object) = result.as_object_mut() {
            object.insert("preflight".into(), preflight);
        }
        Ok(result)
    }

    /// 动作编辑命令的统一入口（含 `actions.insert` / `actions.conditional` / 动作集）。
    pub fn actions_command(&mut self, id: &str, params: Value) -> Result<Value> {
        if !ACTION_COMMANDS.contains(&id) {
            return Err(EditorError::CapabilityDisabled(id.into()));
        }
        if !crate::capability::command_allowed(id) {
            return Err(EditorError::CapabilityDisabled(id.into()));
        }
        self.session
            .execute(id, params)
            .map_err(|failure| command_error(id, failure))
    }

    /// ATN 导入（**字节入口**）：浏览器没有可写路径，`path` 一律拒绝。
    ///
    /// `data` 是 base64 的 `.atn` 字节（与上游 `actions.load` 同一参数）。导入后如果有当前运行时
    /// 无法播放的 Photoshop 步骤，默认**整组回滚**并报告明细；只有显式 `acceptUnsupported: true`
    /// 才保留这些步骤（它们会在播放时按步骤名失败，而不是静默跳过）。
    pub fn actions_load(&mut self, params: Value) -> Result<Value> {
        if !crate::capability::command_allowed("actions.load") {
            return Err(EditorError::CapabilityDisabled("actions.load".into()));
        }
        if params.get("path").is_some_and(|value| !value.is_null()) {
            return Err(command_error("actions.load", "浏览器里不能按路径读取 .atn；请传 data（base64 字节）"));
        }
        let data = params
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| command_error("actions.load", "缺少 data（.atn 的 base64 字节）"))?;
        // 预算按**解码后**字节判定：base64 让字符串长度多出 4/3，用字符串长度当预算会漏放。
        let size = photocraft_paint::tile::b64_decode(data)
            .map(|bytes| bytes.len())
            .ok_or_else(|| command_error("actions.load", "data 不是合法 base64"))?;
        if size == 0 {
            return Err(command_error("actions.load", "data 是空文件"));
        }
        if size > MAX_ATN_BYTES {
            return Err(command_error(
                "actions.load",
                format!("`.atn` 超过上限（{} MiB）", MAX_ATN_BYTES / 1024 / 1024),
            ));
        }
        let accept = params.get("acceptUnsupported").and_then(Value::as_bool).unwrap_or(false);
        let mut forward = params.clone();
        if let Some(object) = forward.as_object_mut() {
            object.remove("acceptUnsupported");
        }
        let before: Vec<String> = self
            .session
            .actions
            .list
            .iter()
            .map(|action| action.name.clone())
            .collect();
        let loaded = self
            .session
            .execute("actions.load", forward)
            .map_err(|failure| command_error("actions.load", failure))?;
        let unsupported = loaded
            .get("unsupported")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if !unsupported.is_empty() && !accept {
            // 整组回滚：删除这次导入新增的动作，保持导入前的动作清单。
            let added: Vec<String> = self
                .session
                .actions
                .list
                .iter()
                .map(|action| action.name.clone())
                .filter(|name| !before.contains(name))
                .collect();
            for name in &added {
                let _ = self.session.execute("actions.delete", json!({ "action": name }));
            }
            let leftover: Vec<String> = self
                .session
                .actions
                .list
                .iter()
                .map(|action| action.name.clone())
                .filter(|name| !before.contains(name))
                .collect();
            let first = unsupported.first().cloned().unwrap_or(Value::Null);
            let event = first.get("event").and_then(Value::as_str).unwrap_or("?");
            let message = if leftover.is_empty() {
                format!(
                    "有 {} 个 Photoshop 步骤在当前运行时没有等价命令，已整组取消导入（首个：{event}）。可改用 acceptUnsupported: true 保留并逐个核对",
                    unsupported.len()
                )
            } else {
                format!(
                    "有 {} 个 Photoshop 步骤在当前运行时没有等价命令，且动作 `{leftover:?}` 未能回滚；请手动删除这些动作后重试",
                    unsupported.len()
                )
            };
            return Err(command_error("actions.load", message));
        }
        Ok(json!({
            "set": loaded.get("set").cloned().unwrap_or(Value::Null),
            "actions": loaded.get("actions").cloned().unwrap_or(Value::Null),
            "steps": loaded.get("steps").cloned().unwrap_or(Value::Null),
            "unsupported": unsupported,
            "warnings": loaded.get("warnings").cloned().unwrap_or(Value::Null),
            "accepted": accept,
            "data": data.len(),
        }))
    }

    /// ATN 导出（**字节入口**）：只返回 base64 `data`，不接受 `path`。
    pub fn actions_save(&mut self, params: Value) -> Result<Value> {
        if !crate::capability::command_allowed("actions.save") {
            return Err(EditorError::CapabilityDisabled("actions.save".into()));
        }
        if params.get("path").is_some_and(|value| !value.is_null()) {
            return Err(command_error("actions.save", "浏览器里不能写路径；省略 path 以取回 base64 data"));
        }
        let result = self.actions_command("actions.save", params)?;
        let data = result
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| command_error("actions.save", "运行时没有返回 data"))?;
        let size = photocraft_paint::tile::b64_decode(data).map_or(0, |bytes| bytes.len());
        if size == 0 {
            return Err(command_error("actions.save", "导出的 .atn 是空文件"));
        }
        if size > MAX_ATN_BYTES {
            return Err(command_error(
                "actions.save",
                format!("`.atn` 超过上限（{} MiB）", MAX_ATN_BYTES / 1024 / 1024),
            ));
        }
        Ok(result)
    }

    /// 动作集/快捷键绑定摘要（`actions.play:<name>` → 键位），供面板显示与冲突提示。
    pub fn actions_shortcuts(&self) -> Value {
        let prefix = photocraft_engine::actions_cmds::PLAY_SHORTCUT_PREFIX;
        let mut rows: Vec<Value> = self
            .session
            .prefs()
            .shortcuts
            .iter()
            .filter_map(|(id, key)| {
                id.strip_prefix(prefix)
                    .map(|name| json!({ "action": name, "shortcut": key, "binding": id }))
            })
            .collect();
        rows.sort_by(|a, b| a["action"].as_str().cmp(&b["action"].as_str()));
        json!({ "prefix": prefix, "bindings": rows })
    }
}

/// 本域历史类命令的允许清单（域内入口的第二道校验）。
pub const HISTORY_COMMANDS: &[&str] = &[
    "history.newSnapshot",
    "history.selectSnapshot",
    "history.renameSnapshot",
    "history.deleteSnapshot",
    "history.deleteState",
    "history.newDocument",
];

/// 动作命令的允许清单（不含路径读写）。
pub const ACTION_COMMANDS: &[&str] = &[
    "actions.list",
    "actions.get",
    "actions.record",
    "actions.stop",
    "actions.play",
    "actions.delete",
    "actions.move",
    "actions.rename",
    "actions.toggle",
    "actions.dialog",
    "actions.setColor",
    "actions.insert",
    "actions.conditional",
    "actions.assignSet",
    "actions.load",
    "actions.save",
    "actions.stopMessage",
    "actions.photoshopStep",
];

/// 动作与步骤的预算（面板据此拒绝超大动作，不抬高全局上限）。
pub fn actions_budget() -> Value {
    json!({ "maxActions": MAX_ACTIONS, "maxStepsPerAction": MAX_ACTION_STEPS, "maxAtnBytes": MAX_ATN_BYTES })
}

/// 历史源采样预览的边长上限（像素只在这条读取路径上分配）。
pub const MAX_SAMPLE_SIDE: u32 = 2048;
/// 历史源采样未指定时的预览边长。
pub const DEFAULT_SAMPLE_SIDE: u32 = 256;

/// 单个会话最多保留的动作数。
pub const MAX_ACTIONS: usize = 256;
/// 单个动作最多步骤数（含录制中的待定步骤）。
pub const MAX_ACTION_STEPS: usize = 2048;
/// `.atn` 导入/导出的字节上限（8 MiB）。
pub const MAX_ATN_BYTES: usize = 8 * 1024 * 1024;

/// 历史源身份 = 文档身份 + 状态标签序列 + 重做标签序列。
///
/// 消费者（历史画笔）只比较 `epoch` 就能判断某个旧源是否仍然有效；不能只比索引，因为清理后
/// 同一个索引会指向不同内容。三处成分都是刻意的：
///
/// - **文档身份**：句柄是「某个文档里的某一格」。只按标签摘要的话，两份历史列表相同的文档会
///   算出同一个 `epoch`，消费者缓存的源会被跨文档当成有效，「取样 A 的归档状态」可能落到 B 上。
/// - **不含 `revision`**：修订号在任何内容编辑时都会变，包括**不产生历史步骤**的 `set_vars`；
///   而归档状态本身没变。把它算进来会把有效源误判为失效，历史画笔会在用户只改了个变量之后
///   丢掉本来可用的源。真正让归档失效的是状态序列变化，由下面两段覆盖。
/// - **重做标签**：撤销后重做区内容不同，但 `entries` 可能恢复成同一串，必须一起摘要。
pub fn history_epoch(document: u64, entries: &[String], redo: &[String]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(document.to_le_bytes());
    hasher.update([2]);
    for entry in entries {
        hasher.update(entry.as_bytes());
        hasher.update([0]);
    }
    hasher.update([1]);
    for entry in redo {
        hasher.update(entry.as_bytes());
        hasher.update([0]);
    }
    hasher.finalize()[..8].iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
#[path = "tests_workflows.rs"]
mod workflow_tests;

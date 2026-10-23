//! U74/U75/U76 的 wasm 绑定（change: 2026-10-22-add-photocraft-history-automation-workflows）。
//!
//! 与其它域一致：只做 `String`/`u32` 的参数转换，业务规则全在 [`crate::editor::Editor`] 上，
//! 因此同一套逻辑可以原生测试。字节一律以 base64 字符串跨界（ATN、输入图片、交付文件），
//! 路径参数不会出现在这一层。
use super::*;

#[wasm_bindgen]
impl WasmEditor {
    // ---- U74：历史快照、自历史新建、清理 ----

    /// 历史面板视图（状态、重做、快照、来源句柄）。
    #[wasm_bindgen(js_name = historyStateJson)]
    pub fn history_state_json(&self) -> Result<String, JsValue> {
        self.inner.history_state().map(|value| value.to_string()).map_err(|e| js_error(&e))
    }

    /// 历史类命令的统一入口（`history.newSnapshot` 等）。
    #[wasm_bindgen(js_name = historyCommand)]
    pub fn history_command(&mut self, id: &str, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .history_command(id, parse_params(params_json)?)
            .map(|value| value.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 新建命名快照。
    #[wasm_bindgen(js_name = newSnapshot)]
    pub fn new_snapshot(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .history_new_snapshot(parse_params(params_json)?)
            .map(|value| value.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 回到某个快照（作为可撤销的一步）。
    #[wasm_bindgen(js_name = selectSnapshot)]
    pub fn select_snapshot(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .history_select_snapshot(parse_params(params_json)?)
            .map(|value| value.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 重命名快照。
    #[wasm_bindgen(js_name = renameSnapshot)]
    pub fn rename_snapshot(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .history_rename_snapshot(parse_params(params_json)?)
            .map(|value| value.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 删除快照。
    #[wasm_bindgen(js_name = deleteSnapshot)]
    pub fn delete_snapshot(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .history_delete_snapshot(parse_params(params_json)?)
            .map(|value| value.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 删除某个历史状态及其后的全部状态。
    #[wasm_bindgen(js_name = deleteState)]
    pub fn delete_state(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .history_delete_state(parse_params(params_json)?)
            .map(|value| value.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 从某个历史状态建立独立新文档。
    #[wasm_bindgen(js_name = newDocumentFromHistory)]
    pub fn new_document_from_history(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .history_new_document(parse_params(params_json)?)
            .map(|value| value.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 清理前的范围说明（不改任何内容）。
    #[wasm_bindgen(js_name = purgePlanJson)]
    pub fn purge_plan_json(&self, what: &str) -> Result<String, JsValue> {
        self.inner.history_purge_plan(what).map(|value| value.to_string()).map_err(|e| js_error(&e))
    }

    /// 取样某个历史源（`epoch` 校验不过就拒绝，不按旧索引返回新内容）。
    #[wasm_bindgen(js_name = sampleHistory)]
    pub fn sample_history(&self, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .history_sample(parse_params(params_json)?)
            .map(|value| value.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 按范围清理；缺少 `confirm: true` 时返回说明范围的错误且不执行。
    #[wasm_bindgen(js_name = purge)]
    pub fn purge(&mut self, what: &str, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .history_purge(what, parse_params(params_json)?)
            .map(|value| value.to_string())
            .map_err(|e| js_error(&e))
    }

    // ---- U75：动作录制、播放、ATN ----

    /// 动作面板视图（可选 `{action}` 带上详情）。
    #[wasm_bindgen(js_name = actionsStateJson)]
    pub fn actions_state_json(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.actions_state(parse_params(params_json)?).map(|value| value.to_string()).map_err(|e| js_error(&e))
    }

    /// 开始/停止录制（`{stop: true}` 等价于停止）。
    #[wasm_bindgen(js_name = recordAction)]
    pub fn record_action(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.actions_record(parse_params(params_json)?).map(|value| value.to_string()).map_err(|e| js_error(&e))
    }

    /// 播放动作：先逐步骤预检，再逐步骤提交。
    #[wasm_bindgen(js_name = playAction)]
    pub fn play_action(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.actions_play(parse_params(params_json)?).map(|value| value.to_string()).map_err(|e| js_error(&e))
    }

    /// 动作编辑命令（重命名、移动、条件、动作集等）。
    #[wasm_bindgen(js_name = actionCommand)]
    pub fn action_command(&mut self, id: &str, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .actions_command(id, parse_params(params_json)?)
            .map(|value| value.to_string())
            .map_err(|e| js_error(&e))
    }

    /// ATN 导入（base64 `data`；不接受路径）。
    #[wasm_bindgen(js_name = loadActions)]
    pub fn load_actions(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.actions_load(parse_params(params_json)?).map(|value| value.to_string()).map_err(|e| js_error(&e))
    }

    /// ATN 导出（返回 base64 `data`；不接受路径）。
    #[wasm_bindgen(js_name = saveActions)]
    pub fn save_actions(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.actions_save(parse_params(params_json)?).map(|value| value.to_string()).map_err(|e| js_error(&e))
    }

    /// 动作快捷键绑定（`actions.play:<name>` → 键位）。
    #[wasm_bindgen(js_name = actionShortcutsJson)]
    pub fn action_shortcuts_json(&self) -> String {
        self.inner.actions_shortcuts().to_string()
    }

    // ---- U76：变量、数据集与前台自动化 ----

    /// 变量与数据集视图。
    #[wasm_bindgen(js_name = variablesStateJson)]
    pub fn variables_state_json(&mut self) -> Result<String, JsValue> {
        self.inner.variables_state().map(|value| value.to_string()).map_err(|e| js_error(&e))
    }

    /// 定义变量。
    #[wasm_bindgen(js_name = defineVariables)]
    pub fn define_variables(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.variables_define(parse_params(params_json)?).map(|value| value.to_string()).map_err(|e| js_error(&e))
    }

    /// 直接设置数据集。
    #[wasm_bindgen(js_name = setDataSets)]
    pub fn set_data_sets(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.data_sets_set(parse_params(params_json)?).map(|value| value.to_string()).map_err(|e| js_error(&e))
    }

    /// 由 CSV 文本导入数据集。
    #[wasm_bindgen(js_name = importDataSets)]
    pub fn import_data_sets(&mut self, params_json: &str, csv_text: &str) -> Result<String, JsValue> {
        self.inner
            .data_sets_import(parse_params(params_json)?, csv_text)
            .map(|value| value.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 导出数据集为 CSV 文本。
    #[wasm_bindgen(js_name = exportDataSetsCsv)]
    pub fn export_data_sets_csv(&self) -> Result<String, JsValue> {
        self.inner.data_sets_export_csv().map(|value| value.to_string()).map_err(|e| js_error(&e))
    }

    /// 应用数据集（像素变量由 `images` 交 base64 字节）。
    #[wasm_bindgen(js_name = applyDataSet)]
    pub fn apply_data_set(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.data_sets_apply(parse_params(params_json)?).map(|value| value.to_string()).map_err(|e| js_error(&e))
    }

    /// 把每个数据集导出为编码字节（base64，不写目录）。
    #[wasm_bindgen(js_name = exportDataSetsAsFiles)]
    pub fn export_data_sets_as_files(&self, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .data_sets_export_files(parse_params(params_json)?)
            .map(|value| value.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 规划前台队列（batch / imageProcessor / contactSheet / loadStack）。
    #[wasm_bindgen(js_name = beginBatch)]
    pub fn begin_batch(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.batch_begin(parse_params(params_json)?).map(|value| value.to_string()).map_err(|e| js_error(&e))
    }

    /// 推进一项并返回逐项进度。
    #[wasm_bindgen(js_name = stepBatch)]
    pub fn step_batch(&mut self, queue: u32) -> Result<String, JsValue> {
        self.inner.batch_step(u64::from(queue)).map(|value| value.to_string()).map_err(|e| js_error(&e))
    }

    /// 取消队列：剩余项不再启动，已完成结果保留。
    #[wasm_bindgen(js_name = cancelBatch)]
    pub fn cancel_batch(&mut self, queue: u32) -> String {
        self.inner.batch_cancel(u64::from(queue)).to_string()
    }

    /// 收尾并取回逐项报告（队列随后移除）。
    #[wasm_bindgen(js_name = finishBatch)]
    pub fn finish_batch(&mut self, queue: u32) -> String {
        self.inner.batch_finish(u64::from(queue)).to_string()
    }

    /// 领取某一项结果的字节（base64）。
    #[wasm_bindgen(js_name = takeBatchFile)]
    pub fn take_batch_file(&mut self, queue: u32, index: u32) -> Result<String, JsValue> {
        self.inner
            .batch_take(u64::from(queue), index as usize)
            .map(|value| value.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 队列状态。
    #[wasm_bindgen(js_name = batchStateJson)]
    pub fn batch_state_json(&self, queue: u32) -> String {
        self.inner.batch_state(u64::from(queue)).to_string()
    }

    /// 受限声明式脚本（只接受已开放命令，执行前整组预检）。
    #[wasm_bindgen(js_name = runScript)]
    pub fn run_script(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.script_run(parse_params(params_json)?).map(|value| value.to_string()).map_err(|e| js_error(&e))
    }
}

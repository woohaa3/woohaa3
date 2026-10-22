/**
 * Input Scope Service（change: adopt-frontend-cordis-plugin-runtime，design D3）。
 *
 * 统一 modal/menu/editor/画布的 keyboard、paste、drop 和 pointer 门禁。各功能注册
 * 自己的门禁谓词；画布交互只问 `blocksCanvas()`，不再从 Dialog/菜单模块反向 import。
 */
import type { InputScope, InputScopesService } from "../contracts.js";

const CANVAS_SCOPES: readonly InputScope[] = ["modal", "menu", "editor"];

export class InputScopeService implements InputScopesService {
  private readonly gates = new Set<{ scope: InputScope; predicate: () => boolean }>();

  addScope(scope: InputScope, gate: () => boolean): () => void {
    const entry = { scope, predicate: gate };
    this.gates.add(entry);
    return () => {
      this.gates.delete(entry);
    };
  }

  addGate(gate: () => boolean): () => void {
    return this.addScope("modal", gate);
  }

  isActive(scope: InputScope): boolean {
    for (const entry of this.gates) {
      if (entry.scope !== scope) continue;
      if (entry.predicate()) return true;
    }
    return false;
  }

  /** 任一画布相关 scope 激活时，画布 pointer/keyboard/paste/drop 门禁为 true。 */
  blocksCanvas(): boolean {
    for (const scope of CANVAS_SCOPES) {
      if (this.isActive(scope)) return true;
    }
    return false;
  }

  /**
   * 聚焦相机输入门禁：只有真正的 modal Dialog 才阻断 focus 缩放/观察
   * （change: fix-model-focus-navigation-and-camera-parity，design D6）。
   * 非模态 editor/history panel 与 menu 不阻断 focus camera input。
   */
  blocksFocusInput(): boolean {
    return this.isActive("modal");
  }
}

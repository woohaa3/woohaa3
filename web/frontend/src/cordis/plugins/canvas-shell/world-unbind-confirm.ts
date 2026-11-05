/**
 * 模型移出导演区时，动画脚本解绑的确认框桥。
 *
 * 交互手势只依赖一个可替换的 async 确认函数；canvas-runtime 插件挂载时把它接到
 * 共享 AlertDialog，测试/最小宿主可用 setWorldUnbindConfirmer 注入。
 */

export type WorldUnbindConfirmInput = {
  title: string;
  description: string;
  confirmLabel: string;
};

type WorldUnbindConfirmer = (input: WorldUnbindConfirmInput) => Promise<boolean>;

let confirmer: WorldUnbindConfirmer | null = null;

export function setWorldUnbindConfirmer(next: WorldUnbindConfirmer | null): void {
  confirmer = next;
}

export function confirmWorldUnbind(input: WorldUnbindConfirmInput): Promise<boolean> {
  return confirmer ? confirmer(input) : Promise.resolve(false);
}

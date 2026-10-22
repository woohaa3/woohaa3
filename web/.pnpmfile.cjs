const path = require("node:path");

module.exports = {
  hooks: {
    updateConfig(config) {
      return {
        ...config,
        // 共享工作区跨多个源码根，锁文件放在源码目录外；不依赖执行命令的位置。
        lockfileDir: path.resolve(__dirname, "../locks/web"),
        // pnpm 11 的快速安装检查会把缺失的锁文件恢复到工作区根，跳过自定义位置。
        optimisticRepeatInstall: false
      };
    }
  }
};

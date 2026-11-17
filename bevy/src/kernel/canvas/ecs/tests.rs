//! ECS 投影/批处理的跨模块回归（change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs）。
//!
//! 具体用例随任务推进补充：投影生命周期见 `projection` 内联测试；本文件放置需要真实
//! producer/flush 调度的集成回归（选中描边批次、第三方 presentation fixture、资源回收）。

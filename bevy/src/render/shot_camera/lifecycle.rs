//! Shot camera preview 资源生命周期与就绪转发
//! （自 `runtime.rs` 拆出；change: 2026-10-15-add-film-set-shooting-shot-previews，design D7）。
//!
//! 拥有 rig 子资源的创建/释放与窗口相机收敛，以及把宿主写在 rig 上的
//! [`super::preview_readiness::ShotPreviewReadiness`] 转发到本模块内部创建的预览相机。
//! 派生与采样推进仍在 [`super::runtime`]。

use bevy::{
    asset::RenderAssetUsages,
    camera::RenderTarget,
    prelude::*,
    render::render_resource::{Extent3d, TextureDimension, TextureFormat, TextureUsages},
};

use super::runtime::ShotCameraRegistry;
use super::{ShotCameraInner, ShotPreviewCamera};

/// 同一个窗口只保留当前 rig 记录的那一台预览相机。
///
/// 泄漏的相机会和它共用 order 5，Bevy 每帧报 camera order ambiguity，透明通道也会变成
/// `InvalidViewQuery`。
pub(crate) fn collapse_window_preview_cameras(
    mut commands: Commands,
    inners: Query<&ShotCameraInner>,
    cameras: Query<(Entity, &Camera, &RenderTarget), With<ShotPreviewCamera>>,
) {
    let mut referenced = std::collections::HashSet::new();
    for inner in &inners {
        if let Some(camera) = inner.preview_camera {
            referenced.insert(camera);
        }
    }
    let mut active_window = Vec::new();
    for (entity, camera, target) in &cameras {
        let window = matches!(target, RenderTarget::Window(_));
        if !window {
            continue;
        }
        if !referenced.contains(&entity) {
            commands.entity(entity).try_despawn();
            continue;
        }
        if camera.is_active {
            active_window.push(entity);
        }
    }
    for extra in active_window.into_iter().skip(1) {
        commands.entity(extra).try_despawn();
    }
}

/// 创建持久 render-target Image（可作渲染附件、copy src 与纹理绑定）。
pub(crate) fn create_preview_image(images: &mut Assets<Image>, size: UVec2) -> Handle<Image> {
    let extent = Extent3d {
        width: size.x.max(1),
        height: size.y.max(1),
        ..default()
    };
    let mut image = Image::new_uninit(
        extent,
        TextureDimension::D2,
        TextureFormat::Rgba8UnormSrgb,
        RenderAssetUsages::MAIN_WORLD | RenderAssetUsages::RENDER_WORLD,
    );
    image.texture_descriptor.usage |=
        TextureUsages::COPY_SRC | TextureUsages::RENDER_ATTACHMENT | TextureUsages::TEXTURE_BINDING;
    images.add(image)
}

/// 释放已被 despawn / 移除 preview 组件的 rig 的子资源。
pub(crate) fn cleanup_shot_camera_inner(
    mut commands: Commands,
    images: Option<ResMut<Assets<Image>>>,
    mut registry: ResMut<ShotCameraRegistry>,
    mut inner: Query<&mut ShotCameraInner>,
    mut removed_preview: RemovedComponents<super::ShotCameraPreview>,
) {
    let mut images = images;
    // 移除 preview 组件：释放 preview 相机与 Image，但保留 rig。
    for entity in removed_preview.read() {
        let Ok(mut inner) = inner.get_mut(entity) else {
            continue;
        };
        if let Some(images) = images.as_deref_mut() {
            release_preview(&mut commands, images, &mut inner);
        }
        commands.entity(entity).remove::<super::ShotPreviewOutput>();
    }
    // despawn 的 rig：`commands.get_entity` 对同一帧内新 spawn 的实体仍返回 Ok，
    // 因此只清理确实不存在的实体，避免误删本帧刚创建的 rig。
    let stale: Vec<Entity> = registry
        .rigs
        .iter()
        .copied()
        .filter(|entity| commands.get_entity(*entity).is_err())
        .collect();
    for entity in stale {
        registry.rigs.retain(|entry| *entry != entity);
    }
}

/// 把宿主写在 rig 上的 [`super::preview_readiness::ShotPreviewReadiness`] 复制到实际预览相机。
///
/// 只有相机才会被提取出 `ExtractedView`，而预览相机由 `runtime` 内部创建，宿主拿不到其实体；
/// 因此由本系统做一次转发。rig 未启用 preview 或相机尚未创建时清除相机残留。
pub(crate) fn publish_preview_readiness(
    mut commands: Commands,
    rigs: Query<(
        Option<&super::preview_readiness::ShotPreviewReadiness>,
        &ShotCameraInner,
    )>,
) {
    for (readiness, inner) in &rigs {
        let Some(camera) = inner.preview_camera else {
            continue;
        };
        match readiness {
            Some(readiness) => {
                // Readiness counts CPU-readable phase bins. Bevy keeps the
                // multidraw instance counts private, so a GPU-indirect preview
                // can draw successfully yet never pass that gate. Only views
                // opting into readiness need direct drawing, as capture does.
                commands.entity(camera).insert((
                    super::preview_readiness::ShotPreviewView {
                        key: readiness.key,
                        generation: readiness.generation,
                        meshes: readiness.meshes.clone(),
                        materials: readiness.materials.clone(),
                    },
                    bevy::render::view::NoIndirectDrawing,
                ));
            }
            None => {
                commands.entity(camera).remove::<(
                    super::preview_readiness::ShotPreviewView,
                    bevy::render::view::NoIndirectDrawing,
                )>();
            }
        }
    }
}

/// 释放一个 rig 的 preview 相机与 Image 引用。
pub(crate) fn release_preview(
    commands: &mut Commands,
    _images: &mut Assets<Image>,
    inner: &mut ShotCameraInner,
) {
    if let Some(camera) = inner.preview_camera.take() {
        commands.entity(camera).try_despawn();
    }
    // 丢弃本 rig 的强引用。已发布的 Sprite 可能仍显示旧图，不能强制移除资产；
    // 最后一个 Handle 释放后，由 Bevy 的资产生命周期自动回收。
    inner.preview_image.take();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn releasing_target_keeps_published_image_until_last_handle_drops() {
        use bevy::asset::{AssetApp, AssetPlugin};
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, AssetPlugin::default()));
        app.init_asset::<Image>();
        let image = app
            .world_mut()
            .resource_mut::<Assets<Image>>()
            .add(Image::default());
        let id = image.id();
        let published = image.clone();
        let mut inner = ShotCameraInner {
            preview_image: Some(image),
            ..default()
        };
        let world = World::new();
        let mut queue = bevy::ecs::world::CommandQueue::default();
        release_preview(
            &mut Commands::new(&mut queue, &world),
            &mut app.world_mut().resource_mut::<Assets<Image>>(),
            &mut inner,
        );
        assert!(inner.preview_image.is_none());
        app.update();
        app.update();
        assert!(
            app.world().resource::<Assets<Image>>().contains(id),
            "已显示的旧图仍有引用"
        );
        drop(published);
        app.update();
        app.update();
        assert!(
            !app.world().resource::<Assets<Image>>().contains(id),
            "最后引用释放后自动回收"
        );
    }
}

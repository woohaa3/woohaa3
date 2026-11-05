//! Same-device editor textures. No viewport pixels cross the WebView boundary.
use crate::document_editor::EditorFrame;
use bevy::{
    asset::{RenderAssetUsages, uuid_handle},
    camera::visibility::RenderLayers,
    mesh::MeshVertexBufferLayoutRef,
    prelude::*,
    render::{RenderApp, render_asset::RenderAssets, render_resource::*, texture::GpuImage},
    shader::ShaderRef,
    sprite_render::{AlphaMode2d, Material2d, Material2dKey, Material2dPipeline, Material2dPlugin},
};
const LAYER: usize = 29;
const SHADER: Handle<Shader> = uuid_handle!("b42b480f-45b2-4378-a793-74558d4fc2b0");
#[derive(Asset, TypePath, AsBindGroup, Clone)]
struct EditorMaterial {
    #[texture(0)]
    #[sampler(1)]
    image: Handle<Image>,
    #[uniform(2)]
    backdrop: Vec4,
}
impl Material2d for EditorMaterial {
    fn fragment_shader() -> ShaderRef {
        SHADER.into()
    }
    fn alpha_mode(&self) -> AlphaMode2d {
        AlphaMode2d::Blend
    }
    fn specialize(
        _: &Material2dPipeline,
        descriptor: &mut RenderPipelineDescriptor,
        _: &MeshVertexBufferLayoutRef,
        _: Material2dKey<Self>,
    ) -> Result<(), SpecializedMeshPipelineError> {
        if let Some(fragment) = &mut descriptor.fragment {
            for target in fragment.targets.iter_mut().flatten() {
                target.blend = Some(BlendState::PREMULTIPLIED_ALPHA_BLENDING);
            }
        }
        Ok(())
    }
}
#[derive(Resource)]
struct Surfaces {
    camera: Entity,
    mesh: Handle<Mesh>,
    items: Vec<(Entity, Handle<Image>, Handle<EditorMaterial>)>,
}
pub(crate) fn install(app: &mut App) {
    app.add_plugins(Material2dPlugin::<EditorMaterial>::default());
    woohaa_bevy_canvas::document_editor_visibility::install(app);
    crate::canvas_suspension::install(app);
    app.world_mut()
        .resource_mut::<Assets<Shader>>()
        .insert(
            SHADER.id(),
            Shader::from_wgsl(
                include_str!("editor_compositor.wgsl"),
                "native-editor-compositor.wgsl",
            ),
        )
        .expect("static shader ID");
    let mesh = app
        .world_mut()
        .resource_mut::<Assets<Mesh>>()
        .add(Rectangle::new(1., 1.));
    let camera = app
        .world_mut()
        .spawn((
            Camera2d,
            crate::canvas_suspension::EditorCamera,
            Camera {
                order: 10,
                is_active: false,
                clear_color: ClearColorConfig::Custom(Color::srgb(0.15, 0.15, 0.15)),
                ..default()
            },
            RenderLayers::layer(LAYER),
        ))
        .id();
    app.insert_resource(Surfaces {
        camera,
        mesh,
        items: Vec::new(),
    });
}
pub(crate) fn present(app: &mut App, frame: Option<EditorFrame>, origin: [f64; 2], scale: f64) {
    let Some(mut surfaces) = app.world_mut().remove_resource::<Surfaces>() else {
        return;
    };
    let visible = frame.is_some();
    if !visible {
        app.world_mut()
            .resource_mut::<woohaa_bevy_canvas::document_editor_visibility::NativeEditorTarget>()
            .0 = None;
    }
    if let Some(mut camera) = app.world_mut().get_mut::<Camera>(surfaces.camera) {
        camera.is_active = visible;
    }
    for (entity, _, _) in &surfaces.items {
        if let Some(mut v) = app.world_mut().get_mut::<Visibility>(*entity) {
            *v = Visibility::Hidden;
        }
    }
    if let Some(frame) = frame {
        let window_size = app
            .world_mut()
            .query::<&Window>()
            .iter(app.world())
            .next()
            .map(|w| Vec2::new(w.width(), w.height()))
            .unwrap_or(Vec2::ZERO);
        let rect = frame.document_rect_css;
        let app_target_is_unbound = app
            .world()
            .resource::<woohaa_bevy_canvas::document_editor_visibility::NativeEditorTarget>()
            .0
            .is_none();
        for (index, texture) in [frame.document_texture, frame.ui_texture]
            .into_iter()
            .enumerate()
        {
            let Some(texture) = texture else { continue };
            while surfaces.items.len() <= index {
                let image = app
                    .world_mut()
                    .resource_mut::<Assets<Image>>()
                    .add(Image::new_uninit(
                        Extent3d {
                            width: 1,
                            height: 1,
                            depth_or_array_layers: 1,
                        },
                        TextureDimension::D2,
                        TextureFormat::Rgba8Unorm,
                        RenderAssetUsages::MAIN_WORLD,
                    ));
                let material = app
                    .world_mut()
                    .resource_mut::<Assets<EditorMaterial>>()
                    .add(EditorMaterial {
                        image: image.clone(),
                        backdrop: Vec4::ZERO,
                    });
                let entity = app
                    .world_mut()
                    .spawn((
                        Mesh2d(surfaces.mesh.clone()),
                        MeshMaterial2d(material.clone()),
                        RenderLayers::layer(LAYER),
                        Visibility::Hidden,
                    ))
                    .id();
                surfaces.items.push((entity, image, material));
            }
            let (entity, image, material) = &surfaces.items[index];
            // GpuImage identity alternates with the provider slots; invalidate the
            // material bind group even though its public Image handle is stable.
            if let Some(mut value) = app
                .world_mut()
                .resource_mut::<Assets<EditorMaterial>>()
                .get_mut(material)
            {
                value.image = image.clone();
                value.backdrop = if index == 0 && app_target_is_unbound {
                    Vec4::new(0.019382, 0.019382, 0.019382, 1.)
                } else {
                    Vec4::ZERO
                };
            }
            let size = if index == 0 {
                Vec2::new(rect[2] as f32, rect[3] as f32)
            } else {
                Vec2::new(
                    texture.width() as f32 / scale as f32,
                    texture.height() as f32 / scale as f32,
                )
            };
            let start = Vec2::new(origin[0] as f32, origin[1] as f32)
                + if index == 0 {
                    Vec2::new(rect[0] as f32, rect[1] as f32)
                } else {
                    Vec2::ZERO
                };
            app.world_mut().entity_mut(*entity).insert((
                Transform::from_xyz(
                    start.x + size.x / 2. - window_size.x / 2.,
                    window_size.y / 2. - start.y - size.y / 2.,
                    index as f32,
                )
                .with_scale(size.extend(1.)),
                Visibility::Visible,
            ));
            let descriptor = TextureDescriptor {
                label: Some("native-editor-shared"),
                size: texture.size(),
                mip_level_count: 1,
                sample_count: 1,
                dimension: TextureDimension::D2,
                format: texture.format(),
                usage: texture.usage(),
                view_formats: &[],
            };
            let view = texture.create_view(&TextureViewDescriptor::default());
            let render = app.sub_app_mut(RenderApp).world_mut();
            let sampler = render
                .resource::<bevy::render::renderer::RenderDevice>()
                .create_sampler(&SamplerDescriptor::default());
            render.resource_mut::<RenderAssets<GpuImage>>().insert(
                image.id(),
                GpuImage {
                    texture,
                    texture_view: view,
                    sampler,
                    texture_descriptor: descriptor,
                    texture_view_descriptor: None,
                    had_data: false,
                },
            );
        }
    }
    app.insert_resource(surfaces);
}

/// Drop compositor ownership after workspace shutdown. wgpu retains any command
/// references until their queue submissions retire; there is no synchronous wait.
pub(crate) fn release(app: &mut App) {
    app.world_mut()
        .resource_mut::<woohaa_bevy_canvas::document_editor_visibility::NativeEditorTarget>()
        .0 = None;
    let Some(mut surfaces) = app.world_mut().remove_resource::<Surfaces>() else {
        return;
    };
    if let Some(mut camera) = app.world_mut().get_mut::<Camera>(surfaces.camera) {
        camera.is_active = false;
    }
    for (entity, image, material) in surfaces.items.drain(..) {
        app.world_mut().despawn(entity);
        app.world_mut()
            .resource_mut::<Assets<Image>>()
            .remove(image.id());
        app.world_mut()
            .resource_mut::<Assets<EditorMaterial>>()
            .remove(material.id());
        app.sub_app_mut(RenderApp)
            .world_mut()
            .resource_mut::<RenderAssets<GpuImage>>()
            .remove(image.id());
    }
    app.insert_resource(surfaces);
}

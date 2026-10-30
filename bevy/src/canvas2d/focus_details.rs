//! 原图片节点的区域纹理替换，沿用同一 Camera2d，基础图与细节不重叠。
//!
//! change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs —— 基础分片与细节分片改由
//! [`FocusDetailRegion`] + 局部 `FocusDetailSource` 组件表达；`FocusDetailVisuals` 只保留
//! 当前已接受的帧与上传代数，不再保存实体/句柄向量。
use bevy::{asset::RenderAssetUsages,prelude::*,render::render_resource::{Extent3d,TextureDimension,TextureFormat}};
use crate::{
    app::CurrentScene,
    canvas_ecs::components::{CanvasTextureSprite, FocusDetailKind, FocusDetailRegion},
    protocol::focus_details::{FocusDetails,FocusDetailUpload},
};
use std::sync::Arc;

#[derive(Resource, Default)]
pub(crate) struct FocusDetailBatch(pub Option<Option<FocusDetailUpload>>);

/// 已接受帧与上传代数（采样策略/等待状态，不是实体身份）。
#[derive(Resource,Default)]
pub(crate) struct FocusDetailVisuals {
    frame:Option<FocusDetails>,
    generation:u64,
}

/// 细节分片独占的 GPU 图像与像素身份（复用判定用 `Arc::ptr_eq`）。
#[derive(Component)]
pub(crate) struct FocusDetailSource {
    image: Handle<Image>,
    pixels: Arc<[u8]>,
}

fn layout(rect: [u32; 4], source: Vec2, size: Vec2, center: Vec2, z: f32) -> (Vec2, Transform) {
    let a = Vec2::new(rect[0] as f32, rect[1] as f32);
    let b = Vec2::new(rect[2] as f32, rect[3] as f32);
    let offset = ((a + b) * 0.5 / source - Vec2::splat(0.5)) * size;
    (
        (b - a) / source * size,
        Transform::from_xyz(center.x + offset.x, -center.y - offset.y, z),
    )
}

fn clear(
    commands:&mut Commands,
    state:&mut FocusDetailVisuals,
    images:&mut Assets<Image>,
    regions:&Query<(Entity,&FocusDetailRegion,Option<&FocusDetailSource>)>,
) {
    for (entity,_,source) in regions.iter() {
        commands.entity(entity).despawn();
        if let Some(source)=source { images.remove(source.image.id()); }
    }
    state.frame=None;
    state.generation=state.generation.wrapping_add(1);
}

type SpriteQuery<'w,'s> = Query<'w,'s,(Entity,&'static mut Sprite,&'static mut Transform,Option<&'static CanvasTextureSprite>)>;

fn texture_sprite(
    sprites:&SpriteQuery,
    images:&Assets<Image>,
    node_id:&str,
) -> Option<(Entity,Handle<Image>,Vec2)> {
    sprites
        .iter()
        .find(|(_,_,_,texture)|texture.is_some_and(|t|t.node_id==node_id))
        .and_then(|(entity,sprite,_,_)|{
            images.get(&sprite.image).map(|image|{
                (entity,sprite.image.clone(),Vec2::new(image.width() as f32,image.height() as f32))
            })
        })
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn sync(
    mut commands:Commands,
    scene:Res<CurrentScene>,
    index:Res<crate::app::NodeIndex>,
    mut batch:ResMut<FocusDetailBatch>,
    mut state:ResMut<FocusDetailVisuals>,
    mut images:ResMut<Assets<Image>>,
    mut sprites:SpriteQuery,
    regions:Query<(Entity,&FocusDetailRegion,Option<&FocusDetailSource>)>,
) {
    // 每帧先恢复上次替换的基础 Sprite；仅有效细节会在下面重新隐藏它。
    if let Some(frame)=&state.frame {
        if let Some((index,node))=index.node(&scene.0,&frame.node_id) {
            if let Some((entity,_,px))=texture_sprite(&sprites,&images,&frame.node_id) {
                let color=super::image_focus::sprite_layout(&scene.0,node,px,index).2;
                if let Ok((_,mut sprite,_,_))=sprites.get_mut(entity) {sprite.color=color;}
            }
        }
    }
    let mut pending_details:Vec<(Entity,[u32;4],Handle<Image>)>=Vec::new();
    if let Some(next)=batch.0.take() {
        if let Some(upload)=next {
            let compatible=state.frame.as_ref().is_some_and(|old|old.node_id==upload.frame.node_id && old.width==upload.frame.width && old.height==upload.frame.height);
            if !compatible {clear(&mut commands,&mut state,&mut images,&regions);}
            // 覆盖范围变化才重建基础分片；未变化的内部纹理与实体保留。
            if state.frame.as_ref().is_some_and(|old|old.bounds()!=upload.frame.bounds()) {
                for (entity,region,_) in regions.iter() {
                    if region.kind==FocusDetailKind::Base {commands.entity(entity).despawn();}
                }
            }
            state.generation=state.generation.wrapping_add(1);
            let generation=state.generation;
            let owner=texture_sprite(&sprites,&images,&upload.frame.node_id)
                .map(|(entity,_,_)|entity)
                .unwrap_or(Entity::PLACEHOLDER);
            let mut previous:Vec<(Entity,[u32;4],Arc<[u8]>)>=regions
                .iter()
                .filter_map(|(entity,region,source)|match (region.kind,source) {
                    (FocusDetailKind::Detail,Some(source))=>
                        Some((entity,region.rect,source.pixels.clone())),
                    _=>None,
                })
                .collect();
            for (tile,pixels) in upload.frame.tiles.iter().zip(upload.pixels) {
                let rect=tile.rect();
                if let Some(index)=previous.iter().position(|(_,old,data)|*old==rect && Arc::ptr_eq(data,&pixels)) {
                    previous.swap_remove(index);
                    continue;
                }
                let image=Image::new(Extent3d{width:tile.width,height:tile.height,depth_or_array_layers:1},TextureDimension::D2,
                    pixels.to_vec(),TextureFormat::Rgba8UnormSrgb,RenderAssetUsages::default());
                let handle=images.add(image);
                let entity=commands.spawn((
                    Sprite{image:handle.clone(),color:Color::NONE,..default()},
                    Transform::default(),
                    FocusDetailRegion{owner,rect,generation,kind:FocusDetailKind::Detail},
                    FocusDetailSource{image:handle.clone(),pixels},
                )).id();
                pending_details.push((entity,rect,handle));
            }
            for (entity,_,_) in previous {
                if let Ok((_,sprite,_,_))=sprites.get(entity) {
                    images.remove(sprite.image.id());
                }
                commands.entity(entity).despawn();
            }
            state.frame=Some(upload.frame);
        } else {clear(&mut commands,&mut state,&mut images,&regions);}
    }
    let Some(frame)=&state.frame else{return;};
    let valid=scene.0.image_focus.as_ref().is_some_and(|f|f.presentation_ready && f.node_id==frame.node_id && f.source_width==frame.width as f32 && f.source_height==frame.height as f32);
    if !valid {clear(&mut commands,&mut state,&mut images,&regions);return;}
    let Some((base_entity,base_handle,px))=texture_sprite(&sprites,&images,&frame.node_id) else{clear(&mut commands,&mut state,&mut images,&regions);return;};
    let Some((index,node))=index.node(&scene.0,&frame.node_id).filter(|(_,n)|n.texture) else{clear(&mut commands,&mut state,&mut images,&regions);return;};
    let (size,center,color,z)=super::image_focus::sprite_layout(&scene.0,node,px,index);
    let source=Vec2::new(frame.width as f32,frame.height as f32);
    if let Ok((_,mut sprite,_,_))=sprites.get_mut(base_entity) {sprite.color=Color::NONE;}

    // 基础分片：与当前帧的 base_regions 不一致时整体重建（数量/矩形变化才会发生）。
    let desired_base=frame.base_regions();
    let mut existing_base:Vec<[u32;4]>=regions
        .iter()
        .filter(|(_,region,_)|region.kind==FocusDetailKind::Base)
        .map(|(_,region,_)|region.rect)
        .collect();
    existing_base.sort_unstable();
    let mut wanted=desired_base.clone();
    wanted.sort_unstable();
    if existing_base!=wanted {
        for (entity,region,_) in regions.iter() {
            if region.kind==FocusDetailKind::Base {commands.entity(entity).despawn();}
        }
        for rect in &desired_base {
            let (custom_size,transform)=layout(*rect,source,size,center,z);
            let uv=|x:u32,y:u32|Vec2::new(x as f32,y as f32)/source*px;
            commands.spawn((
                Sprite{
                    image:base_handle.clone(),
                    custom_size:Some(custom_size),
                    rect:Some(Rect::from_corners(uv(rect[0],rect[1]),uv(rect[2],rect[3]))),
                    color,
                    ..default()
                },
                transform,
                FocusDetailRegion{owner:base_entity,rect:*rect,generation:state.generation,kind:FocusDetailKind::Base},
            ));
        }
    }
    for (entity,region,_) in regions.iter() {
        if region.kind!=FocusDetailKind::Base {continue;}
        if let Ok((_,mut sprite,mut transform,_))=sprites.get_mut(entity) {
            let (custom_size,next)=layout(region.rect,source,size,center,z);
            let uv=|x:u32,y:u32|Vec2::new(x as f32,y as f32)/source*px;
            sprite.rect=Some(Rect::from_corners(uv(region.rect[0],region.rect[1]),uv(region.rect[2],region.rect[3])));
            sprite.image=base_handle.clone();sprite.custom_size=Some(custom_size);sprite.color=color;*transform=next;
        }
    }
    for (entity,region,source_pixels) in regions.iter() {
        if region.kind!=FocusDetailKind::Detail {continue;}
        let Some(source_pixels)=source_pixels else {continue;};
        let (custom_size,transform)=layout(region.rect,source,size,center,z);
        // 新实体在 Commands 应用前尚不可查询，直接写入最终组件，避免空白首帧。
        commands.entity(entity).insert((
            Sprite{image:source_pixels.image.clone(),custom_size:Some(custom_size),color,..default()},
            transform,
        ));
    }
    {
        for (entity,rect,handle) in pending_details {
            let (custom_size,transform)=layout(rect,source,size,center,z);
            commands.entity(entity).insert((
                Sprite{image:handle,custom_size:Some(custom_size),color,..default()},
                transform,
            ));
        }
    }
}

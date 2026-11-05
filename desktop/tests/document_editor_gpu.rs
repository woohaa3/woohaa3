//! Explicit hardware smoke: allocation/copy/publication/readback on the Bevy device.
use bevy::{
    prelude::*,
    render::{
        render_resource::*,
        renderer::{RenderAdapterInfo, RenderDevice, RenderQueue},
    },
};
use woohaa_bevy_canvas::document_editor_textures::SharedDocumentTextures;

#[test]
#[ignore = "requires a real hardware GPU; run explicitly after environment probe"]
fn shared_editor_texture_uses_bevy_device_and_preserves_rgba() {
    let mut app = App::new();
    app.add_plugins(
        DefaultPlugins
            .set(WindowPlugin {
                primary_window: None,
                exit_condition: bevy::window::ExitCondition::DontExit,
                ..default()
            })
            .disable::<bevy::render::pipelined_rendering::PipelinedRenderingPlugin>(),
    );
    app.finish();
    app.cleanup();
    let adapter = app.world().resource::<RenderAdapterInfo>();
    assert!(
        matches!(
            format!("{:?}", adapter.device_type).as_str(),
            "IntegratedGpu" | "DiscreteGpu"
        ),
        "software adapters cannot validate this test"
    );
    eprintln!(
        "native editor texture GPU: {} {:?}",
        adapter.name, adapter.backend
    );
    let device = app.world().resource::<RenderDevice>();
    let queue = app.world().resource::<RenderQueue>();
    let mut textures = SharedDocumentTextures::allocate(device, 1, 2, 2, 32).unwrap();
    let ticket = textures.begin(1, 1, 4).unwrap();
    let pixels = [
        255u8, 0, 0, 128, 0, 255, 0, 255, 0, 0, 255, 64, 255, 255, 255, 0,
    ];
    queue.write_texture(
        textures.writable(ticket).unwrap().as_image_copy(),
        &pixels,
        TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(8),
            rows_per_image: Some(2),
        },
        Extent3d {
            width: 2,
            height: 2,
            depth_or_array_layers: 1,
        },
    );
    queue.submit([]);
    textures.submitted(ticket, 1).unwrap();
    device
        .poll(PollType::Wait {
            submission_index: None,
            timeout: None,
        })
        .unwrap();
    textures.complete(1, 1).unwrap();
    textures.validated(ticket).unwrap();
    textures.publish(ticket).unwrap();
    let buffer = device.create_buffer(&BufferDescriptor {
        label: Some("editor-smoke-readback"),
        size: 512,
        usage: BufferUsages::COPY_DST | BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
        label: Some("editor-smoke"),
    });
    encoder.copy_texture_to_buffer(
        textures.front().unwrap().as_image_copy(),
        TexelCopyBufferInfo {
            buffer: &buffer,
            layout: TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(256),
                rows_per_image: Some(2),
            },
        },
        Extent3d {
            width: 2,
            height: 2,
            depth_or_array_layers: 1,
        },
    );
    queue.submit([encoder.finish()]);
    textures.mark_read(2).unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    buffer.slice(..).map_async(MapMode::Read, move |result| {
        let _ = tx.send(result);
    });
    device
        .poll(PollType::Wait {
            submission_index: None,
            timeout: None,
        })
        .unwrap();
    rx.recv_timeout(std::time::Duration::from_secs(5))
        .unwrap()
        .unwrap();
    let mapped = buffer.slice(..).get_mapped_range().unwrap();
    assert_eq!(&mapped[..8], &pixels[..8]);
    assert_eq!(&mapped[256..264], &pixels[8..]);
    drop(mapped);
    buffer.unmap();
    textures.complete(1, 2).unwrap();
    assert!(SharedDocumentTextures::allocate(device, 1, 2, 2, 31).is_err());
}

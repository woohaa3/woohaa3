use woohaa_media_image::prepare;
#[test]
fn avif_decodes_with_alpha() {
    let p = prepare(include_bytes!("fixtures/alpha.avif"), 128).unwrap();
    assert_eq!((p.width, p.height), (4, 2));
    let px = p.into_pixels();
    assert!((126..=130).contains(&px[3]));
    assert!(px[0] > 220 && px[2] < 40);
}
#[test]
fn png_webp_colour_and_first_gif_frame() {
    for bytes in [
        include_bytes!("fixtures/alpha.webp").as_slice(),
        include_bytes!("fixtures/tagged.png").as_slice(),
    ] {
        let p = prepare(bytes, 128).unwrap();
        assert_eq!((p.width, p.height), (4, 2));
        let px = p.into_pixels();
        assert!(px[0] > 220 && px[2] < 40);
        assert_eq!(px[3], 128);
    }
    let px = prepare(include_bytes!("fixtures/animated.gif"), 128)
        .unwrap()
        .into_pixels();
    assert_eq!(&px[..4], &[255, 0, 0, 255]);
}
#[test]
fn orientation_and_invalid_colour_are_explicit() {
    let p = prepare(include_bytes!("fixtures/rotate.jpg"), 128).unwrap();
    assert_eq!((p.width, p.height), (2, 3));
    let p = prepare(include_bytes!("fixtures/mirror.jpg"), 128).unwrap();
    let px = p.into_pixels();
    assert!(px[8 + 2] > px[8]);
    assert!(prepare(include_bytes!("fixtures/invalid-icc.png"), 128).is_err());
}

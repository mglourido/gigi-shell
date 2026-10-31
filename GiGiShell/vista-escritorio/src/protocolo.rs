//! Enlaces del protocolo de Hyprland, generados desde el XML incluido en `protocolos/`.
//! Se versiona el XML porque `hyprland-protocols` no es una dependencia de esta instalación.
#![allow(dead_code, non_camel_case_types, clippy::all)]

use wayland_client;
use wayland_protocols::ext::image_capture_source::v1::client::*;
use wayland_protocols::ext::workspace::v1::client::*;

pub mod __interfaces {
    use wayland_protocols::ext::image_capture_source::v1::client::__interfaces::*;
    use wayland_protocols::ext::workspace::v1::client::__interfaces::*;
    wayland_scanner::generate_interfaces!(
        "protocolos/hyprland-workspace-image-capture-source-v1.xml"
    );
}
use self::__interfaces::*;

wayland_scanner::generate_client_code!("protocolos/hyprland-workspace-image-capture-source-v1.xml");

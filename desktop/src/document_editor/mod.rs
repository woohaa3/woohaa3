//! Optional, statically assembled native document editor boundary.
//! No provider is registered by the default desktop entry point.
mod coordinator;
mod input;
mod protocol;
pub mod transport;
pub use coordinator::*;
pub use input::*;
pub use protocol::*;

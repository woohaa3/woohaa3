//! Windows 命名管道客户端（与 Node `net.Server` 的 `\\.\pipe\...` 字节流对接）。
//!
//! 只实现 supervisor 控制通道需要的同步读、写、复制句柄与读超时；不引入额外 crate。
//! 读超时用 `PeekNamedPipe` 轮询实现，因为同步命名管道没有 `set_read_timeout`。

use std::cell::Cell;
use std::ffi::{c_void, OsStr};
use std::io::{self, Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::time::{Duration, Instant};

type Handle = *mut c_void;

const GENERIC_READ: u32 = 0x8000_0000;
const GENERIC_WRITE: u32 = 0x4000_0000;
const OPEN_EXISTING: u32 = 3;
const ERROR_BROKEN_PIPE: i32 = 109;
const ERROR_PIPE_BUSY: i32 = 231;
const DUPLICATE_SAME_ACCESS: u32 = 0x0000_0002;
const WAIT_NAMED_PIPE_TIMEOUT_MS: u32 = 1_000;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateFileW(
        file_name: *const u16,
        desired_access: u32,
        share_mode: u32,
        security_attributes: *mut c_void,
        creation_disposition: u32,
        flags_and_attributes: u32,
        template_file: Handle,
    ) -> Handle;
    fn ReadFile(
        file: Handle,
        buffer: *mut c_void,
        bytes_to_read: u32,
        bytes_read: *mut u32,
        overlapped: *mut c_void,
    ) -> i32;
    fn WriteFile(
        file: Handle,
        buffer: *const c_void,
        bytes_to_write: u32,
        bytes_written: *mut u32,
        overlapped: *mut c_void,
    ) -> i32;
    fn PeekNamedPipe(
        pipe: Handle,
        buffer: *mut c_void,
        buffer_size: u32,
        bytes_read: *mut u32,
        total_bytes_available: *mut u32,
        bytes_left_this_message: *mut u32,
    ) -> i32;
    fn DuplicateHandle(
        source_process: Handle,
        source_handle: Handle,
        target_process: Handle,
        target_handle: *mut Handle,
        desired_access: u32,
        inherit_handle: i32,
        options: u32,
    ) -> i32;
    fn CloseHandle(object: Handle) -> i32;
    fn GetCurrentProcess() -> Handle;
    fn WaitNamedPipeW(name: *const u16, timeout: u32) -> i32;
}

fn wide(path: &OsStr) -> Vec<u16> {
    path.encode_wide().chain(std::iter::once(0)).collect()
}

/// 已连接的命名管道句柄；`Clone` 语义与 `UnixStream::try_clone` 一致。
pub struct NamedPipeStream {
    handle: Handle,
    read_timeout: Cell<Option<Duration>>,
    write_timeout: Cell<Option<Duration>>,
}

// 句柄归一个连接线程独占；复制出的句柄由 reader 线程独占。
unsafe impl Send for NamedPipeStream {}

impl NamedPipeStream {
    pub fn connect(path: &Path) -> io::Result<Self> {
        let name = wide(path.as_os_str());
        let mut handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                std::ptr::null_mut(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            )
        };
        if handle == (-1isize) as Handle {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_PIPE_BUSY) {
                return Err(error);
            }
            // 服务端正在创建实例时短暂等待；外层会按重连节奏继续重试。
            if unsafe { WaitNamedPipeW(name.as_ptr(), WAIT_NAMED_PIPE_TIMEOUT_MS) } == 0 {
                return Err(io::Error::last_os_error());
            }
            handle = unsafe {
                CreateFileW(
                    name.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    std::ptr::null_mut(),
                    OPEN_EXISTING,
                    0,
                    std::ptr::null_mut(),
                )
            };
            if handle == (-1isize) as Handle {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(Self {
            handle,
            read_timeout: Cell::new(None),
            write_timeout: Cell::new(None),
        })
    }

    pub fn try_clone(&self) -> io::Result<Self> {
        let mut duplicate: Handle = std::ptr::null_mut();
        let ok = unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                self.handle,
                GetCurrentProcess(),
                &mut duplicate,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            handle: duplicate,
            read_timeout: Cell::new(self.read_timeout.get()),
            write_timeout: Cell::new(self.write_timeout.get()),
        })
    }

    pub fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.read_timeout.set(timeout);
        Ok(())
    }

    pub fn set_write_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.write_timeout.set(timeout);
        Ok(())
    }

    /// 客户端没有 `shutdown`；关闭句柄由 `Drop` 完成。
    pub fn shutdown(&self, _how: std::net::Shutdown) -> io::Result<()> {
        Ok(())
    }
}

impl Read for NamedPipeStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let deadline = self
            .read_timeout
            .get()
            .map(|timeout| Instant::now() + timeout);
        loop {
            let mut available = 0u32;
            let ok = unsafe {
                PeekNamedPipe(
                    self.handle,
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null_mut(),
                    &mut available,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(ERROR_BROKEN_PIPE) {
                    return Ok(0);
                }
                return Err(error);
            }
            if available > 0 {
                let to_read = buffer.len().min(available as usize) as u32;
                let mut read = 0u32;
                let ok = unsafe {
                    ReadFile(
                        self.handle,
                        buffer.as_mut_ptr() as *mut c_void,
                        to_read,
                        &mut read,
                        std::ptr::null_mut(),
                    )
                };
                if ok == 0 {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() == Some(ERROR_BROKEN_PIPE) {
                        return Ok(0);
                    }
                    return Err(error);
                }
                return Ok(read as usize);
            }
            if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "named pipe read timed out",
                ));
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Write for NamedPipeStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let mut written = 0u32;
        let ok = unsafe {
            WriteFile(
                self.handle,
                buffer.as_ptr() as *const c_void,
                buffer.len() as u32,
                &mut written,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let _ = self.write_timeout.get();
        Ok(written as usize)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for NamedPipeStream {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

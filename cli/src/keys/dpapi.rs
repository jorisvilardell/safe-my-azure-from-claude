//! DPAPI (`CryptProtectData` / `CryptUnprotectData`) for the key cache, current-user scope.
//!
//! The only `unsafe` in the crate: two Win32 calls plus reading and freeing the buffer they
//! return. Every pointer comes from a live Rust slice or from DPAPI itself.
#![allow(unsafe_code)]

use anyhow::{Result, bail};
use std::io;
use std::ptr;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
};

/// Encrypts `plain` for the current Windows user.
pub fn protect(plain: &[u8]) -> Result<Vec<u8>> {
    let input = blob_of(plain)?;
    let mut output = empty_blob();
    // SAFETY: `input` points to `plain`, which outlives the call and is only read. The optional
    // pointers are null, which the API allows. On success DPAPI fills `output` with a buffer
    // allocated by `LocalAlloc`, which `take` copies and frees.
    let ok = unsafe {
        CryptProtectData(
            &raw const input,
            ptr::null(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &raw mut output,
        )
    };
    if ok == 0 {
        bail!(
            "DPAPI could not encrypt the key cache ({})",
            io::Error::last_os_error()
        );
    }
    Ok(take(output, false))
}

/// Decrypts data produced by [`protect`] for the same user.
pub fn unprotect(sealed: &[u8]) -> Result<Vec<u8>> {
    let input = blob_of(sealed)?;
    let mut output = empty_blob();
    // SAFETY: same contract as in `protect`; the description out-pointer is null (not wanted).
    let ok = unsafe {
        CryptUnprotectData(
            &raw const input,
            ptr::null_mut(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &raw mut output,
        )
    };
    if ok == 0 {
        bail!(
            "DPAPI could not decrypt the key cache ({})",
            io::Error::last_os_error()
        );
    }
    Ok(take(output, true))
}

fn blob_of(data: &[u8]) -> Result<CRYPT_INTEGER_BLOB> {
    Ok(CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(data.len())?,
        // DPAPI only reads the input blob; the API type is `*mut` for historical reasons.
        pbData: data.as_ptr().cast_mut(),
    })
}

fn empty_blob() -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    }
}

/// Copies a DPAPI output buffer into a `Vec`, optionally wipes it, then frees it.
fn take(blob: CRYPT_INTEGER_BLOB, wipe: bool) -> Vec<u8> {
    if blob.pbData.is_null() {
        return Vec::new();
    }
    let len = usize::try_from(blob.cbData).unwrap_or(0);
    // SAFETY: DPAPI returned `cbData` initialised bytes at `pbData` (non-null, checked above),
    // owned by us until `LocalFree`.
    let bytes = unsafe { std::slice::from_raw_parts(blob.pbData, len) }.to_vec();
    if wipe {
        // SAFETY: same buffer and length as above, still owned by us.
        unsafe { ptr::write_bytes(blob.pbData, 0, len) };
    }
    // SAFETY: the buffer was allocated by DPAPI with `LocalAlloc` and is freed exactly once.
    unsafe { LocalFree(blob.pbData.cast()) };
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() -> Result<()> {
        let sealed = protect(b"hello dpapi")?;
        assert_ne!(sealed.as_slice(), b"hello dpapi");
        assert_eq!(unprotect(&sealed)?, b"hello dpapi");
        Ok(())
    }

    #[test]
    fn rejects_garbage() {
        assert!(unprotect(b"not a dpapi blob").is_err());
    }
}

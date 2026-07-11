#![deny(clippy::all)]

use napi_derive::napi;

#[napi]
pub fn calculate_block_hashes(buffer: &[u8], width: u32, height: u32, block_size: u32) -> Vec<String> {
    if buffer.is_empty() || width == 0 || height == 0 || block_size == 0 {
        return Vec::new();
    }

    let cols = (width + block_size - 1) / block_size;
    let rows = (height + block_size - 1) / block_size;
    let total_blocks = (cols * rows) as usize;
    let mut hashes = Vec::with_capacity(total_blocks);

    for r in 0..rows {
        for c in 0..cols {
            let start_x = c * block_size;
            let start_y = r * block_size;
            let end_x = std::cmp::min(start_x + block_size, width);
            let end_y = std::cmp::min(start_y + block_size, height);

            // Simple Fowler-Noll-Vo or rolling hash algorithm for block pixels
            let mut hash: u64 = 0xcbf29ce484222325;
            for y in start_y..end_y {
                let row_offset = (y * width) as usize;
                for x in start_x..end_x {
                    let pixel_idx = (row_offset + x as usize) * 4; // Assuming RGBA
                    if pixel_idx + 3 < buffer.len() {
                        hash = hash ^ (buffer[pixel_idx] as u64);
                        hash = hash.wrapping_mul(0x100000001b3);
                        hash = hash ^ (buffer[pixel_idx + 1] as u64);
                        hash = hash.wrapping_mul(0x100000001b3);
                        hash = hash ^ (buffer[pixel_idx + 2] as u64);
                        hash = hash.wrapping_mul(0x100000001b3);
                        hash = hash ^ (buffer[pixel_idx + 3] as u64);
                        hash = hash.wrapping_mul(0x100000001b3);
                    }
                }
            }
            hashes.push(format!("{:x}", hash));
        }
    }

    hashes
}

#[napi]
pub fn find_mutated_blocks(prev_hashes: Vec<String>, curr_hashes: Vec<String>) -> Vec<u32> {
    let mut mutated = Vec::new();
    let min_len = std::cmp::min(prev_hashes.len(), curr_hashes.len());
    for i in 0..min_len {
        if prev_hashes[i] != curr_hashes[i] {
            mutated.push(i as u32);
        }
    }
    // If length differs, all extra blocks are marked as mutated
    if curr_hashes.len() > prev_hashes.len() {
        for i in prev_hashes.len()..curr_hashes.len() {
            mutated.push(i as u32);
        }
    }
    mutated
}

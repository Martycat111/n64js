/*global n64js*/

import { assert } from '../assert.js';
import { toString16, toString32 } from '../format.js';
import { convertTexels } from './convert.js';
import * as gbi from './gbi.js';

// TODO: provide a HLE object and instantiate these in the constructor/reset.
function getRamS32Array() { return n64js.hardware().cachedMemDevice.s32; }
function getRamU8Array() { return n64js.hardware().cachedMemDevice.u8; }

export class TMEM {
  constructor() {
    const tmemBuffer = new ArrayBuffer(4096);
    this.tmemData32 = new Int32Array(tmemBuffer);
    this.tmemData = new Uint8Array(tmemBuffer);
  }

  loadBlock(tile, ramAddress, dxt, qwords) {
    const tmemData = this.tmemData32;

    // Offsets in 32 bit words.
    let ramOffset = ramAddress >>> 2;
    let tmemOffset = (tile.tmem << 3) >>> 2;

    const ram_s32 = getRamS32Array();

    // RGBA/32 swaps on 8 byte boundary, not 4.
    const wordSwapBit = (tile.size == gbi.ImageSize.G_IM_SIZ_32b) ? 2 : 1;

    // Slight fast path for dxt == 0
    if (dxt === 0) {
      copyLineQwords(tmemData, tmemOffset, ram_s32, ramOffset, qwords);
    } else {
      // TODO: Emulate by incrementing a counter by dxt each frame, and emitting a new
      // line when it overflows 2048.
      // The LoadBlock command uses the parameter dxt to indicate when it should start the next line.
      // Dxt is basically the reciprocal of the number of words (64-bits) in a line.
      // The texture coordinate unit increments a counter by dxt for each word transferred to Tmem.
      // When this counter rolls over into the next integer value, the line count is incremented. 
      const qwordsPerLine = Math.ceil(2048 / dxt);
      let oddRow = 0;
      for (let i = 0; i < qwords;) {
        const qwordsToCopy = Math.min(qwords - i, qwordsPerLine);

        if (oddRow) {
          copyLineQwordsSwap(tmemData, tmemOffset, ram_s32, ramOffset, qwordsToCopy, wordSwapBit);
        } else {
          copyLineQwords(tmemData, tmemOffset, ram_s32, ramOffset, qwordsToCopy);
        }

        i += qwordsToCopy;

        // 2 words per quadword copied
        tmemOffset += qwordsToCopy * 2;
        ramOffset += qwordsToCopy * 2;

        // All odd lines are swapped
        oddRow ^= 1;
      }
    }
  }

  /**
   * Loads a tile to TMEM.
   * @param {TextureImage} ti RDP texture image. 
   * @param {Tile} tile Tile being loaded.
   * @param {number} uls Upper-left S coordinate to load, in 10.2 format.
   * @param {number} ult Upper-left T coordinate to load, in 10.2 format.
   * @param {number} lrs Lower-right S coordinate to load, in 10.2 format.
   * @param {number} lrs Lower-right T coordinate to load, in 10.2 format.
   * @param {DebugController?} dc An optional debug controller for displaying tooltips.
   */
  loadTile(ti, tile, uls, ult, lrs, lrt, dc) {
    const s0 = uls >>> 2;
    const t0 = ult >>> 2;
    const s1 = lrs >>> 2;
    const t1 = lrt >>> 2;

    const w = (s1 + 1) - s0;
    const h = (t1 + 1) - t0;
    
    const ramAddress = ti.calcAddress(s0, t0);
    const rowBytes = ti.texelsToBytes(w);
    const ramStride = ti.stride();
  
    const tmemData = this.tmemData;
    let tmemOffset = tile.tmem << 3;
    let ramOffset = ramAddress;

    // 32bpp loads 8 bytes at a time, not 4.
    // TODO: confirm if these should use ti.size or tile.size. Currently they're different.
    const tmemStride = (ti.size == gbi.ImageSize.G_IM_SIZ_32b) ? tile.line << 4 : tile.line << 3;
    const byteSwapBit = (tile.size == gbi.ImageSize.G_IM_SIZ_32b) ? 8 : 4;

    if (dc) {
      dc.tip(`size (${w} x ${h}), rowBytes ${rowBytes}, ramStride ${ramStride}, tmemStride ${tmemStride}, ramOffset ${toString32(ramOffset)}, tmemOffset ${toString16(tmemOffset)}`);
    }

    // TODO: Limit the load to fetchedQWords?
    // TODO: should be limited to 2048 texels, not 512 qwords.
    // const bytes = h * rowBytes;
    // const reqQWords = (bytes + 7) >>> 3;
    // const fetchedQWords = (reqQWords > 512) ? 512 : reqQWords;

    const ram_u8 = getRamU8Array();
    for (let y = 0; y < h; ++y) {
      if (y & 1) {
        copyLineSwap(tmemData, tmemOffset, ram_u8, ramOffset, rowBytes, tmemStride, byteSwapBit);
      } else {
        copyLine(tmemData, tmemOffset, ram_u8, ramOffset, rowBytes, tmemStride);
      }
      tmemOffset += tmemStride;
      ramOffset += ramStride;
    }
  }

  loadTLUT(tile, ramAddress, texels) {
    const ram_u8 = getRamU8Array();
    var tmem_offset = tile.tmem << 3;

    copyLineTLUT(this.tmemData, tmem_offset, ram_u8, ramAddress, texels);
  }

  convertTexels(tile, tlutFormat, imgData) {
    return convertTexels(imgData, this.tmemData, tile, tlutFormat);
  }

  calculateCRC(tile) {
    if (tile.hash) {
      return tile.hash;
    }

    //var width = tile.width;
    var height = tile.height;

    var src = this.tmemData32;
    var tmem_offset = tile.tmem << 3;
    var bytes_per_line = tile.line << 3;

    // NB! RGBA/32 line needs to be doubled.
    if (tile.format == gbi.ImageFormat.G_IM_FMT_RGBA &&
      tile.size == gbi.ImageSize.G_IM_SIZ_32b) {
      bytes_per_line *= 2;
    }

    // TODO: not sure what happens when width != tile.line. Maybe we should hash rows separately?

    var len = height * bytes_per_line;

    var hash = hashTmem(src, tmem_offset, len, 0);

    // For palettised textures, check the palette entries too
    if (tile.format === gbi.ImageFormat.G_IM_FMT_CI ||
      tile.format === gbi.ImageFormat.G_IM_FMT_RGBA) { // NB RGBA check is for extreme-g, which specifies RGBA/4 and RGBA/8 instead of CI/4 and CI/8

      // Palettes are "quadricated", so there are 8 bytes per entry.
      if (tile.size === gbi.ImageSize.G_IM_SIZ_8b) {
        hash = hashTmem(src, 0x800, 256 * 8, hash);
      } else if (tile.size === gbi.ImageSize.G_IM_SIZ_4b) {
        hash = hashTmem(src, 0x800 + (tile.palette * 16 * 2), 16 * 8, hash);
      }
    }

    tile.hash = hash;
    return hash;
  }
}

function hashTmem(tmem32, offset, len, hash) {
  let i = offset >> 2;
  let e = (offset + len) >> 2;
  while (i < e) {
    hash = ((hash * 17) + tmem32[i]) >>> 0;
    ++i;
  }
  return hash;
}

// tmem/ram should be Int32Array
function copyLineQwords(tmem, tmem_offset, ram, ram_offset, qwords) {
  for (let i = 0; i < qwords; ++i) {
    tmem[tmem_offset + 0] = ram[ram_offset + 0];
    tmem[tmem_offset + 1] = ram[ram_offset + 1];
    tmem_offset += 2;
    ram_offset += 2;
  }
}

// tmem/ram should be Int32Array
function copyLineQwordsSwap(tmem, tmem_offset, ram, ram_offset, qwords, wordSwapBit) {
  assert((tmem_offset & 1) == 0, "tmem isn't qword aligned");

  for (let i = 0; i < qwords; ++i) {
    tmem[(tmem_offset + 0) ^ wordSwapBit] = ram[ram_offset + 0];
    tmem[(tmem_offset + 1) ^ wordSwapBit] = ram[ram_offset + 1];
    tmem_offset += 2;
    ram_offset += 2;
  }
}

function copyLine(tmem, tmemOffset, ram, ramOffset, texelBytes, rowBytes) {
  for (let x = 0; x < texelBytes; ++x) {
    tmem[tmemOffset + x] = ram[ramOffset + x];
  }
  for (let x = texelBytes; x < rowBytes; ++x) {
    tmem[tmemOffset + x] = 0;
  }
}

function copyLineSwap(tmem, tmemOffset, ram, ramOffset, texelBytes, rowBytes, byteSwapBit) {
  for (let x = 0; x < texelBytes; ++x) {
    tmem[(tmemOffset + x) ^ byteSwapBit] = ram[(ramOffset + x)];
  }
  for (let x = texelBytes; x < rowBytes; ++x) {
    tmem[(tmemOffset + x) ^ byteSwapBit] = 0;
  }
}

function copyLineTLUT(tmem, tmemOffset, ram, ramOffset, texels) {
  // TLUT entries are "quadricated" across banks.
  // TODO: optimise this.
  for (let texel = 0; texel < texels; texel++) {
    const lo = ram[ramOffset + (texel * 2) + 0];
    const hi = ram[ramOffset + (texel * 2) + 1];

    tmem[tmemOffset + (texel * 8) + 0] = lo;
    tmem[tmemOffset + (texel * 8) + 1] = hi;
    tmem[tmemOffset + (texel * 8) + 2] = lo;
    tmem[tmemOffset + (texel * 8) + 3] = hi;
    tmem[tmemOffset + (texel * 8) + 4] = lo;
    tmem[tmemOffset + (texel * 8) + 5] = hi;
    tmem[tmemOffset + (texel * 8) + 6] = lo;
    tmem[tmemOffset + (texel * 8) + 7] = hi;
  }
}

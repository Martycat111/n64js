import { toString32 } from "../format.js";
import { Vector3 } from "../graphics/Vector3.js";
import { GBI1 } from "./gbi1.js";

// GBI0 is very similar to GBI1 with a few small differences,
// so we extend that instead of GBIMicrocode.
export class GBI0 extends GBI1 {
  constructor(ucode, state, ramDV) {
    super(ucode, state, ramDV);
    this.vertexStride = 10;

    this.gbi0Commands = new Map([
      [0xb0, this.executeUnknown],      // Defined as executeBranchZ for GBI1.
      [0xb1, this.executeTri4],         // Defined as executeTri2 for GBI1.
      [0xb2, this.executeRDPHalf_Cont], // Defined as executeModifyVertex for GBI1.
    ]);
  }

  getHandler(command) {
    const fn = this.gbi0Commands.get(command);
    if (fn) {
      return fn;
    }
    return super.getHandler(command);
  }

  executeVertex(cmd0, cmd1, dis) {
    const n = ((cmd0 >>> 20) & 0xf) + 1;
    const v0 = (cmd0 >>> 16) & 0xf;
    //const length = (cmd0 >>>  0) & 0xffff;
    const address = this.state.rdpSegmentAddress(cmd1);

    if (dis) {
      dis.text(`gsSPVertex(${toString32(address)}, ${n}, ${v0});`);
    }

    this.loadVertices(v0, n, address, dis);
  }

  executeRDPHalf_Cont(cmd0, cmd1, dis) {
    this.warnUnimplemented('RDPHalf_Cont');
    if (dis) {
      dis.text(`gsDPHalf_Cont(/* TODO */);`);
    }
  }

  // Shared between Goldeneye and Perfect Dark.
  executeRDPHalf1Goldeneye(cmd0, cmd1, dis) {
    // These are RDP commands, baked into the display list.
    // They seem to alternatein pairs of 0xb4 and 0xb3
    this.warnUnimplemented('executeRDPHalf1')
    if (dis) {
      dis.text(`gsSPRDPHalf();`);
    }
  }

  // Should this be registered for all GBI0 microcodes?
  executeTri4(cmd0, cmd1, dis) {
    const kCommand = cmd0 >>> 24;
    const verts = this.state.projectedVertices;
    const tb = this.triangleBuffer;
    tb.reset();

    let pc = this.state.pc;
    do {
      const idx09 = ((cmd0 >>> 12) & 0xf);
      const idx06 = ((cmd0 >>> 8) & 0xf);
      const idx03 = ((cmd0 >>> 4) & 0xf);
      const idx00 = ((cmd0 >>> 0) & 0xf);
      const idx11 = ((cmd1 >>> 28) & 0xf);
      const idx10 = ((cmd1 >>> 24) & 0xf);
      const idx08 = ((cmd1 >>> 20) & 0xf);
      const idx07 = ((cmd1 >>> 16) & 0xf);
      const idx05 = ((cmd1 >>> 12) & 0xf);
      const idx04 = ((cmd1 >>> 8) & 0xf);
      const idx02 = ((cmd1 >>> 4) & 0xf);
      const idx01 = ((cmd1 >>> 0) & 0xf);

      if (dis) {
        dis.text(`gsSP1Triangle4(${idx00},${idx01},${idx02}, ${idx03},${idx04},${idx05}, ${idx06},${idx07},${idx08}, ${idx09},${idx10},${idx11});`);
      }

      if (idx00 !== idx01) {
        tb.pushTri(verts[idx00], verts[idx01], verts[idx02]);
      }
      if (idx03 !== idx04) {
        tb.pushTri(verts[idx03], verts[idx04], verts[idx05]);
      }
      if (idx06 !== idx07) {
        tb.pushTri(verts[idx06], verts[idx07], verts[idx08]);
      }
      if (idx09 !== idx10) {
        tb.pushTri(verts[idx09], verts[idx10], verts[idx11]);
      }

      cmd0 = this.ramDV.getUint32(pc + 0);
      cmd1 = this.ramDV.getUint32(pc + 4);
      ++this.debugController.currentOp;
      pc += 8;
      // NB: process triangles individually when disassembling
    } while ((cmd0 >>> 24) === kCommand && tb.hasCapacity(4) && !dis);

    this.state.pc = pc - 8;
    --this.debugController.currentOp;

    this.renderer.flushTris(tb);
  }
}
export class GBI0GE extends GBI0 {
  constructor(ucode, state, ramDV) {
    super(ucode, state, ramDV);
    this.vertexStride = 10;
  }

  getHandler(command, ucode) {
    switch (command) {
      case 0xb4: return this.executeRDPHalf1Goldeneye;
    }
    return super.getHandler(command, ucode);
  }
}

export class GBI0PD extends GBI0 {
  constructor(ucode, state, ramDV) {
    super(ucode, state, ramDV);
    this.vertexStride = 10;
    this.auxAddress = 0;
  }

  getHandler(command, ucode) {
    switch (command) {
      // 0x04 - executeVertex is different from GBI0, but handled by overriding loadVertices.
      case 0x07: return this.executeSetVertexColorIndex;
      case 0xb4: return this.executeRDPHalf1Goldeneye;
    }
    return super.getHandler(command, ucode);
  }

  executeSetVertexColorIndex(cmd0, cmd1, dis) {
    const address = this.state.rdpSegmentAddress(cmd1);
    if (dis) {
      dis.text(`gsSPSetVertexColorIndex(${toString32(address)});`);
    }
    this.auxAddress = address;
  }

  // Perfect Dark loads in a different format - this is called from executeVertex.
  loadVertices(v0, n, address, dis) {
    const light = this.state.geometryMode.lighting;
    const texgen = this.state.geometryMode.textureGen;
    const texgenlin = this.state.geometryMode.textureGenLinear;
    const dv = new DataView(this.ramDV.buffer, address);

    // Additional address for normal and color data.
    const auxDV = new DataView(this.ramDV.buffer, this.auxAddress);

    if (dis) {
      this.previewVertex(v0, n, dv, dis, light);
    }

    if (v0 + n >= 64) { // FIXME or 80 for later GBI
      this.warn('Too many verts');
      return;
    }

    const vtxStride = 12;

    const mvmtx = this.state.modelview[this.state.modelview.length - 1];
    const pmtx = this.state.projection[this.state.projection.length - 1];

    const wvp = pmtx.multiply(mvmtx);

    // Texture coords are provided in 11.5 fixed point format, so divide by 32 here to normalise
    const scaleS = this.state.texture.scaleS / 32.0;
    const scaleT = this.state.texture.scaleT / 32.0;

    const xyz = new Vector3();
    const normal = new Vector3();
    const transformedNormal = new Vector3();

    const viTransform = this.renderer.nativeTransform.viTransform;
    const vpTransform = this.state.viewport.transform;

    for (let i = 0; i < n; ++i) {
      const vtxBase = i * vtxStride;
      const vertex = this.state.projectedVertices[v0 + i];

      vertex.set = true;

      xyz.x = dv.getInt16(vtxBase + 0);
      xyz.y = dv.getInt16(vtxBase + 2);
      xyz.z = dv.getInt16(vtxBase + 4);
      // const pad = dv.getUint8(vtxBase + 6);
      const cIdx = dv.getUint8(vtxBase + 7);
      vertex.u = dv.getInt16(vtxBase + 8) * scaleS;
      vertex.v = dv.getInt16(vtxBase + 10) * scaleT;
      // Load as little-endian (ABGR) for convenience.
      vertex.color = auxDV.getUint32(cIdx + 0, true);

      // Project.
      const pos = vertex.pos;
      wvp.transformPoint(xyz, pos);

      // Divide out W.
      const w = pos.w;
      pos.scaleInPlace(1 / w);
      vpTransform.transformInPlace(pos);  // Translate into screen coords using the viewport.
      viTransform.invTransformInPlace(pos);  // Translate back to OpenGL normalized device coords.
      pos.scaleInPlace(w);

      // this.state.projectedVertices.clipFlags = this.calculateClipFlags(projected);

      if (light) {
        const alpha = vertex.color & 0xff;
        this.unpackNormal(normal, vertex.color);
        mvmtx.transformNormal(normal, transformedNormal);
        transformedNormal.normaliseInPlace();

        vertex.color = this.calculateLighting(transformedNormal, alpha);
        if (texgenlin) {
          vertex.calculateLinearUV(transformedNormal);
        } else if (texgen) {
          vertex.calculateSphericalUV(transformedNormal);
        }
      }
    }
  }
}

export class GBI0WR extends GBI0 {
  constructor(ucode, state, ramDV) {
    super(ucode, state, ramDV);
    this.vertexStride = 5;
  }

  executeVertex(cmd0, cmd1, dis) {
    const n = ((cmd0 >>> 9) & 0x7f);
    const v0 = ((cmd0 >>> 16) & 0xff) / 5;
    //const length = (cmd0 >>> 0) & 0x1ff;
    const address = this.state.rdpSegmentAddress(cmd1);

    if (dis) {
      dis.text(`gsSPVertex(${toString32(address)}, ${n}, ${v0});`);
    }

    this.loadVertices(v0, n, address, dis);
  }
}

export class GBI0DKR extends GBI0 {
  constructor(ucode, state, ramDV) {
    super(ucode, state, ramDV);
    this.vertexStride = 10;
  }
}

export class GBI0SE extends GBI0 {
  constructor(ucode, state, ramDV) {
    super(ucode, state, ramDV);
    this.vertexStride = 5;
  }
}

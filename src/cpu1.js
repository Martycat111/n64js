import { toString32 } from "./format.js";
import * as logger from './logger.js';

const FPCSR_RM_RN = 0x00000000;
const FPCSR_RM_RZ = 0x00000001;
const FPCSR_RM_RP = 0x00000002;
const FPCSR_RM_RM = 0x00000003;
const FPCSR_FI = 0x00000004;  // Flag, Inexact
const FPCSR_FU = 0x00000008;  // Flag, Underflow
const FPCSR_FO = 0x00000010;  // Flag, Overflow
const FPCSR_FZ = 0x00000020;  // Flag, Division by Zero
const FPCSR_FV = 0x00000040;  // Flag, Invalid
const FPCSR_EI = 0x00000080;  // Enable, Inexact
const FPCSR_EU = 0x00000100;  // Enable, Underflow
const FPCSR_EO = 0x00000200;  // Enable, Overflow
const FPCSR_EZ = 0x00000400;  // Enable, Division by Zero
const FPCSR_EV = 0x00000800;  // Enable, Invalid
const FPCSR_CI = 0x00001000;  // Cause, Inexact
const FPCSR_CU = 0x00002000;  // Cause, Underflow
const FPCSR_CO = 0x00004000;  // Cause, Overflow
const FPCSR_CZ = 0x00008000;  // Cause, Division by Zero
const FPCSR_CV = 0x00010000;  // Cause, Invalid
const FPCSR_CE = 0x00020000;  // Cause, Unimplemented
const FPCSR_C = 0x00800000;  // Condition
const FPCSR_FS = 0x01000000;  // Flush Subnormals

const FPCSR_RM_MASK = 0x00000003;

const exceptionInexactBit = 0x01;
const exceptionUnderflowBit = 0x02;
const exceptionOverflowBit = 0x04;
const exceptionDivByZeroBit = 0x08;
const exceptionInvalidBit = 0x10;

const flagShift = 2;
const enableShift = 7;
const causeShift = 12;

const flagMask = 0x0000007c;
const enableMask = 0x00000f80;
const causeMask = 0x0003f000; // Note this also includes FPCSR_CE.

function makeFlagBits(bits) { return bits << flagShift; }
function makeEnableBits(bits) { return bits << enableShift; }
function makeCauseBits(bits) { return bits << causeShift; }

// https://stackoverflow.com/questions/29666236
const f32SignBit = 0x8000_0000;
const f32ExponentBits = 0x7f80_0000;
const f32ManissaBits = 0x007f_ffff;
const f32QuietBit = (1 << 22);

const f32SignallingNaNBits = 0x7fbf_ffff;
const f32PosZeroBits = 0;
const f32NegZeroBits = f32SignBit;
const f32MinPosNumberBits = 0x0080_0000;
const f32MinNegNumberBits = f32SignBit | f32MinPosNumberBits;
const f32PosInfinityBits = f32ExponentBits;
const f32NegInfinityBits = f32SignBit | f32ExponentBits;

const f64SignBit = 0x8000_0000_0000_0000n;
const f64ExponentBits = 0x7ff0_0000_0000_0000n;
const f64ManissaBits = 0x000f_ffff_ffff_ffffn;
const f64QuietBit = (1n << 51n);

const f64SignallingNaNBits = 0x7ff7_ffff_ffff_ffffn;
const f64PosZeroBits = 0n;
const f64NegZeroBits = f64SignBit;
const f64MinPosNumberBits = 0x0010_0000_0000_0000n;
const f64MinNegNumberBits = f64SignBit | f64MinPosNumberBits;
const f64PosInfinityBits = f64ExponentBits;
const f64NegInfinityBits = f64SignBit | f64ExponentBits;


// Float classification.
const floatTypeNormal = 0;
const floatTypePosZero = 1;
const floatTypeNegZero = 2;
const floatTypePosInfinity = 3;
const floatTypeNegInfinity = 4;
const floatTypeQNaN = 5;
const floatTypeSNaN = 6;
const floatTypeDenormal = 7;
const numFloatTypes = 8;

function f32Classify(bits) {
  const exponent = bits & f32ExponentBits;
  const mantissa = bits & f32ManissaBits;

  // If the exponent bits are set, it's Infinity or a NaN.
  if (exponent == f32ExponentBits) {
    if (mantissa == 0) {
      return (bits & f32SignBit) ? floatTypeNegInfinity : floatTypePosInfinity;
    }
    return (bits & f32QuietBit) ? floatTypeQNaN : floatTypeSNaN;
  }
  if (exponent == 0) {
    if (mantissa != 0) {
      return floatTypeDenormal;
    }
    return (bits & f32SignBit) ? floatTypeNegZero : floatTypePosZero;
  }
  return floatTypeNormal;
}

function f64Classify(bits) {
  const exponent = bits & f64ExponentBits;
  const mantissa = bits & f64ManissaBits;

  // If the exponent bits are set, it's Infinity or a NaN.
  if (exponent == f64ExponentBits) {
    if (mantissa == 0) {
      return (bits & f64SignBit) ? floatTypeNegInfinity : floatTypePosInfinity;
    }
    return bits & f64QuietBit ? floatTypeQNaN : floatTypeSNaN;
  }
  if (exponent == 0) {
    if (mantissa != 0) {
      return floatTypeDenormal;
    }
    return (bits & f64SignBit) ? floatTypeNegZero : floatTypePosZero;
  }
  return floatTypeNormal;
}

function floatTypeNaN(t) { return t == floatTypeQNaN || t == floatTypeSNaN; }
function floatTypeZero(t) { return t == floatTypePosZero || t == floatTypeNegZero; }
function floatTypeInfinity(t) { return t == floatTypePosInfinity || t == floatTypeNegInfinity; }


function getUnderflowValue(cases, roundingMode, negative) {
  return cases[(roundingMode * 2) + (negative ? 1 : 0)];
}

function validateRoundingModeTable(cases) {
  if (cases.length != (4 * 2)) {
    throw "Case table is unexpected size.";
  }
  return cases;
}

// See page 238 of VR4300-Users-Manual.pdf.
const f32UnderflowResults = validateRoundingModeTable([
  // Negative, Positive
  f32NegZeroBits, f32PosZeroBits, // FPCSR_RM_RN
  f32NegZeroBits, f32PosZeroBits, // FPCSR_RM_RZ
  f32NegZeroBits, f32MinPosNumberBits, // FPCSR_RM_RP
  f32MinNegNumberBits, f32PosZeroBits, // FPCSR_RM_RM
]);

// See page 238 of VR4300-Users-Manual.pdf.
const f64UnderflowResults = validateRoundingModeTable([
  // Negative, Positive
  f64NegZeroBits, f64PosZeroBits, // FPCSR_RM_RN
  f64NegZeroBits, f64PosZeroBits, // FPCSR_RM_RZ
  f64NegZeroBits, f64MinPosNumberBits, // FPCSR_RM_RP
  f64MinNegNumberBits, f64PosZeroBits, // FPCSR_RM_RM
]);

// Operation types.
const opInvalid = 0;
const opUnimplm = 1;
const opDivZero = 2;
const opAdd = 3;
const opSub = 4;
const opMul = 5;
const opDiv = 6;
const opSqrt = 7;
const opAbs = 8;
const opNeg = 9;

function getUnaryOpCase(cases, sType) {
  return cases[sType];
}

function validateUnaryOpCaseTable(cases) {
  if (cases.length != numFloatTypes) {
    throw "Case table is unexpected size.";
  }
  return cases;
}

// Operation cases for sqrt.
const sqrtOpCases = validateUnaryOpCaseTable([
  // s = normal, posZero, negZero, posInf, negInf, qNaN, sNaN, denormal
  opSqrt, opSqrt, opSqrt, opSqrt, opInvalid, opInvalid, opUnimplm, opUnimplm,
]);

// Operation cases for abs.
const absOpCases = validateUnaryOpCaseTable([
  // s = normal, posZero, negZero, posInf, negInf, qNaN, sNaN, denormal
  opAbs, opAbs, opAbs, opAbs, opAbs, opInvalid, opUnimplm, opUnimplm,
]);

// Operation cases for neg.
const negOpCases = validateUnaryOpCaseTable([
  // s = normal, posZero, negZero, posInf, negInf, qNaN, sNaN, denormal
  opNeg, opNeg, opNeg, opNeg, opNeg, opInvalid, opUnimplm, opUnimplm,
]);

function getBinaryOpCase(cases, sType, tType) {
  return cases[(sType * numFloatTypes) + tType];
}

function validateBinaryOpCaseTable(cases) {
  if (cases.length != (numFloatTypes * numFloatTypes)) {
    throw "Case table is unexpected size.";
  }
  return cases;
}

// Operation cases for addition.
const addOpCases = validateBinaryOpCaseTable([
  // t = normal, posZero, negZero, posInf, negInf, qNaN, sNaN, denormal
  opAdd,     opAdd,     opAdd,     opAdd,     opAdd,     opInvalid, opUnimplm, opUnimplm,   // s = normal
  opAdd,     opAdd,     opAdd,     opAdd,     opAdd,     opInvalid, opUnimplm, opUnimplm,   // s = posZero
  opAdd,     opAdd,     opAdd,     opAdd,     opAdd,     opInvalid, opUnimplm, opUnimplm,   // s = negZero
  opAdd,     opAdd,     opAdd,     opAdd,     opInvalid, opInvalid, opUnimplm, opUnimplm,   // s = posInf
  opAdd,     opAdd,     opAdd,     opInvalid, opAdd,     opInvalid, opUnimplm, opUnimplm,   // s = negInf
  opInvalid, opInvalid, opInvalid, opInvalid, opInvalid, opInvalid, opUnimplm, opUnimplm,   // s = qNaN
  opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm,   // s = sNaN
  opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm,   // s = denormal
]);

// Operation cases for subtraction.
const subOpCases = validateBinaryOpCaseTable([
  // t = normal, posZero, negZero, posInf, negInf, qNaN, sNaN, denormal
  opSub,     opSub,     opSub,     opSub,     opSub,     opInvalid, opUnimplm, opUnimplm,   // s = normal
  opSub,     opSub,     opSub,     opSub,     opSub,     opInvalid, opUnimplm, opUnimplm,   // s = posZero
  opSub,     opSub,     opSub,     opSub,     opSub,     opInvalid, opUnimplm, opUnimplm,   // s = negZero
  opSub,     opSub,     opSub,     opSub,     opSub,     opInvalid, opUnimplm, opUnimplm,   // s = posInf
  opSub,     opSub,     opSub,     opSub,     opSub,     opInvalid, opUnimplm, opUnimplm,   // s = negInf
  opInvalid, opInvalid, opInvalid, opInvalid, opInvalid, opInvalid, opUnimplm, opUnimplm,   // s = qNaN
  opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm,   // s = sNaN
  opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm,   // s = denormal
]);

// Operation cases for multiplication.
const mulOpCases = validateBinaryOpCaseTable([
  // t = normal, posZero, negZero, posInf, negInf, qNaN, sNaN, denormal
  opMul,     opMul,     opMul,     opMul,     opMul,     opInvalid, opUnimplm, opUnimplm,   // s = normal
  opMul,     opMul,     opMul,     opInvalid, opInvalid, opInvalid, opUnimplm, opUnimplm,   // s = posZero
  opMul,     opMul,     opMul,     opInvalid, opInvalid, opInvalid, opUnimplm, opUnimplm,   // s = negZero
  opMul,     opInvalid, opInvalid, opMul,     opMul,     opInvalid, opUnimplm, opUnimplm,   // s = posInf
  opMul,     opInvalid, opInvalid, opMul,     opMul,     opInvalid, opUnimplm, opUnimplm,   // s = negInf
  opInvalid, opInvalid, opInvalid, opInvalid, opInvalid, opInvalid, opUnimplm, opUnimplm,   // s = qNaN
  opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm,   // s = sNaN
  opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm,   // s = denormal
]);

// Operation cases for division.
const divOpCases = validateBinaryOpCaseTable([
  // t = normal, posZero, negZero, posInf, negInf, qNaN, sNaN, denormal
  opDiv,     opDivZero, opDivZero, opDiv,     opDiv,     opInvalid, opUnimplm, opUnimplm,   // s = normal
  opDiv,     opInvalid, opDivZero, opDiv,     opDiv,     opInvalid, opUnimplm, opUnimplm,   // s = posZero
  opDiv,     opInvalid, opDivZero, opDiv,     opDiv,     opInvalid, opUnimplm, opUnimplm,   // s = negZero
  opDiv,     opDivZero, opDivZero, opInvalid, opInvalid, opInvalid, opUnimplm, opUnimplm,   // s = posInf
  opDiv,     opDivZero, opDivZero, opInvalid, opInvalid, opInvalid, opUnimplm, opUnimplm,   // s = negInf
  opInvalid, opInvalid, opInvalid, opInvalid, opInvalid, opInvalid, opUnimplm, opUnimplm,   // s = qNaN
  opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm,   // s = sNaN
  opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm, opUnimplm,   // s = denormal
]);

export const convertModeRound = 0;
export const convertModeTrunc = 1;
export const convertModeCeil = 2;
export const convertModeFloor = 3;

export class CPU1 {
  constructor(cpu0) {
    this.cpu0 = cpu0;
    this.control = new Uint32Array(32);

    this.mem     = new ArrayBuffer(32 * 8);   // 32 64-bit regs
    this.regF32 = new Float32Array(this.mem);
    this.regF64 = new Float64Array(this.mem);
    this.regS32 = new Int32Array(this.mem);
    this.regU32 = new Uint32Array(this.mem);
    this.regS64 = new BigInt64Array(this.mem);
    this.regU64 = new BigUint64Array(this.mem);

    this.regIdx32 = new Uint32Array(new ArrayBuffer(32 * 4));
    this.regIdx64 = new Uint32Array(new ArrayBuffer(32 * 4));

    // A single register for conversions.
    this.tempBuf = new ArrayBuffer(8);
    this.tempF32 = new Float32Array(this.tempBuf);
    this.tempF64 = new Float64Array(this.tempBuf);
    this.tempU32 = new Uint32Array(this.tempBuf);
    this.tempS32 = new Int32Array(this.tempBuf);
    this.tempU64 = new BigUint64Array(this.tempBuf);
    this.tempS64 = new BigInt64Array(this.tempBuf);

    this._fullMode = true;
    this.fullMode = true;
  }

  reset() {
    for (var i = 0; i < 32; ++i) {
      this.control[i] = 0;
      this.regS64[i] = 0n;
    }

    this.control[0] = 0x00000511;
    this.fullMode = true;
  }

  /**
   * Set the register mode (full or half width).
   * @param {boolean} value
   */
  set fullMode(value) {
    this._fullMode = value;

    if (this._fullMode) {
      for (let i = 0; i < 32; i++) {
        this.regIdx32[i] = (i * 2) + 0;
        this.regIdx64[i] = i;
      }
    } else {
      for (let i = 0; i < 32; i++) {
        const even = i & ~1;
        this.regIdx32[i] = (even * 2) + (i & 1);
        this.regIdx64[i] = even;
      }
    }
  }

  handleFloatCompareSingle(op, s, t) {
    const fsi = this.loadS32(s);
    const fti = this.loadS32(t);

    const fsType = f32Classify(fsi);
    const ftType = f32Classify(fti);

    let c = false;
    if (floatTypeNaN(fsType) || floatTypeNaN(ftType)) {
      if ((op & 0x8) || fsType == floatTypeQNaN || ftType == floatTypeQNaN) {
        if (this.raiseException(exceptionInvalidBit)) {
          return;
        }
      }
      if (op & 0x1) c = true;
    } else {
      const fs = this.loadF32(s);
      const ft = this.loadF32(t);

      if (op & 0x4) c |= fs < ft;
      if (op & 0x2) c |= fs == ft;
    }
    this.setCondition(c);
  }

  handleFloatCompareDouble(op, s, t) {
    const fsi = this.loadS64(s);
    const fti = this.loadS64(t);

    const fsType = f64Classify(fsi);
    const ftType = f64Classify(fti);

    let c = false;
    if (floatTypeNaN(fsType) || floatTypeNaN(ftType)) {
      if ((op & 0x8) || fsType == floatTypeQNaN || ftType == floatTypeQNaN) {
        if (this.raiseException(exceptionInvalidBit)) {
          return;
        }
      }
      if (op & 0x1) c = true;
    } else {
      const fs = this.loadF64(s);
      const ft = this.loadF64(t);

      if (op & 0x4) c |= fs < ft;
      if (op & 0x2) c |= fs == ft;
    }
    this.setCondition(c);
  }

  DCFC1(rt, fs) {
    this.clearCause();
    this.raiseUnimplemented();
  }

  DCTC1(fs, rt) {
    this.clearCause();
    this.raiseUnimplemented();
  }

  // Move bits directly, to avoid renomalisation.
  MOV_S(d, s) { this.storeS32(d, this.loadS32(s)); }

  SQRT_S(d, s) { this.f32UnaryOp(d, s, sqrtOpCases); }
  ABS_S(d, s) { this.f32UnaryOp(d, s, absOpCases); }
  NEG_S(d, s) { this.f32UnaryOp(d, s, negOpCases); }
  ADD_S(d, s, t) { this.f32BinaryOp(d, s, t, addOpCases); }
  SUB_S(d, s, t) { this.f32BinaryOp(d, s, t, subOpCases); }
  MUL_S(d, s, t) { this.f32BinaryOp(d, s, t, mulOpCases); }
  DIV_S(d, s, t) { this.f32BinaryOp(d, s, t, divOpCases); }

  // Move bits directly, to avoid renomalisation.
  MOV_D(d, s) { this.storeS64(d, this.loadS64(s)); }

  SQRT_D(d, s) { this.f64UnaryOp(d, s, sqrtOpCases); }
  ABS_D(d, s) { this.f64UnaryOp(d, s, absOpCases); }
  NEG_D(d, s) { this.f64UnaryOp(d, s, negOpCases); }
  ADD_D(d, s, t) { this.f64BinaryOp(d, s, t, addOpCases); }
  SUB_D(d, s, t) { this.f64BinaryOp(d, s, t, subOpCases); }
  MUL_D(d, s, t) { this.f64BinaryOp(d, s, t, mulOpCases); }
  DIV_D(d, s, t) { this.f64BinaryOp(d, s, t, divOpCases); }

  CVT_S_D(d, s) {
    this.clearCause();

    const sBits = this.loadS64(s);
    const sType = f64Classify(sBits);

    let exceptionBits = 0;
    switch (sType) {
      case floatTypeSNaN:
      case floatTypeDenormal:
        this.raiseUnimplemented();
        return;
      case floatTypeQNaN:
        exceptionBits |= exceptionInvalidBit;
        this.tempU32[0] = f32SignallingNaNBits;
        break;
      case floatTypePosInfinity:
        this.tempU32[0] = f32PosInfinityBits;
        break;
      case floatTypeNegInfinity:
        this.tempU32[0] = f32NegInfinityBits;
        break;
      default:
        const sValue = this.loadF64(s);
        this.tempF32[0] = sValue;

        if (sValue != this.tempF32[0]) {
          exceptionBits |= exceptionInexactBit;
        }
        // TODO: this is really this.tempF32[0] > float32 max value
        if (!isFinite(this.tempF32[0])) {
          exceptionBits |= exceptionOverflowBit;
        }
        break;
    }

    if (this.raiseException(exceptionBits)) {
      return;
    }
    this.storeS32(d, this.tempU32[0]);
  }

  CVT_S_W(d, s) {
    this.clearCause();
    this.storeF32(d, this.loadS32(s));
  }

  CVT_S_L(d, s) {
    this.clearCause();

    const source = this.loadS64(s);
    if (source >= (1n << 55n) || source < -(1n << 55n)) {
      this.raiseUnimplemented();
      return;
    }
    
    let exceptionBits = 0;
    this.tempF32[0] = Number(source);
    
    if (this.raiseException(exceptionBits)) {
      return;
    }
    this.storeS32(d, this.tempU32[0]);
  }

  f32UnaryOp(d, s, cases) {
    this.clearCause();

    const sValue = this.loadF32(s);
    const sBits = this.loadS32(s);
    const sType = f32Classify(sBits);
    const opCase = getUnaryOpCase(cases, sType);

    // Keep track of the intermediate result, as it's needed to figure
    // out if we saw underflow, overflow etc.
    let result;  
    switch (opCase) {
      case opUnimplm:
        this.raiseUnimplemented();
        return;
      case opInvalid:
        if (!this.raiseException(exceptionInvalidBit)) {
          this.storeS32(d, f32SignallingNaNBits);
        }
        return;
      case opSqrt:
        if (sValue < 0) {
          if (!this.raiseException(exceptionInvalidBit)) {
            this.storeS32(d, f32SignallingNaNBits);
          }
          return;
        }
        result =  Math.sqrt(sValue);
        break;
      case opAbs:
        result = Math.abs(sValue);
        break;
      case opNeg:
        result = -sValue;
        break;
      default:
        throw `unhandled op case: ${opCase}`;
    }

    // Store the result as a float32 so we can see if it loses precision.
    this.tempF32[0] = result;
    const rType = f32Classify(this.tempU32[0]);

    let exceptionBits = 0;

    // Check for inexact result (result changed value).
    if (result != this.tempF32[0]) {
      exceptionBits |= exceptionInexactBit;
    }

    // Check for overflow (finite operands produced infinity).
    if (floatTypeInfinity(rType) && !floatTypeInfinity(sType)) {
      // See page 239 of VR4300-Users-Manual.pdf.
      //   With the IEEE754, the inexact operation exception occurs only if an
      //   overflow occurs only when the overflow exception is disabled.
      //   However, the VR4300 always generates the overflow exception and
      //   inexact operation exception when an overflow occurs. 
      exceptionBits |= exceptionInexactBit | exceptionOverflowBit;

      // TODO: set the output based on the rounding mode.
    }

    // TODO: check for underflow?

    if (!this.raiseException(exceptionBits)) {
      this.storeS32(d, this.tempU32[0]);
    }
  }

  f32BinaryOp(d, s, t, cases) {
    this.clearCause();

    const sValue = this.loadF32(s);
    const tValue = this.loadF32(t);
    const sBits = this.loadS32(s);
    const tBits = this.loadS32(t);
    const sType = f32Classify(sBits);
    const tType = f32Classify(tBits);
    const opCase = getBinaryOpCase(cases, sType, tType);
    
    // Keep track of the intermediate result, as it's needed to figure
    // out if we saw underflow, overflow etc.
    let result;
    switch (opCase) {
      case opUnimplm:
        this.raiseUnimplemented();
        return;
      case opInvalid:
        if (!this.raiseException(exceptionInvalidBit)) {
          this.storeS32(d, f32SignallingNaNBits);
        }
        return;
      case opDivZero:
        if (!this.raiseException(exceptionDivByZeroBit)) {
          const sameSign = (sBits & f32SignBit) == (tBits & f32SignBit)
          this.storeS32(d, sameSign ? f32PosInfinityBits : f32NegInfinityBits);
        }
        return;
      case opAdd:
        result = sValue + tValue;
        break;
      case opSub:
        result = sValue - tValue;
        break;
      case opMul:
        result = sValue * tValue;
        break;
      case opDiv:
        result = sValue / tValue;
        break;
      default:
        throw `unhandled op case: ${opCase}`;
    }

    // Store the result as a float32 so we can see if it loses precision.
    this.tempF32[0] = result;
    const rType = f32Classify(this.tempU32[0]);

    let exceptionBits = 0;

    // Check for inexact result (result changed value).
    if (result != this.tempF32[0]) {
      exceptionBits |= exceptionInexactBit;
    }

    if (opCase == opAdd || opCase == opSub) {
      // If the result is unchanged but the operand was non-zero then we lost precision.
      if ((!floatTypeZero(tType) && (result == sValue)) ||
        (!floatTypeZero(sType) && (result == tValue))) {
        exceptionBits |= exceptionInexactBit;
      }
    }

    // Check for overflow (finite operands produced infinity).
    if (floatTypeInfinity(rType) && !floatTypeInfinity(sType) && !floatTypeInfinity(tType)) {
      // See page 239 of VR4300-Users-Manual.pdf.
      //   With the IEEE754, the inexact operation exception occurs only if an
      //   overflow occurs only when the overflow exception is disabled.
      //   However, the VR4300 always generates the overflow exception and
      //   inexact operation exception when an overflow occurs. 
      exceptionBits |= exceptionInexactBit | exceptionOverflowBit;

      // TODO: set the output based on the rounding mode.
    }

    // Check for underflow (non-zero result became denormal or zero).
    if ((rType == floatTypeDenormal || floatTypeZero(rType)) && result != 0) {
      exceptionBits |= exceptionInexactBit | exceptionUnderflowBit;

      // Set the output based on the rounding mode.
      this.tempU32[0] = getUnderflowValue(f32UnderflowResults, this.control[31] & FPCSR_RM_MASK, result > 0);
    }  

    if (!this.raiseException(exceptionBits)) {
      // Store the underlying bits to avoid renormalising.
      this.storeS32(d, this.tempU32[0]);
    }
  }

  CVT_D_S(d, s) {
    this.clearCause();

    const sBits = this.loadS32(s);
    const sType = f32Classify(sBits);

    let exceptionBits = 0;
    switch (sType) {
      case floatTypeSNaN:
      case floatTypeDenormal:
        this.raiseUnimplemented();
        return;
      case floatTypeQNaN:
        exceptionBits |= exceptionInvalidBit;
        this.tempU64[0] = f64SignallingNaNBits;
        break;
      case floatTypePosInfinity:
        this.tempU64[0] = f64PosInfinityBits;
        break;
      case floatTypeNegInfinity:
        this.tempU64[0] = f64NegInfinityBits;
        break;
      default:
        const sValue = this.loadF32(s);
        this.tempF64[0] = sValue;
        break;
    }

    if (this.raiseException(exceptionBits)) {
      return;
    }
    this.storeU64(d, this.tempU64[0]);
  }

  CVT_D_W(d, s) {
    this.clearCause();
    this.storeF64(d, this.loadS32(s));
  }

  CVT_D_L(d, s) {
    this.clearCause();
    
    const source = this.loadS64(s);
    if (source >= (1n << 55n) || source < -(1n << 55n)) {
      this.raiseUnimplemented();
      return;
    }

    let exceptionBits = 0;
    this.tempF64[0] = Number(source);
  
    if (this.raiseException(exceptionBits)) {
      return;
    }
    this.storeU64(d, this.tempU64[0]);
  }

  f64UnaryOp(d, s, cases) {
    this.clearCause();

    const sValue = this.loadF64(s);
    const sBits = this.loadS64(s);
    const sType = f64Classify(sBits);
    const opCase = getUnaryOpCase(cases, sType);

    // Keep track of the intermediate result, as it's needed to figure
    // out if we saw underflow, overflow etc.
    let result;
    switch (opCase) {
      case opUnimplm:
        this.raiseUnimplemented();
        return;
      case opInvalid:
        if (!this.raiseException(exceptionInvalidBit)) {
          this.storeU64(d, f64SignallingNaNBits);
        }
        return;
      case opSqrt:
        if (sValue < 0) {
          if (!this.raiseException(exceptionInvalidBit)) {
            this.storeU64(d, f64SignallingNaNBits);
          }
          return;
        }
        result = Math.sqrt(sValue);
        break;
      case opAbs:
        result = Math.abs(sValue);
        break;
      case opNeg:
        result = -sValue;
        break;
      default:
        throw `unhandled op case: ${opCase}`;
    }

    // Store the result as a float64 so we can see if it loses precision.
    this.tempF64[0] = result;
    const rType = f64Classify(this.tempU64[0]);

    let exceptionBits = 0;

    // Check for inexact result (result changed value).
    if (result != this.tempF64[0]) {
      exceptionBits |= exceptionInexactBit;
    }

    // Check for overflow (finite operands produced infinity).
    if (floatTypeInfinity(rType) && !floatTypeInfinity(sType)) {
      // See page 239 of VR4300-Users-Manual.pdf.
      //   With the IEEE754, the inexact operation exception occurs only if an
      //   overflow occurs only when the overflow exception is disabled.
      //   However, the VR4300 always generates the overflow exception and
      //   inexact operation exception when an overflow occurs. 
      exceptionBits |= exceptionInexactBit | exceptionOverflowBit;

      // TODO: set the output based on the rounding mode.
    }

    // TODO: check for underflow?

    if (!this.raiseException(exceptionBits)) {
      this.storeU64(d, this.tempU64[0]);
    }
  }

  f64BinaryOp(d, s, t, cases) {
    this.clearCause();

    const sValue = this.loadF64(s);
    const tValue = this.loadF64(t);
    const sBits = this.loadS64(s);
    const tBits = this.loadS64(t);
    const sType = f64Classify(sBits);
    const tType = f64Classify(tBits);
    const opCase = getBinaryOpCase(cases, sType, tType);

    // Keep track of the intermediate result, as it's needed to figure
    // out if we saw underflow, overflow etc.
    let result;

    switch (opCase) {
      case opUnimplm:
        this.raiseUnimplemented();
        return;
      case opInvalid:
        if (!this.raiseException(exceptionInvalidBit)) {
          this.storeU64(d, f64SignallingNaNBits);
        }
        return;
      case opDivZero:
        if (!this.raiseException(exceptionDivByZeroBit)) {
          const sameSign = (sBits & f64SignBit) == (tBits & f64SignBit)
          this.storeU64(d, sameSign ? f64PosInfinityBits : f64NegInfinityBits);
        }
        return;
      case opAdd:
        result = sValue + tValue;
        break;
      case opSub:
        result = sValue - tValue;
        break;
      case opMul:
        result = sValue * tValue;
        break;
      case opDiv:
        result = sValue / tValue;
        break;
      default:
        throw `unhandled op case: ${opCase}`;
    }

    // Store the result as a float64 so we can see if it loses precision.
    this.tempF64[0] = result;
    const rType = f64Classify(this.tempU64[0]);

    let exceptionBits = 0;

    // Check for inexact result (result changed value).
    // FIXME: this won't work for f64 as the intermediate isn't held in higher precision in registers.
    // if (result != this.tempF64[0]) {
    //   exceptionBits |= exceptionInexactBit;
    // }

    if (opCase == opAdd || opCase == opSub) {
      // If the result is unchanged but the operand was non-zero then we lost precision.
      if ((!floatTypeZero(tType) && (result == sValue)) ||
        (!floatTypeZero(sType) && (result == tValue))) {
        exceptionBits |= exceptionInexactBit;
      }
    }

    // Check for overflow (finite operands produced infinity).
    if (floatTypeInfinity(rType) && !floatTypeInfinity(sType) && !floatTypeInfinity(tType)) {
      // See page 239 of VR4300-Users-Manual.pdf.
      //   With the IEEE754, the inexact operation exception occurs only if an
      //   overflow occurs only when the overflow exception is disabled.
      //   However, the VR4300 always generates the overflow exception and
      //   inexact operation exception when an overflow occurs. 
      exceptionBits |= exceptionInexactBit | exceptionOverflowBit;

      // TODO: set the output based on the rounding mode.
    }

    // Check for underflow (non-zero result became denormal or zero).
    if ((rType == floatTypeDenormal || floatTypeZero(rType)) && result != 0) {
      exceptionBits |= exceptionInexactBit | exceptionUnderflowBit;

      // Set the output based on the rounding mode.
      this.tempU64[0] = getUnderflowValue(f64UnderflowResults, this.control[31] & FPCSR_RM_MASK, result > 0);
    }  

    if (!this.raiseException(exceptionBits)) {
      // Store the underlying bits to avoid renormalising.
      this.storeU64(d, this.tempU64[0]);
    }
  }

  ConvertSToL(d, s, mode) {
    this.clearCause();

    const sBits = this.loadS32(s);
    const sType = f32Classify(sBits);

    let exceptionBits = 0;
    switch (sType) {
      case floatTypeSNaN:
      case floatTypeQNaN:
      case floatTypeDenormal:
      case floatTypePosInfinity:
      case floatTypeNegInfinity:
        this.raiseUnimplemented();
        return;
      default:
        const sValue = this.loadF32(s);
        this.tempS64[0] = BigInt(this.convertUsingMode(sValue, mode) | 0); // Force to int to allow BigInt conversion.
        if (sValue != this.tempS64[0]) {
          exceptionBits |= exceptionInexactBit;
        }
        break;
    }

    if (this.raiseException(exceptionBits)) {
      return;
    }
    this.storeU64(d, this.tempS64[0]);
  }

  ConvertDToL(d, s, mode) {
    this.clearCause();

    const sBits = this.loadS64(s);
    const sType = f64Classify(sBits);

    let exceptionBits = 0;
    switch (sType) {
      case floatTypeSNaN:
      case floatTypeQNaN:
      case floatTypeDenormal:
      case floatTypePosInfinity:
      case floatTypeNegInfinity:
        this.raiseUnimplemented();
        return;
      default:
        const sValue = this.loadF64(s);
        this.tempS64[0] = BigInt(this.convertUsingMode(sValue, mode) | 0); // Force to int to allow BigInt conversion.
        if (sValue != this.tempS64[0]) {
          exceptionBits |= exceptionInexactBit;
        }
        break;
    }

    if (this.raiseException(exceptionBits)) {
      return;
    }
    this.storeU64(d, this.tempS64[0]);
  }

  ConvertSToW(d, s, mode) {
    this.clearCause();

    const sBits = this.loadS32(s);
    const sType = f32Classify(sBits);

    let exceptionBits = 0;
    switch (sType) {
      case floatTypeSNaN:
      case floatTypeQNaN:
      case floatTypeDenormal:
      case floatTypePosInfinity:
      case floatTypeNegInfinity:
        this.raiseUnimplemented();
        return;
      default:
        const sValue = this.loadF32(s);
        this.tempS32[0] = this.convertUsingMode(sValue, mode);
        if (sValue != this.tempS32[0]) {
          exceptionBits |= exceptionInexactBit;
        }
        break;
    }

    if (this.raiseException(exceptionBits)) {
      return;
    }
    this.storeS32(d, this.tempS32[0]);
  }

  ConvertDToW(d, s, mode) {
    this.clearCause();

    const sBits = this.loadS64(s);
    const sType = f64Classify(sBits);

    let exceptionBits = 0;
    switch (sType) {
      case floatTypeSNaN:
      case floatTypeQNaN:
      case floatTypeDenormal:
      case floatTypePosInfinity:
      case floatTypeNegInfinity:
        this.raiseUnimplemented();
        return;
      default:
        const sValue = this.loadF64(s);
        this.tempS32[0] = this.convertUsingMode(sValue, mode);
        if (sValue != this.tempS32[0]) {
          exceptionBits |= exceptionInexactBit;
        }
        break;
    }

    if (this.raiseException(exceptionBits)) {
      return;
    }
    this.storeS32(d, this.tempS32[0]);
  }

  get roundingMode() {
    switch (this.control[31] & FPCSR_RM_MASK) {
      case FPCSR_RM_RN: return convertModeRound;
      case FPCSR_RM_RZ: return convertModeTrunc;
      case FPCSR_RM_RP: return convertModeCeil;
      case FPCSR_RM_RM: return convertModeFloor;
    }
    assert('unknown rounding mode');
  }

  convertUsingMode(x, mode) {
    switch (mode) {
      case convertModeRound: return this.round(x); break;
      case convertModeTrunc: return this.trunc(x); break;
      case convertModeCeil: return Math.ceil(x); break;
      case convertModeFloor: return Math.floor(x); break;
    }
    assert('unknown rounding mode');
  }

  // n64 round is a different to Math.round.
  // Values exactly midway between two ints are rounded up or down,
  // depending on whether the integer part is even or odd.
  round(x) {
    const floor = Math.floor(x);
    const frac = x - floor;
    if (frac == 0.5) {
      const ceil = Math.ceil(x);
      if (x < 0) {
        const odd = ceil % 2 != 0;
        return odd ? floor : ceil;
      }
      const odd = floor % 2 != 0;
      return odd ? ceil : floor;
    }
    return Math.round(x);
  }

  trunc(x) {
    if (x < 0) {
      return Math.ceil(x);
    }
    return Math.floor(x);
  }; 

  /**
   * Set the condition control bit.
   * @param {boolean} enable
   */
  setCondition(enable) {
    if (enable) {
      this.control[31] |=  FPCSR_C;
    } else {
      this.control[31] &= ~FPCSR_C;
    }
  }

  get flushSubnormals() { 
    return (this.control[31] & FPCSR_FS) != 0;
  }

  clearCause() { this.control[31] &= ~causeMask; }

  // If these return true, an exception has been raised and the operation should
  // not continue.
  raiseException(exceptionBits) {
    if (!exceptionBits) {
      return false;
    }

    if (exceptionBits & exceptionUnderflowBit) {
      // See page 239 of VR4300-Users-Manual.pdf.
      //   If both the underflow exception and inexact operation exception are
      //   disabled when the exponent underflow occurs, and if the FS bit of
      //   FCR31 is set, the Cause bit and Flag bit of the underflow exception and
      //   inexact operation exception are set. Otherwise, the Cause bit of the
      //   unimplemented operation exception is set.
      const inexactOrUnderflowEnabled = (this.control[31] & (FPCSR_EU | FPCSR_EI)) != 0;
      if (inexactOrUnderflowEnabled || !this.flushSubnormals) {
        return this.raiseUnimplemented();
      }
    }

    const enable = makeEnableBits(exceptionBits);
    const cause = makeCauseBits(exceptionBits);
    const flag = makeFlagBits(exceptionBits);
    return this.setStatusBits(enable, cause, flag);
  }

  raiseUnimplemented(msg) {
    this.control[31] |= FPCSR_CE;
    this.cpu0.raiseFPE();
    return true;
  }

  setStatusBits(enable, cause, flag) {
    if (this.control[31] & enable) {
      this.control[31] |= cause;
      this.cpu0.raiseFPE();
      return true;
    }
    this.control[31] |= flag | cause;
    return false;
  }

  /**
   * @param {number} i The register index.
   * @param {number} value The value to store.
   */
  storeF32(i, value) {
    const regIdx = this.regIdx32[i];
    this.regF32[regIdx] = value;
  }

  /**
   * @param {number} i The register index.
   * @param {number} value The value to store.
   */
  storeS32(i, value) {
    const regIdx = this.regIdx32[i];
    this.regS32[regIdx] = value | 0;
  }

  /**
   * @param {number} i The register index.
   * @param {number} value The value to store.
   */
  storeF64(i, value) {
    const regIdx = this.regIdx64[i];
    this.regF64[regIdx] = value;
  }

  /**
   * @param {number} i The register index.
   * @param {bigint} value The value to store.
   */
  storeS64(i, value) {
    const regIdx = this.regIdx64[i];
    this.regS64[regIdx] = value;
  }

  /**
   * @param {number} i The register index.
   * @param {bigint} value The value to store.
   */
  storeU64(i, value) {
    const regIdx = this.regIdx64[i];
    this.regU64[regIdx] = value;
  }

  /**
   * @param {number} i The register index.
   * @return {number}
   */
  loadF32(i) {
    const regIdx = this.regIdx32[i];
    return this.regF32[regIdx];
  }

  /**
   * @param {number} i The register index.
   * @return {number}
   */
  loadS32(i) {
    const regIdx = this.regIdx32[i];
    return this.regS32[regIdx];
  }

  /**
   * @param {number} i The register index.
   * @return {number}
   */
  loadF64(i) {
    const regIdx = this.regIdx64[i];
    return this.regF64[regIdx];
  }

  /**
   * Returns the signed 64 bit value at the provided register index.
   * @param {number} i The register index.
   * @return {bigint}
   */
  loadS64(i) {
    const regIdx = this.regIdx64[i];
    return this.regS64[regIdx];
  }

  /**
   * Returns the unsigned 64 bit value at the provided register index.
   * @param {number} i The register index.
   * @return {bigint}
   */
  loadU64(i) {
    const regIdx = this.regIdx64[i];
    return this.regU64[regIdx];
  }

  dump() {
    let s = 'Regs: ';
    for (let i = 0; i < 4; +i++) {
      s += toString32(this.regS32[i]) + ', ';
    }
    logger.log(s);
    logger.log(`float64: [${this.regF64[0]}, ${this.regF64[1]}, ...]`);
  }
}

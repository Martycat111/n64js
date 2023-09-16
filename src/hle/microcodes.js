import * as logger from '../logger.js';
import * as gbi0 from './gbi0.js';
import * as gbi1 from './gbi1.js';
import * as gbi2 from './gbi2.js';

const kUCode_GBI0 = 0;         // Super Mario 64, Tetrisphere, Demos
const kUCode_GBI1 = 1;         // Mario Kart, Star Fox
const kUCode_GBI2 = 2;         // Zelda, and newer games
const kUCode_GBI1_SDEX = 3;    // Yoshi's Story, Pokemon Puzzle League
const kUCode_GBI2_SDEX = 4;    // Neon Evangelion, Kirby
const kUCode_GBI0_WR = 5;      // Wave Racer USA
const kUCode_GBI0_DKR = 6;     // Diddy Kong Racing, Gemini, and Mickey
const kUCode_GBI1_LL = 7;      // Last Legion, Toukon, Toukon 2
const kUCode_GBI0_SE = 8;      // Shadows of the Empire (SOTE)
const kUCode_GBI0_GE = 9;      // Golden Eye
const kUCode_GBI2_CONKER = 10; // Conker BFD
const kUCode_GBI0_PD = 11;     // Perfect Dark

const ucodeOverrides = new Map([
  [0x60256efc, kUCode_GBI2_CONKER],	// "RSP Gfx ucode F3DEXBG.NoN fifo 2.08  Yoshitaka Yasumoto 1999 Nintendo.", "Conker's Bad Fur Day"
  [0x6d8bec3e, kUCode_GBI1_LL],	    // "Dark Rift"
  [0x0c10181a, kUCode_GBI0_DKR],	  // "Diddy Kong Racing (v1.0)"
  [0x713311dc, kUCode_GBI0_DKR],	  // "Diddy Kong Racing (v1.1)"
  [0x23f92542, kUCode_GBI0_GE],	    // "RSP SW Version: 2.0G, 09-30-96", "GoldenEye 007"
  [0x169dcc9d, kUCode_GBI0_DKR],	  // "Jet Force Gemini"											
  [0x26da8a4c, kUCode_GBI1_LL],	    // "Last Legion UX"				
  [0xcac47dc4, kUCode_GBI0_PD],	    // "Perfect Dark (v1.1)"
  [0x6cbb521d, kUCode_GBI0_SE],	    // "RSP SW Version: 2.0D, 04-01-96", "Star Wars - Shadows of the Empire (v1.0)"
  [0xdd560323, kUCode_GBI1_LL],	    // "Toukon Road - Brave Spirits"				
  [0x64cc729d, kUCode_GBI0_WR],	    // "RSP SW Version: 2.0D, 04-01-96", "Wave Race 64"
  [0xd73a12c4, kUCode_GBI0],        // Fish demo
  [0x313f038b, kUCode_GBI0],        // Pilotwings
]);

export function create(task, state, ramDV) {
  const ucode = detect(task);
  switch (ucode) {
    case kUCode_GBI0:
      return new gbi0.GBI0(ucode, state, ramDV);
    case kUCode_GBI0_DKR:
      return new gbi0.GBI0DKR(ucode, state, ramDV);
    case kUCode_GBI0_SE:
      return new gbi0.GBI0SE(ucode, state, ramDV);
    case kUCode_GBI0_PD:
      return new gbi0.GBI0PD(ucode, state, ramDV);
    case kUCode_GBI0_GE:
      return new gbi0.GBI0GE(ucode, state, ramDV);
    case kUCode_GBI0_WR:
      return new gbi0.GBI0WR(ucode, state, ramDV);
    case kUCode_GBI1:
      return new gbi1.GBI1(ucode, state, ramDV);
    case kUCode_GBI1_LL:
      return new gbi1.GBI1LL(ucode, state, ramDV);
    case kUCode_GBI1_SDEX:
      return new gbi1.GBI1SDEX(ucode, state, ramDV);
    case kUCode_GBI2:
      return new gbi2.GBI2(ucode, state, ramDV);
    case kUCode_GBI2_CONKER:
      return new gbi2.GBI2Conker(ucode, state, ramDV);
    case kUCode_GBI2_SDEX:
      return new gbi2.GBI2SDEX(ucode, state, ramDV);
  }
  logger.log(`unhandled ucode during table init: ${ucode}`);
  return new gbi0.GBI0(ucode, state, ramDV);
}

function detect(task) {
  const str = task.detectVersionString();
  const hash = task.computeMicrocodeHash();
  let ucode = ucodeOverrides.get(hash);
  if (ucode === undefined) {
    ucode = inferUcodeFromString(str)
  }

  logMicrocode(str, ucode);
  return ucode;
}

const loggedMicrocodes = new Map();

function logMicrocode(str, ucode) {
  if (loggedMicrocodes.get(str)) {
    return;
  }
  loggedMicrocodes.set(str, true);
  logger.log(`New RSP graphics ucode seen: ${str} = ucode ${ucode}`);
}

function inferUcodeFromString(str) {
  const prefixes = ['F3', 'L3', 'S2DEX'];
  let index = -1;
  for (let prefix of prefixes) {
    index = str.indexOf(prefix);
    if (index >= 0) {
      break;
    }
  }
  if (index >= 0) {
    if (str.indexOf('fifo', index) >= 0 || str.indexOf('xbux', index) >= 0) {
      return (str.indexOf('S2DEX') >= 0) ? kUCode_GBI2_SDEX : kUCode_GBI2;
    }
    return (str.indexOf('S2DEX') >= 0) ? kUCode_GBI1_SDEX : kUCode_GBI1;
  }
  // Assume this is GBI0 unless we get a better match.
  return kUCode_GBI0;
}
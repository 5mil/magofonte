'use strict';
/**
 * pool/algos/index.js
 * Algo registry — maps algo name → hash function.
 *
 * DGB has 5 mining algorithms:
 *   skein    — existing pool/skein.js
 *   scrypt   — pool/algos/scrypt.js
 *   qubit    — pool/algos/qubit.js
 *   odocrypt — pool/algos/odocrypt.js  (rotates every 10 days)
 *   sha256d  — pool/algos/sha256d.js
 *
 * Usage:
 *   const algos = require('./algos');
 *   const hash  = algos.resolve('scrypt');
 *   const result = hash(header80Buffer);
 */

const { dgbScryptHash } = require('./scrypt');
const { qubitHash }     = require('./qubit');
const { odoCryptHash }  = require('./odocrypt');
const { sha256dHash }   = require('./sha256d');

// Load skein from parent pool/skein.js
let skeinHash = null;
try {
  const s = require('../skein');
  skeinHash = s.doubleSkeinHash || s.skeinHash || s.hash || null;
  if (!skeinHash) {
    // pool/skein.js may export a class — try calling it
    const keys = Object.keys(s).filter(k => typeof s[k] === 'function');
    if (keys.length) skeinHash = s[keys[0]];
  }
} catch (e) {
  console.warn('[algos] skein not loaded:', e.message);
}

const ALGOS = {
  skein:    { fn: skeinHash,    coin: 'DGB', active: true  },
  scrypt:   { fn: dgbScryptHash,coin: 'DGB', active: true  },
  qubit:    { fn: qubitHash,    coin: 'DGB', active: true  },
  odocrypt: { fn: odoCryptHash, coin: 'DGB', active: true  },
  sha256d:  { fn: sha256dHash,  coin: 'DGB', active: true  },
};

/**
 * resolve(name) → hash function(header80: Buffer) → Buffer(32)
 * Throws if algo not found or not loaded.
 */
function resolve(name) {
  const algo = ALGOS[name?.toLowerCase()];
  if (!algo)     throw new Error(`[algos] Unknown algo: ${name}`);
  if (!algo.fn)  throw new Error(`[algos] ${name} has no hash fn loaded`);
  return algo.fn;
}

/**
 * list() → Array of { name, coin, active, loaded }
 */
function list() {
  return Object.entries(ALGOS).map(([name, m]) => ({
    name, coin: m.coin, active: m.active, loaded: !!m.fn
  }));
}

/**
 * resolveFromHeader(algoName, nTime) → hash function
 * For OdoCrypt, nTime is used to derive the current seed.
 * For all others, nTime is ignored.
 */
function resolveFromHeader(algoName, nTime) {
  if (algoName?.toLowerCase() === 'odocrypt') {
    // Return a closure that passes nTime through to odoCryptHash
    const { odoCryptHash: odoFn } = require('./odocrypt');
    return (header80) => {
      // odoCryptHash already reads nTime from bytes 68-71 of the header
      // but if caller wants to override, they can patch header80 before calling
      return odoFn(header80);
    };
  }
  return resolve(algoName);
}

module.exports = { resolve, list, resolveFromHeader, ALGOS };

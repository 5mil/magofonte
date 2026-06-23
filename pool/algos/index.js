'use strict';
/**
 * pool/algos/index.js
 * Algo registry — maps algo name → hash function.
 * Import this in pool/hash.js or pool/index.js to resolve algos.
 *
 * Usage:
 *   const algos = require('./algos');
 *   const hash = algos.resolve('scrypt');
 *   const result = hash(header80Buffer);
 */

const { dgbScryptHash }  = require('./scrypt');
const { qubitHash }      = require('./qubit');
const { odoCryptHash }   = require('./odocrypt');
const { sha256dHash }    = require('./sha256d');

// skein is the existing pool/skein.js — keep relative path
let skeinHash;
try {
  const skein = require('../skein');
  skeinHash = skein.doubleSkeinHash || skein.hash;
} catch { skeinHash = null; }

const ALGOS = {
  skein:     { fn: skeinHash,     coin: 'DGB', active: true  },
  scrypt:    { fn: dgbScryptHash, coin: 'DGB', active: true  },
  qubit:     { fn: qubitHash,     coin: 'DGB', active: true  },
  odocrypt:  { fn: odoCryptHash,  coin: 'DGB', active: true  },
  sha256d:   { fn: sha256dHash,   coin: 'DGB', active: true  },
};

function resolve(name) {
  const algo = ALGOS[name.toLowerCase()];
  if (!algo) throw new Error(`Unknown algo: ${name}`);
  if (!algo.fn) throw new Error(`Algo ${name} has no hash function loaded`);
  return algo.fn;
}

function list() {
  return Object.entries(ALGOS).map(([name, meta]) => ({
    name,
    coin: meta.coin,
    active: meta.active,
    loaded: !!meta.fn
  }));
}

module.exports = { resolve, list, ALGOS };

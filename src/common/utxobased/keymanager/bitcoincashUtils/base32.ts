// @flow
/***
 * https://github.com/bitcoincashjs/cashaddr
 * Copyright (c) 2018 Matias Alejo Garcia
 * Copyright (c) 2017 Emilio Almansi
 * Distributed under the MIT software license, see the accompanying
 * file LICENSE or http://www.opensource.org/licenses/mit-license.php.
 */

/***
 * Charset containing the 32 symbols used in the base32 encoding.
 */
const CHARSET: string = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

/***
 * Inverted index mapping each symbol into its index within the charset.
 */

interface CHARSET_INVERSE_INDEX {
  [value: string]: number
}

const CHARSET_INVERSE_INDEX: CHARSET_INVERSE_INDEX = {
  q: 0,
  p: 1,
  z: 2,
  r: 3,
  y: 4,
  9: 5,
  x: 6,
  8: 7,
  g: 8,
  f: 9,
  2: 10,
  t: 11,
  v: 12,
  d: 13,
  w: 14,
  0: 15,
  s: 16,
  3: 17,
  j: 18,
  n: 19,
  5: 20,
  4: 21,
  k: 22,
  h: 23,
  c: 24,
  e: 25,
  6: 26,
  m: 27,
  u: 28,
  a: 29,
  7: 30,
  l: 31
}

/***
 * Encodes the given array of 5-bit integers as a base32-encoded string.
 *
 * @param {Array} data Array of integers between 0 and 31 inclusive.
 */
export function encode(data: number[]): string {
  let base32 = ''
  for (let i = 0; i < data.length; i++) {
    const value = data[i]
    if (value < 0 || value > 32) throw new Error(`InvalidArgument: ${value}`)
    base32 += CHARSET[value]
  }
  return base32
}

/***
 * Decodes the given base32-encoded string into an array of 5-bit integers.
 *
 * @param {string} base32
 */
export function decode(base32: string): number[] {
  const data = []
  type CHARSET_INVERSE_INDEX_KEYS = keyof CHARSET_INVERSE_INDEX
  for (let i = 0; i < base32.length; i++) {
    const value = base32[i]
    if (!(value in CHARSET_INVERSE_INDEX)) {
      throw new Error(`InvalidArgument: ${value} not in CHARSET_INVERSE_INDEX`)
    }
    data.push(CHARSET_INVERSE_INDEX[value])
  }
  return data
}

/**
 * Integer-level model of the multiplier structure this project emits.
 *
 * Kept deliberately separate from the VHDL emitter so the two can be checked
 * against each other: `arraymath.mjs` says what the arithmetic IS, `vhdl.mjs`
 * says how it is wired, and a test asserts they agree.
 *
 * Structure: ROW-WISE ACCUMULATION.
 *   - row k is operand A masked by bit k of B, shifted left by k
 *   - rows are added into a running 2N-bit accumulator by a ripple-carry adder
 *   - that is exactly integer addition, so correctness is checkable by
 *     construction rather than argued about
 *
 * An earlier carry-save column reduction was abandoned: two independent models
 * of it disagreed with integer multiplication, so there was no trustworthy
 * reference to build the emitter against.
 */

/** Split a value into its bits, LSB first. */
export function bitsOf(value, width) {
  return Array.from({ length: width }, (_, i) => (value >> i) & 1);
}

/**
 * The partial-product rows of an N x N unsigned multiply, LSB first.
 * Row k is `A` masked by bit k of `B`, shifted left by k.
 */
export function partialProductRows(a, b, width) {
  const rows = [];
  for (let k = 0; k < width; k++) {
    const include = (b >> k) & 1;
    rows.push(include ? (a << k) : 0);
  }
  return rows;
}

/** Integer ripple-carry addition, truncated to `width` bits. */
export function rippleAdd(x, y, width) {
  const mask = width >= 32 ? 0xffffffff : (1 << width) - 1;
  return (x + y) & mask;
}

/**
 * Per-bit full-adder chain for one accumulation step.
 *
 * Returns, for each bit position, the operands and the resulting sum/carry, so a
 * test can compare the emitted full-adder instances against this exactly.
 */
export function rippleAddTrace(x, y, cin, width) {
  const steps = [];
  let carry = cin ? 1 : 0;
  for (let i = 0; i < width; i++) {
    const xi = (x >> i) & 1;
    const yi = (y >> i) & 1;
    const sum = xi ^ yi ^ carry;
    const cout = (xi & yi) | (yi & carry) | (xi & carry);
    steps.push({ bit: i, x: xi, y: yi, cin: carry, sum, cout });
    carry = cout;
  }
  return { steps, carryOut: carry };
}

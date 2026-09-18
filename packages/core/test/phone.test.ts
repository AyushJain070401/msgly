import { describe, expect, it } from 'vitest';

import { describeE164Problem, isValidE164 } from '../src/index.js';

describe('isValidE164', () => {
  it('accepts well-formed international numbers', () => {
    expect(isValidE164('+15551234567')).toBe(true);
    expect(isValidE164('+911234567890')).toBe(true);
    expect(isValidE164('+442071838750')).toBe(true);
  });

  it('rejects the mistakes people actually make', () => {
    expect(isValidE164('15551234567')).toBe(false); // no +
    expect(isValidE164('+1 555 123 4567')).toBe(false); // spaces
    expect(isValidE164('+1-555-123-4567')).toBe(false); // dashes
    expect(isValidE164('(555) 123-4567')).toBe(false); // local format
    expect(isValidE164('+0123456789')).toBe(false); // country code 0
    expect(isValidE164('+1555123456789012')).toBe(false); // 16 digits
    expect(isValidE164('+123456')).toBe(false); // too short
    expect(isValidE164('+1555123456x')).toBe(false); // letters
  });

  it('rejects empty and non-string input', () => {
    expect(isValidE164('')).toBe(false);
    expect(isValidE164(undefined)).toBe(false);
    expect(isValidE164(null)).toBe(false);
  });
});

describe('describeE164Problem', () => {
  it('returns null for a valid number', () => {
    expect(describeE164Problem('+15551234567')).toBeNull();
  });

  it('reports a missing value', () => {
    expect(describeE164Problem(undefined)).toBe('is missing');
    expect(describeE164Problem('   ')).toBe('is missing');
  });

  it('suggests the + form when the country code is missing', () => {
    const msg = describeE164Problem('15551234567');
    expect(msg).toContain('missing the leading "+"');
    expect(msg).toContain('+15551234567');
  });

  it('calls out separators', () => {
    expect(describeE164Problem('+1-555-123-4567')).toContain('strip spaces, dashes');
  });

  it('distinguishes too short from too long', () => {
    expect(describeE164Problem('+123456')).toContain('too short');
    expect(describeE164Problem('+1555123456789012')).toContain('too long');
  });
});

describe('describeE164Problem does not misdiagnose', () => {
  it('names whitespace instead of claiming a length problem', () => {
    const msg = describeE164Problem(' +15551234567 ');
    expect(msg).toContain('whitespace');
    expect(msg).toContain('+15551234567');
    expect(msg).not.toContain('too long');
  });

  it('handles a trailing newline the same way', () => {
    expect(describeE164Problem('+15551234567\n')).toContain('whitespace');
  });

  it('names a doubled "+" instead of miscounting digits', () => {
    const msg = describeE164Problem('++15551234567');
    expect(msg).toContain('more than one "+"');
    expect(msg).not.toContain('too long');
  });

  it('never reports "too long" for something inside the digit limit', () => {
    for (const v of [' +15551234567 ', '++15551234567', '+1 555 123 4567', '+1-555-123-4567']) {
      expect(describeE164Problem(v)).not.toContain('max 15');
    }
  });

  it('still reports a genuinely over-long number', () => {
    expect(describeE164Problem('+12345678901234567')).toContain('too long');
  });
});

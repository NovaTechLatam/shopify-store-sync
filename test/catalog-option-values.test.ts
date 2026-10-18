import { describe, expect, it } from 'vitest';

// The catalog editor's helper (public/js), loaded like the browser does.
const clientPath = new URL('../public/js/option-values.js', import.meta.url).href;
const { parseOptionValues, optionValuesText } = (await import(clientPath)) as {
  parseOptionValues: (text: string) => string[];
  optionValuesText: (values: string[]) => string;
};

describe('option values in the catalog editor', () => {
  it('reads one value per line, keeping commas inside a value', () => {
    expect(parseOptionValues('Red, matte\nBlue, glossy\n')).toEqual(['Red, matte', 'Blue, glossy']);
    expect(parseOptionValues('S\r\nM\rL')).toEqual(['S', 'M', 'L']);
  });

  it('drops blank lines, surrounding spaces and repeats', () => {
    expect(parseOptionValues('  S \n\n M\nS\n   \n')).toEqual(['S', 'M']);
    expect(parseOptionValues('')).toEqual([]);
  });

  it('writes the values back the way it reads them', () => {
    const values = ['10, 12 (EU)', 'One size', 'Navy / white'];
    expect(parseOptionValues(optionValuesText(values))).toEqual(values);
  });
});

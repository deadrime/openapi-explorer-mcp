/**
 * Token counts for bench reports. o200k is a proxy: absolute numbers differ between model tokenizers, ratios
 * between two outputs hold well enough to compare formats.
 */
import { Tiktoken } from 'js-tiktoken/lite';
import o200k from 'js-tiktoken/ranks/o200k_base';

const encoder = new Tiktoken(o200k);

/**
 * Number of o200k tokens in a text.
 */
export function countTokens(text) {
  return encoder.encode(text).length;
}

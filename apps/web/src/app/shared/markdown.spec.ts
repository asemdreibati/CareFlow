import { describe, expect, it } from 'vitest';
import { parse } from './markdown';

describe('markdown parse', () => {
  it('renders headings, bullets and paragraphs with escaping', () => {
    const blocks = parse('# Summary\n\nPatient is **stable** <b>.\n- item one\n- item two\n\n## Plan');
    expect(blocks).toEqual([
      { kind: 'h1', text: 'Summary' },
      { kind: 'p', text: 'Patient is <strong>stable</strong> &lt;b&gt;.' },
      { kind: 'ul', items: ['item one', 'item two'] },
      { kind: 'h2', text: 'Plan' },
    ]);
  });
});

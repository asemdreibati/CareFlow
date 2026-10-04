import { Component, computed, input } from '@angular/core';

interface Block { kind: 'h1' | 'h2' | 'h3' | 'p' | 'ul'; text?: string; items?: string[]; }

/** Minimal markdown-ish renderer: headings (#), bullets (-, *), paragraphs; **bold** inline. */
@Component({
  selector: 'cf-markdown',
  template: `
    <div class="markdown">
      @for (b of blocks(); track $index) {
        @switch (b.kind) {
          @case ('h1') { <h1 [innerHTML]="b.text"></h1> }
          @case ('h2') { <h2 [innerHTML]="b.text"></h2> }
          @case ('h3') { <h3 [innerHTML]="b.text"></h3> }
          @case ('ul') { <ul>@for (i of b.items; track $index) { <li [innerHTML]="i"></li> }</ul> }
          @default { <p [innerHTML]="b.text"></p> }
        }
      }
    </div>
  `,
})
export class MarkdownComponent {
  readonly source = input<string | null | undefined>('');
  readonly blocks = computed<Block[]>(() => parse(this.source() ?? ''));
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>');

export function parse(src: string): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  let list: string[] | null = null;
  const flush = () => {
    if (para.length) { out.push({ kind: 'p', text: inline(para.join(' ')) }); para = []; }
    if (list) { out.push({ kind: 'ul', items: list }); list = null; }
  };
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { flush(); out.push({ kind: `h${h[1].length}` as Block['kind'], text: inline(h[2]) }); continue; }
    const li = /^[-*•]\s+(.*)$/.exec(line);
    if (li) { if (para.length) { out.push({ kind: 'p', text: inline(para.join(' ')) }); para = []; } (list ??= []).push(inline(li[1])); continue; }
    if (list) { out.push({ kind: 'ul', items: list }); list = null; }
    para.push(line);
  }
  flush();
  return out;
}

import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseMarkdown, repoRef, safeHref } from '../src/markdown';
import { MentionText } from '../src/prototype/Collaboration';
import type { Participant } from '../src/room';

const people = [
  { id: 'igor', name: 'Igor', role: 'human' },
  { id: 'grok', name: 'Grok', role: 'agent' },
  { id: 'codex-cli', name: 'Codex CLI', role: 'agent' },
] as Participant[];
const html = (text: string, viewerId?: string) => renderToStaticMarkup(<MentionText text={text} participants={people} viewerId={viewerId} />);

test('inline emphasis, code, and line breaks', () => {
  expect(html('**bold** and *italic* and `code`\nnext line')).toBe('<p><strong>bold</strong> and <em>italic</em> and <code>code</code><br/>next line</p>');
  expect(html('***both*** __strong__ _em_')).toBe('<p><em><strong>both</strong></em> <strong>strong</strong> <em>em</em></p>');
  expect(html('snake_case_name, 2 * 3 * 4, \\*literal\\*')).toBe('<p>snake_case_name, 2 * 3 * 4, *literal*</p>');
  expect(html('**unclosed and `unclosed')).toBe('<p>**unclosed and `unclosed</p>');
  expect(html('``a ` b``')).toBe('<p><code>a ` b</code></p>');
  expect(html('# Heading ##\n\nbody')).toBe('<p class="md-heading"><strong>Heading</strong></p><p>body</p>');
});

test('raw HTML and image syntax stay text', () => {
  expect(html('<script>alert(1)</script><img src=x onerror=alert(1)>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;</p>');
  const image = html('![pixel](https://tracker.example/p.png)');
  expect(image).not.toContain('<img');
  expect(image).toBe('<p>!<a href="https://tracker.example/p.png" target="_blank" rel="noopener noreferrer">pixel</a></p>');
});

test('links allow only http, https, and mailto', () => {
  expect(html('[docs](https://example.com/a_(b)) and [me](mailto:me@example.com)')).toBe('<p><a href="https://example.com/a_(b)" target="_blank" rel="noopener noreferrer">docs</a> and <a href="mailto:me@example.com" target="_blank" rel="noopener noreferrer">me</a></p>');
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'file:///etc/passwd', '/relative', '//evil.example']) {
    expect(safeHref(url)).toBeUndefined();
    expect(html(`[x](${url})`)).not.toContain('<a');
  }
  expect(html('[click](javascript:alert(1))')).toBe('<p>[click](javascript:alert(1))</p>');
  expect(html('[x](javascript:alert(1) "t")')).not.toContain('<a');
});

test('nested brackets never smuggle a link out of a label', () => {
  expect(html('[[x](javascript:alert(1))](https://ok.example)')).toBe('<p><a href="https://ok.example/" target="_blank" rel="noopener noreferrer">[x](javascript:alert(1))</a></p>');
  expect(html('[a [b] c](https://ok.example)')).toBe('<p><a href="https://ok.example/" target="_blank" rel="noopener noreferrer">a [b] c</a></p>');
  expect(html('[[[[unbalanced')).toBe('<p>[[[[unbalanced</p>');
  expect(html('[x](https://ok.example "title")')).toBe('<p>[x](<a href="https://ok.example/" target="_blank" rel="noopener noreferrer">https://ok.example</a> &quot;title&quot;)</p>');
});

test('bare URLs link without trailing punctuation', () => {
  expect(html('see https://example.com/path). or (https://en.wikipedia.org/wiki/Foo_(bar))')).toBe('<p>see <a href="https://example.com/path" target="_blank" rel="noopener noreferrer">https://example.com/path</a>). or (<a href="https://en.wikipedia.org/wiki/Foo_(bar)" target="_blank" rel="noopener noreferrer">https://en.wikipedia.org/wiki/Foo_(bar)</a>)</p>');
  expect(html('**https://x.example**')).toBe('<p><strong><a href="https://x.example/" target="_blank" rel="noopener noreferrer">https://x.example</a></strong></p>');
  expect(html('`https://x.example` and xhttps://x.example')).toBe('<p><code>https://x.example</code> and xhttps://x.example</p>');
});

test('GitHub and GitLab links become short labeled chips that keep their target', () => {
  expect(repoRef('https://github.com/igorls/meshrooms/pull/42')).toEqual({ kind: 'pull', label: 'igorls/meshrooms#42' });
  expect(repoRef('https://www.github.com/igorls/meshrooms/pull/42/files#diff-1')).toEqual({ kind: 'pull', label: 'igorls/meshrooms#42' });
  expect(repoRef('https://github.com/igorls/meshrooms/issues/7?q=1')).toEqual({ kind: 'issue', label: 'igorls/meshrooms#7' });
  expect(repoRef('https://github.com/igorls/meshrooms/commit/97CBC7C0a1b2c3d4')).toEqual({ kind: 'commit', label: 'meshrooms@97cbc7c' });
  expect(repoRef('https://gitlab.com/group/sub/project/-/merge_requests/12')).toEqual({ kind: 'pull', label: 'group/sub/project!12' });
  expect(repoRef('https://gitlab.com/group/project/-/issues/3')).toEqual({ kind: 'issue', label: 'group/project#3' });
  for (const url of ['https://github.com/igorls/meshrooms', 'https://github.com/igorls/meshrooms/pull/abc', 'https://github.com/igorls/meshrooms/commit/xyz', 'https://github.com/igorls/meshrooms/issues',
    'https://evil.example/igorls/meshrooms/pull/1', 'https://github.com.evil.example/a/b/pull/1', 'https://gitlab.evil.example/a/b/-/merge_requests/1', 'https://gitlab.com/-/merge_requests/1', 'mailto:a@github.com'])
    expect(repoRef(url)).toBeUndefined();

  const pull = 'https://github.com/igorls/meshrooms/pull/42';
  expect(html(`see ${pull}.`)).toBe(`<p>see <a class="md-ref md-ref-pull" href="${pull}" title="${pull}" target="_blank" rel="noopener noreferrer"><svg class="md-ref-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="4" cy="3.5" r="1.5"></circle><circle cx="4" cy="12.5" r="1.5"></circle><circle cx="12" cy="12.5" r="1.5"></circle><path d="M4 5v6M12 11V7a2 2 0 0 0-2-2H7.5M9 3.5 7.5 5 9 6.5"></path></svg>igorls/meshrooms#42</a>.</p>`);
  const chip = (text: string) => { const out = html(text); return out.slice(out.indexOf('<a'), out.indexOf('</a>') + 4).replace(/<svg.*<\/svg>/, '<svg/>'); };
  expect(chip('https://github.com/igorls/meshrooms/issues/7')).toBe('<a class="md-ref md-ref-issue" href="https://github.com/igorls/meshrooms/issues/7" title="https://github.com/igorls/meshrooms/issues/7" target="_blank" rel="noopener noreferrer"><svg/>igorls/meshrooms#7</a>');
  expect(chip('[https://github.com/a/b/commit/0123456789abcdef](https://github.com/a/b/commit/0123456789abcdef)')).toContain('<svg/>b@0123456</a>');
  expect(chip('https://gitlab.com/g/p/-/merge_requests/5')).toContain('class="md-ref md-ref-pull"');
  // An author's label stays, with the icon and the full URL in the title.
  expect(chip('[the **fix**](https://github.com/a/b/pull/9)')).toBe('<a class="md-ref md-ref-pull" href="https://github.com/a/b/pull/9" title="https://github.com/a/b/pull/9" target="_blank" rel="noopener noreferrer"><svg/>the <strong>fix</strong></a>');
  // Other links, and repository links that are not references, render as before.
  expect(html('https://github.com/igorls/meshrooms')).toBe('<p><a href="https://github.com/igorls/meshrooms" target="_blank" rel="noopener noreferrer">https://github.com/igorls/meshrooms</a></p>');
  expect(html('`https://github.com/a/b/pull/1`')).toBe('<p><code>https://github.com/a/b/pull/1</code></p>');
  expect(html('[x](javascript:alert(1)//github.com/a/b/pull/1)')).not.toContain('<a');
});

test('mentions keep their highlight inside inline markdown but never inside code', () => {
  expect(html('Hi **@Grok** and [@Igor](https://x.example)', 'igor')).toBe('<p>Hi <strong><span class="mention ">@Grok</span></strong> and <a href="https://x.example/" target="_blank" rel="noopener noreferrer"><span class="mention you">@Igor</span></a></p>');
  expect(html('*ask @Codex CLI*')).toBe('<p><em>ask <span class="mention ">@Codex CLI</span></em></p>');
  expect(html('`@Grok` stays code')).toBe('<p><code>@Grok</code> stays code</p>');
  expect(html('```\n@Grok run it\n```')).toBe('<figure class="md-code"><pre><code>@Grok run it</code></pre></figure>');
  expect(html('- @Grok first\n> @Igor quoted', 'igor')).toBe('<ul><li><span class="mention ">@Grok</span> first</li></ul><blockquote><p><span class="mention you">@Igor</span> quoted</p></blockquote>');
});

test('lists, including one nested level, interrupt paragraphs', () => {
  expect(html('Plan:\n1. **Build** it\n2. Test\n   - unit\n   - e2e\n3. Ship')).toBe('<p>Plan:</p><ol><li><strong>Build</strong> it</li><li>Test<ul><li>unit</li><li>e2e</li></ul></li><li>Ship</li></ol>');
  expect(html('3. three\n4. four')).toBe('<ol start="3"><li>three</li><li>four</li></ol>');
  expect(html('- a\n\n- b\n\nafter')).toBe('<ul><li>a</li><li>b</li></ul><p>after</p>');
  expect(html('- a\n1. b')).toBe('<ul><li>a</li></ul><ol><li>b</li></ol>');
  expect(html('*not a list*\n---')).toBe('<p><em>not a list</em></p><hr/>');
});

test('fenced code keeps text verbatim with an optional language label', () => {
  expect(html('```ts\nconst a = `x` < 1 && **b**;\n\n  indented\n```\nafter')).toBe('<figure class="md-code"><figcaption>ts</figcaption><pre><code>const a = `x` &lt; 1 &amp;&amp; **b**;\n\n  indented</code></pre></figure><p>after</p>');
  expect(parseMarkdown('````\n```\nstill code\n````')).toEqual([{ type: 'code', text: '```\nstill code' }]);
  expect(parseMarkdown('```\nunclosed')).toEqual([{ type: 'code', text: 'unclosed' }]);
  expect(parseMarkdown('1. step\n   ```sh\n   bun test\n   ```')).toEqual([{ type: 'list', ordered: true, start: 1, items: [[{ type: 'paragraph', children: [{ type: 'text', text: 'step' }] }, { type: 'code', lang: 'sh', text: 'bun test' }]] }]);
});

test('hostile input stays fast and shallow', () => {
  const inputs = ['*a '.repeat(1400), '['.repeat(4000), '[]('.repeat(1300), '`'.repeat(1) + ' `` '.repeat(990), '> '.repeat(2000) + 'x', '- '.repeat(2000) + 'x', '_a* '.repeat(1000), 'http://' + ')'.repeat(3990), '#'.repeat(3999) + 'x', '~'.repeat(3999) + '`'];
  const started = performance.now();
  for (const input of inputs) expect(html(input).length).toBeGreaterThan(0);
  expect(performance.now() - started).toBeLessThan(500);
});

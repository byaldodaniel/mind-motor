import assert from 'node:assert/strict';

export function assertViewHtml(html, original) {
  assert.equal(html.slice(0, original.length), original);
  const script = /^\n<script data-mind-actividad>\n([\s\S]*?)<\/script>\n$/u.exec(html.slice(original.length));
  assert.ok(script, 'el HTML servido conserva el original y añade el aviso de actividad');
  return script[1];
}

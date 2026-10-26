/**
 * 叙事工坊通用工具：HTML 转义 / Markdown 渲染 / 剪贴板复制
 * renderMarkdown 从旧 public/common.js 全功能版逐行移植。
 */
import { toast } from "sonner";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderInline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let html = '', i = 0;
  const listStack: { type: string; indent: number }[] = [];

  function closeLists(toIndent: number) {
    while (listStack.length && listStack[listStack.length - 1].indent >= toIndent) {
      html += '</' + listStack.pop()!.type + '>';
    }
  }

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const fence = line.match(/^\s*```+\s*([A-Za-z0-9#+._-]*)\s*$/);
    if (fence) {
      closeLists(-1);
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      html += '<pre><code>' + escapeHtml(buf.join('\n')) + '</code></pre>';
      continue;
    }

    // 表格（表头 + 分隔行）
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      closeLists(-1);
      const parseRow = (r: string) => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const headers = parseRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(parseRow(lines[i])); i++; }
      html += '<table><thead><tr>' + headers.map(h => '<th>' + renderInline(h) + '</th>').join('') + '</tr></thead><tbody>'
        + rows.map(r => '<tr>' + r.map(c => '<td>' + renderInline(c) + '</td>').join('') + '</tr>').join('')
        + '</tbody></table>';
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeLists(-1);
      const level = Math.min(h[1].length, 3);
      html += '<h' + level + '>' + renderInline(h[2]) + '</h' + level + '>';
      i++; continue;
    }

    // 分割线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeLists(-1);
      html += '<hr>'; i++; continue;
    }

    // 引用块
    if (/^\s*&gt;|^\s*>/.test(line)) {
      closeLists(-1);
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      html += '<blockquote>' + buf.map(renderInline).join('<br>') + '</blockquote>';
      continue;
    }

    // 列表项（支持缩进嵌套）
    const li = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (li) {
      const indent = li[1].length;
      const type = /^\d/.test(li[2]) ? 'ol' : 'ul';
      if (!listStack.length || listStack[listStack.length - 1].indent < indent) {
        listStack.push({ type, indent });
        html += '<' + type + '>';
      } else if (listStack[listStack.length - 1].indent === indent && listStack[listStack.length - 1].type !== type) {
        html += '</' + listStack.pop()!.type + '>';
        listStack.push({ type, indent });
        html += '<' + type + '>';
      } else {
        closeLists(indent + 1);
        if (!listStack.length) { listStack.push({ type, indent }); html += '<' + type + '>'; }
      }
      html += '<li>' + renderInline(li[3]) + '</li>';
      i++; continue;
    }

    // 空行
    if (/^\s*$/.test(line)) { closeLists(-1); i++; continue; }

    // 普通段落：合并连续行
    closeLists(-1);
    const para = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i])
      && !/^(#{1,6}\s|\s*```|\s*[-*+]\s|\s*\d+\.\s|\s*>|\s*\|)/.test(lines[i])
      && !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    html += '<p>' + para.map(renderInline).join('<br>') + '</p>';
  }
  closeLists(-1);
  return html;
}

/* ---------- 通用文本复制（HTTP 环境自动降级，旧页 copyText） ---------- */
export async function copyText(text: string, successMsg?: string): Promise<void> {
  successMsg = successMsg || '已复制到剪贴板';
  let ok = false;
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch { ok = false; }
  }
  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.body.removeChild(ta);
  }
  if (ok) toast.success(successMsg);
  else toast.error('复制失败，请长按/框选文本手动复制');
}

// ChatGPT → ConversationModel. Raw input: GET /backend-api/conversation/{id}
// (a mapping TREE: {nodeId: {message, parent, children}} + current_node).
//
// We linearize the ACTIVE branch by walking parent links up from current_node —
// exactly what the user sees on screen. Other branches (edits / regenerations)
// get picked up when the user switches to them: their messages diff in by id
// and append. Matches the Claude policy of "branches: keep what shows up".
//
// v1 scope: text / thinking / tool calls. Files are NOT extractable from the
// conversation JSON alone (uploads/outputs are referenced by file id, content
// needs separate download endpoints) → files: [] for now.

function epochToIso(t) {
  return typeof t === 'number' ? new Date(t * 1000).toISOString() : t || null;
}

// ChatGPT web-tool answers embed citation chips as Private-Use-Area spans:
//   \uE200 url \uE202 <title> \uE202 <href> \uE201   → a link chip (real content)
//   \uE200 cite \uE202 turn0search0 … \uE201        → citation refs (noise)
// The UI renders them as chips; in raw text they're tofu, and a PUA char that
// lands inside a URL makes Notion reject the whole append ("Invalid URL for
// link") — which stalled sync mid-conversation. Convert link chips to real
// markdown links, drop other spans whole (char-only stripping would leave
// garbage tokens like "citeturn0search5"), then sweep any stray PUA chars.
const LINK_CHIP_RE = /\uE200url\uE202([^\uE200-\uE202]*)\uE202([^\uE200-\uE202]*)\uE201/g;
const SPAN_RE = /\uE200[^\uE201]*\uE201/g;
const PUA_RE = /[\uE000-\uF8FF]/g;
const clean = (s) =>
  String(s ?? '')
    .replace(LINK_CHIP_RE, (_, title, href) => (href ? `[${title || href}](${href})` : title))
    .replace(SPAN_RE, '')
    .replace(PUA_RE, '');

// One message's content → ordered segments, by content_type.
function contentToSegments(m) {
  const c = m.content || {};
  const role = m.author?.role;
  const recipient = m.recipient || 'all';
  const segs = [];

  const joinParts = () =>
    clean((c.parts || []).filter((p) => typeof p === 'string').join(''));

  switch (c.content_type) {
    case 'text': {
      const text = joinParts();
      if (!text) break;
      if (role === 'assistant' && recipient !== 'all') {
        // assistant talking TO a tool (browser, python, a plugin) = a tool call
        segs.push({ kind: 'tool_use', name: recipient, input: text });
      } else if (role === 'tool') {
        segs.push({ kind: 'tool_result', name: m.author?.name || 'tool', result: text });
      } else {
        segs.push({ kind: 'text', text });
      }
      break;
    }
    case 'multimodal_text': {
      // parts mix strings and image_asset_pointer objects; images are out of scope.
      const text = joinParts();
      if (text) segs.push({ kind: 'text', text });
      break;
    }
    case 'thoughts': // reasoning models (o-series / gpt-5 thinking)
      for (const t of c.thoughts || []) {
        const text = clean([t.summary, t.content].filter(Boolean).join('\n'));
        if (text) segs.push({ kind: 'thinking', text });
      }
      break;
    case 'code': // tool invocation source (python, search query, canvas op…)
      segs.push({
        kind: 'tool_use',
        name: recipient !== 'all' ? recipient : c.language || 'code',
        input: clean(c.text || ''),
      });
      break;
    case 'execution_output':
      segs.push({ kind: 'tool_result', name: 'execution_output', result: clean(c.text || '') });
      break;
    case 'tether_quote':
    case 'tether_browsing_display':
      segs.push({ kind: 'tool_result', name: c.content_type, result: clean(c.text || c.result || '') });
      break;
    case 'reasoning_recap': // "Thought for 12 seconds" — UI chrome
    case 'model_editable_context': // canvas hidden context
    case 'system_error':
      break;
    default: {
      // Unknown type: salvage any string content rather than dropping silently.
      const text = joinParts() || clean(typeof c.text === 'string' ? c.text : '');
      if (text) {
        if (role === 'tool') segs.push({ kind: 'tool_result', name: c.content_type || 'tool', result: text });
        else segs.push({ kind: 'text', text });
      }
    }
  }
  return segs;
}

function shouldSkip(m) {
  if (!m || !m.id) return true;
  if (m.author?.role === 'system') return true; // hidden scaffold message
  if (m.metadata?.is_visually_hidden_from_conversation) return true;
  return false;
}

export function normalizeChatGPT(raw) {
  const nodes = raw.mapping || {};
  const chain = [];
  const seen = new Set(); // cycle guard — a malformed tree must not hang the worker
  let cur = raw.current_node;
  while (cur && nodes[cur] && !seen.has(cur)) {
    seen.add(cur);
    chain.push(nodes[cur]);
    cur = nodes[cur].parent;
  }
  chain.reverse();

  const messages = [];
  for (const node of chain) {
    const m = node.message;
    if (shouldSkip(m)) continue;
    const segments = contentToSegments(m);
    if (!segments.length) continue;
    messages.push({
      id: m.id,
      role: m.author?.role === 'user' ? 'human' : 'assistant',
      createdAt: epochToIso(m.create_time),
      segments,
      // Derived views for the console preview (same shape as the Claude normalizer).
      text: segments.filter((s) => s.kind === 'text').map((s) => s.text).join(''),
      thinking: segments.filter((s) => s.kind === 'thinking').map((s) => s.text),
      tools: segments.filter((s) => s.kind === 'tool_use' || s.kind === 'tool_result'),
      files: [],
    });
  }

  const id = raw.conversation_id || raw.id;
  return {
    id,
    platform: 'chatgpt',
    title: clean(raw.title) || '(untitled)',
    url: `https://chatgpt.com/c/${id}`,
    createdAt: epochToIso(raw.create_time),
    updatedAt: epochToIso(raw.update_time),
    messages,
    // 轮次 = AI 答完一轮。ChatGPT splits thinking/tool steps into separate
    // assistant nodes, so count only assistant messages that contain answer text.
    turns: messages.filter(
      (m) => m.role === 'assistant' && m.segments.some((s) => s.kind === 'text')
    ).length,
  };
}

// Claude → ConversationModel. The raw input is the canonical conversation JSON
// from GET /api/organizations/{org}/chat_conversations/{id}?tree=True&… (the
// MAIN-world script refetches it; see src/inject/main-world.js).

function basename(p) {
  return String(p || '').split('/').pop() || String(p || '');
}

// Extract file refs WITH content from a message. Two sources carry real content:
//  - uploaded files:  attachments[].extracted_content
//  - AI-created files: content[].tool_use[create_file].input.file_text
// present_files / local_resource are display-only pointers (no content) and are
// usually copies of already-captured files, so we skip them to avoid duplicates.
function collectFileRefs(m) {
  const refs = [];
  for (const a of m.attachments || []) {
    refs.push({
      name: a.file_name || '(file)',
      content: a.extracted_content ?? null,
      mime: a.file_type || null,
      source: 'upload',
    });
  }
  for (const c of m.content || []) {
    if (c.type === 'tool_use' && c.name === 'create_file' && c.input) {
      refs.push({
        name: basename(c.input.path),
        content: c.input.file_text ?? null,
        path: c.input.path || null,
        source: 'created',
      });
    }
  }
  return refs;
}

export function normalizeClaude(raw) {
  const all = raw.chat_messages || [];
  const valid = all.filter((m) => m && m.uuid);
  if (valid.length !== all.length) {
    // A message without uuid would collapse in the synced-id diff — drop it
    // loudly instead. Seeing this warning means Claude's API shape changed.
    console.warn(`[ACNS] dropped ${all.length - valid.length} message(s) without uuid (API shape change?)`);
  }
  const messages = valid.map((m) => {
    const role = m.sender === 'human' ? 'human' : 'assistant';
    const content = Array.isArray(m.content) ? m.content : [];

    // Preserve the ORIGINAL order of content parts so tool calls / thinking land
    // in their real position relative to the answer (Claude orders content[] as
    // thinking → tool_use → tool_result → text as they actually happened).
    const segments = [];
    for (const c of content) {
      if (c.type === 'text' && c.text) segments.push({ kind: 'text', text: c.text });
      else if (c.type === 'thinking') segments.push({ kind: 'thinking', text: c.thinking || c.text || '' });
      else if (c.type === 'tool_use') segments.push({ kind: 'tool_use', name: c.name, input: c.input });
      else if (c.type === 'tool_result') segments.push({ kind: 'tool_result', name: c.name, result: c.content });
    }
    if (!segments.length && m.text) segments.push({ kind: 'text', text: m.text }); // older shapes

    return {
      id: m.uuid,
      role,
      createdAt: m.created_at,
      segments,
      // Derived views for the console preview (order doesn't matter here).
      text: segments.filter((s) => s.kind === 'text').map((s) => s.text).join(''),
      thinking: segments.filter((s) => s.kind === 'thinking').map((s) => s.text),
      tools: segments.filter((s) => s.kind === 'tool_use' || s.kind === 'tool_result'),
      files: collectFileRefs(m),
    };
  });

  return {
    id: raw.uuid,
    platform: 'claude',
    title: raw.name || '(untitled)',
    url: `https://claude.ai/chat/${raw.uuid}`,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    messages,
    // 轮次 = AI 答完一轮。Claude: one assistant message per turn.
    turns: messages.filter((m) => m.role === 'assistant').length,
  };
}

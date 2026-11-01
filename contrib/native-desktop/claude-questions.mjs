import { createHash } from 'node:crypto';

// Original transcript identities authorize only the matching visible native form.
export function pendingClaudeQuestions(entries) {
  const pending = new Map();
  for (const entry of entries) {
    if (!['assistant', 'user'].includes(entry.type) || entry.isMeta || entry.isSidechain || !Array.isArray(entry.message?.content)) continue;
    for (const part of entry.message.content) {
      if (part.type === 'tool_use' && part.name === 'AskUserQuestion' && typeof part.id === 'string' && Array.isArray(part.input?.questions)) pending.set(part.id, part.input.questions);
      if (part.type === 'tool_result') pending.delete(part.tool_use_id);
    }
  }
  return [...pending].map(([id, questions]) => ({id, questions}));
}
const within = (node, path) => node.path.length > path.length && path.every((value, i) => node.path[i] === value);
function questionRequest(sessionId, tool, index, question) {
  const id = 'claude-question-' + createHash('sha256').update(JSON.stringify([sessionId, tool.id, index, question])).digest('hex').slice(0, 24);
  return { id, method: 'native/claude/requestUserInput', questions: [{id: String(index), question: question.question, header: question.header, multiSelect: !!question.multiSelect, options: question.options.map(({label, description}) => ({label, description}))}] };
}
export function claudePendingQuestionRequest(sessionId, pending) {
  // A single original question has no page ambiguity. Keep it visible when the
  // user switches the native App to another chat; only an explicit reply opens it.
  if (pending?.length !== 1 || pending[0].questions.length !== 1) return null;
  const question = pending[0].questions[0];
  if (typeof question.question !== 'string' || !Array.isArray(question.options) || question.options.length < 2 || question.options.length > 8 || question.options.some(option => typeof option.label !== 'string')) return null;
  return questionRequest(sessionId, pending[0], 0, question);
}
export function claudeQuestionRequest(state, pending) {
  if (state.locked || !state.selectedId) return null;
  const nodes = state.nodes ?? [];
  const matches = [];
  for (const tool of pending ?? []) for (const [index, question] of tool.questions.entries()) {
    if (typeof question.question !== 'string' || !Array.isArray(question.options) || question.options.length < 2 || question.options.length > 8 || question.options.some(option => typeof option.label !== 'string')) continue;
    for (const group of nodes.filter(node => node.role === 'AXGroup' && node.description === question.question)) {
      const descendants = nodes.filter(node => within(node, group.path));
      const boxes = descendants.filter(node => ['AXCheckBox', 'AXRadioButton'].includes(node.role));
      if (descendants.filter(node => node.role === 'AXButton' && node.title === 'Submit').length !== 1 || boxes.some(box => typeof box.checked !== 'boolean')) continue;
      const targets = question.options.map(option => boxes.filter(box => {
        const texts = nodes.filter(node => within(node, box.path) && node.role === 'AXStaticText').map(node => node.value);
        return texts[0] === option.label && box.title === [option.label, option.description].filter(Boolean).join(' ');
      }));
      if (targets.some(target => target.length !== 1) || boxes.filter(box => box.title).length !== targets.length) continue;
      const request = questionRequest(state.selectedId, tool, index, question);
      matches.push({request, toolId: tool.id, control: {groupPath: group.path, question: question.question, optionTitles: targets.map(([node]) => node.title)}});
    }
  }
  return matches.length === 1 ? matches[0] : null;
}
export function claudeQuestionAnswer(match, command) {
  if (!match || match.request.id !== command.requestId) throw Error('Claude 问题已变化，请刷新');
  const question = match.request.questions[0];
  const response = command.response?.answers;
  const answers = response?.[question.id]?.answers;
  if (!response || Object.keys(response).length !== 1 || !Array.isArray(answers) || !answers.length || !question.multiSelect && answers.length !== 1 || new Set(answers).size !== answers.length || answers.some(answer => !question.options.some(option => option.label === answer))) throw Error('请选择当前问题中的有效选项');
  return {...match.control, selectedTitles: answers.map(answer => match.control.optionTitles[question.options.findIndex(option => option.label === answer)])};
}

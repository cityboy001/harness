import { createAgent, createMiddleware } from 'langchain';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';

import { ModelOutputLimitError, PublicError, toolArgumentLimit } from './models.mjs';

const bytes = value => Buffer.byteLength(value, 'utf8');

function toProviderMessage(message) {
  const content = message.text;
  switch (message.getType()) {
    case 'system': return { role: 'system', content };
    case 'human': return { role: 'user', content };
    case 'tool': return { role: 'tool', content, tool_call_id: message.tool_call_id };
    case 'ai': return { role: 'assistant', content, ...message.additional_kwargs };
    default: throw new Error('Unexpected LangChain message type: ' + message.getType());
  }
}

class BuilderChatModel extends BaseChatModel {
  constructor(complete) {
    super({ maxRetries: 0 });
    this.complete = complete;
  }

  _llmType() { return 'website-builder-deepseek'; }

  // The existing provider adapter sends the original tool schemas with each request.
  bindTools() { return this; }

  async _generate(messages) {
    const message = await this.complete(messages.map(toProviderMessage));
    return { generations: [{ text: message.text, message }] };
  }
}

export async function runReAct({ messages, definitions, handlers, completion, signal, maxTokens, maxToolTurns,
  maxCallsPerTurn = 4, onReasoning, progress, finishInstructions, finalize, correction, recoverVerifiedDraft,
  budget = { remaining: maxTokens }, readReserve = Math.min(8000, Math.floor(maxTokens / 4)) }) {
  let turns = 0;
  let stalled = 0;
  let toolProgress;
  let finishReason;
  let finishOnly = false;
  let forceFinish = false;
  let result;
  const corrected = new Set();
  const toolErrors = new Map();
  const names = new Set(definitions.map(tool => tool.function.name));
  let toolQueue = Promise.resolve();

  const model = new BuilderChatModel(async history => {
    signal.throwIfAborted();
    if (budget.remaining < 128) throw new ModelOutputLimitError();
    if (toolProgress !== undefined) stalled = progress() === toolProgress ? stalled + 1 : 0;
    finishReason = forceFinish ? '需要更正最终回复' : budget.remaining <= readReserve ? '仅剩收尾预算'
      : stalled >= 2 ? '连续工具调用没有进展'
      : turns >= maxToolTurns + Number(corrected.has('browser')) ? '工具轮次已用完' : undefined;
    finishOnly = Boolean(finishReason);
    if (finishOnly && definitions.length) history.push({ role: 'system', content: finishInstructions });
    const laterTurn = turns++ > 0;
    let streamingReasoning = false;
    const reportReasoning = chunk => {
      if (!chunk) return;
      onReasoning?.((laterTurn && !streamingReasoning ? '\n\n' : '') + chunk);
      streamingReasoning = true;
    };
    let response;
    try {
      response = await completion(history, budget.remaining, {
        tools: definitions.length ? definitions : undefined,
        toolChoice: finishOnly && definitions.length ? 'none' : undefined,
        thinking: true, stream: true, signal, onReasoning: reportReasoning
      });
    } catch (error) {
      if (error instanceof ModelOutputLimitError) budget.remaining = 0;
      throw error;
    }
    signal.throwIfAborted();
    const message = typeof response === 'string' ? { content: response } : response?.message;
    if (!message) throw new PublicError(422, '模型没有返回有效的修改结果。');
    if (!streamingReasoning && typeof message.reasoning_content === 'string') reportReasoning(message.reasoning_content);
    const used = response.usage?.completion_tokens;
    const cost = Number.isSafeInteger(used) && used > 0 ? used : Math.ceil(bytes(JSON.stringify(message)) / 3);
    budget.remaining = Math.max(0, budget.remaining - cost);

    const calls = message.tool_calls ?? [];
    if (!Array.isArray(calls) ||
        new Set(calls.map(call => call?.id)).size !== calls.length ||
        calls.some(call => typeof call?.id !== 'string' || !call.id || !names.has(call.function?.name))) {
      throw new PublicError(422, '模型请求了无效的工具操作。');
    }
    if (calls.length > maxCallsPerTurn) {
      throw new PublicError(422, `模型单轮请求了 ${calls.length} 个工具调用（上限 ${maxCallsPerTurn} 个），属于无效的工具操作。`);
    }
    if (finishOnly && calls.length) throw new PublicError(422, '模型在结束读文件和测试后仍未提交有效修改，请重试。');
    toolErrors.clear();
    toolProgress = calls.length ? progress() : undefined;
    const additional = { ...(message.reasoning_content !== undefined && { reasoning_content: message.reasoning_content }) };
    const parsed = [];
    if (calls.length) {
      additional.tool_calls = calls.map(call => {
        const { name, arguments: raw } = call.function;
        let args;
        if (call.argumentOverflow || (typeof raw === 'string' && bytes(raw) > toolArgumentLimit(name))) {
          toolErrors.set(call.id, '工具参数超过大小上限，本次调用未执行。请缩小参数后再提交。' +
            (name === 'submit_patch' ? '请用局部 edits 减小补丁大小。'
              : '修改文件时使用局部 edits，或分批调用 stage_changes 并传入上次保存的候选 ID。'));
        } else {
          try { args = JSON.parse(raw); } catch { /* Handled as a tool result. */ }
          if (!args || typeof args !== 'object' || Array.isArray(args)) toolErrors.set(call.id, '工具参数必须是有效的 JSON 对象。');
        }
        parsed.push({ id: call.id, name, args: toolErrors.has(call.id) ? {} : args, type: 'tool_call' });
        return { id: call.id, type: 'function', function: { name, arguments: toolErrors.has(call.id) ? '{}' : raw } };
      });
    }
    return new AIMessage({ content: typeof message.content === 'string' ? message.content : '',
      additional_kwargs: additional, tool_calls: parsed });
  });

  const middleware = createMiddleware({
    name: 'BuilderDelivery',
    wrapToolCall(request, handler) {
      // Candidate and preview tools share mutable project state. Execute a batch in model order.
      const pending = toolQueue.then(() => {
        signal.throwIfAborted();
        const error = toolErrors.get(request.toolCall.id);
        if (error) return new ToolMessage({ tool_call_id: request.toolCall.id,
          name: request.toolCall.name, status: 'error', content: JSON.stringify({ error }) });
        return handler(request);
      });
      toolQueue = pending.catch(() => {});
      return pending;
    },
    afterModel: {
      canJumpTo: ['model'],
      async hook(state) {
        const message = state.messages.at(-1);
        if (message.tool_calls?.length) return;
        try {
          result = await finalize(message.text, finishReason);
        } catch (error) {
          const next = correction?.(error);
          if (!next || corrected.has(next.kind) || budget.remaining < 128 || (next.kind === 'browser' && finishOnly)) throw error;
          corrected.add(next.kind);
          forceFinish = !next.allowTools && next.kind !== 'browser';
          return { messages: [new HumanMessage(next.message)], jumpTo: 'model' };
        }
      }
    }
  });
  const tools = definitions.map(({ function: definition }) => new DynamicStructuredTool({
    name: definition.name, description: definition.description, schema: definition.parameters,
    func: handlers.get(definition.name)
  }));
  const agent = createAgent({ model, tools, systemPrompt: messages[0].content, middleware: [middleware], version: 'v1' });
  try {
    await agent.invoke({ messages: [new HumanMessage(messages[1].content)] }, {
      signal, recursionLimit: (maxToolTurns + 5) * 4
    });
  } catch (error) {
    if (!(error instanceof ModelOutputLimitError)) throw error;
    const verified = recoverVerifiedDraft?.();
    if (verified) return verified;
    throw error;
  }
  signal.throwIfAborted();
  if (!result) throw new PublicError(422, '模型在结束读文件和测试后仍未提交有效修改，请重试。');
  return result;
}

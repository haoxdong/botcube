import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { awsFetch } from './aws.js';
import type { TurnActivity } from './session-metadata.js';
import { bedrockTurnSummarizer, recordTurnSummary, turnSummaryModelFromEnv } from './turn-summaries.js';

vi.mock('./aws.js', () => ({ awsFetch: vi.fn() }));
beforeEach(() => vi.mocked(awsFetch).mockReset());
afterEach(() => vi.restoreAllMocks());
const model = turnSummaryModelFromEnv({}, 'us-east-1');
const turn = { request: 'PRIVATE_REQUEST', answer: 'PRIVATE_ANSWER' };

// Compatible with the safe Q19 replay: exhausted 200 tokens, title present, no nonempty summary.
// The receipt's NoneType does not distinguish an absent field from JSON null; this fixture uses null.
const truncatedBody = JSON.stringify({
  output: { message: { role: 'assistant', content: [{ toolUse: {
    toolUseId: 'PRIVATE_TOOL_ID', name: 'turn_summary', input: { title: 'PRIVATE_TITLE', summary: null, PRIVATE_KEY: 'PRIVATE_VALUE' },
  } }] } }, stopReason: 'max_tokens', usage: { inputTokens: 5840, outputTokens: 200, totalTokens: 6040 },
});

it('keeps measured truncation a failure and reports only safe metadata', async () => {
  vi.mocked(awsFetch).mockResolvedValue(new Response(truncatedBody, {
    headers: { 'x-amzn-requestid': '2819716e-7d84-4251-9008-ad111a41daa0', authorization: 'PRIVATE_HEADER' },
  }));
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await expect(bedrockTurnSummarizer(model)(turn)).rejects.toThrow('The summary model answered without a title and summary');
  expect(logged).toHaveBeenCalledExactlyOnceWith('Turn summary response rejected [DEBUG-3779]', {
    modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', requestId: '2819716e-7d84-4251-9008-ad111a41daa0',
    rawResponseSHA256: '8be771b8be1d72437d1d3b6f6a8ed63241a6e23350d5836f9981bdec7747681e', stopReason: 'max_tokens',
    summaryToolPresent: true, toolInputType: 'object', titleType: 'string', titleNonempty: true,
    summaryType: 'null', summaryNonempty: false, usage: { inputTokens: 5840, outputTokens: 200, totalTokens: 6040 },
  });
  expect(JSON.stringify(logged.mock.calls)).not.toContain('PRIVATE_');
  expect(awsFetch).toHaveBeenCalledTimes(1);
});

it('requests the measured recovery budget and persists a healthy forced-tool summary without diagnostics', async () => {
  vi.mocked(awsFetch).mockResolvedValue(Response.json({
    output: { message: { content: [{ toolUse: { name: 'turn_summary', input: { title: '  Brief on rates  ', summary: '  Compared the yields  ' } } }] } },
    stopReason: 'tool_use',
  }));
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const saved: TurnActivity[] = [];
  await recordTurnSummary(bedrockTurnSummarizer(model), async (value) => { saved.push(value); }, 'healthy', turn);
  expect(saved).toEqual([{
    request: 'PRIVATE_REQUEST', completedAt: expect.any(String), summary: { title: 'Brief on rates', summary: 'Compared the yields' },
  }]);
  expect(JSON.parse(String(vi.mocked(awsFetch).mock.calls[0]?.[3].body))).toMatchObject({
    inferenceConfig: { maxTokens: 512, temperature: 0 },
    toolConfig: {
      tools: [{ toolSpec: { name: 'turn_summary', inputSchema: { json: {
        type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' } }, required: ['title', 'summary'],
      } } } }], toolChoice: { tool: { name: 'turn_summary' } },
    },
  });
  expect(logged).not.toHaveBeenCalled();
  expect(awsFetch).toHaveBeenCalledTimes(1);
});

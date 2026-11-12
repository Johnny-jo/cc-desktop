'use strict';

/** Extend native tools without changing calls that do not opt into observations. */
function withTargetDiscovery(definitions, { z, discovery, isActive = () => true }) {
  const assertActive = signal => {
    if (!isActive() || signal?.aborted) throw new Error('Browser control is no longer active or was cancelled.');
  };
  const targetActions = new Set(['browser_click', 'browser_type', 'browser_hover', 'browser_select_option', 'browser_drag']);
  const guarded = definitions.map(tool => {
    if (tool.schema.name === 'browser_find') {
      return { ...tool, schema: { ...tool.schema, title: 'Find page text or targets',
        description: 'Search text/regex, or use query with optional role and region for up to 5 live targets and an observationId. ' +
          'Pass the ID to click/type/hover/select/drag for guarded compact results. Expand ambiguous regions with browser_expand_region.',
        inputSchema: tool.schema.inputSchema.extend({
          query: z.string().min(1).max(200).optional().describe('Target accessible name substring; exclusive with text/regex/maxResults/filename.'),
          role: z.string().min(1).max(80).optional().describe('Exact ARIA role for query mode, e.g. button.'),
          region: z.string().min(1).max(200).optional().describe('Containing form, region or dialog name for query mode.'),
        }),
      }, handle: async (context, input, response, signal) => {
        assertActive(signal);
        const queryMode = ['query', 'role', 'region'].some(key => input[key] !== undefined);
        if (!queryMode) return tool.handle(context, input, response, signal);
        if (typeof input.query !== 'string' || !input.query.trim() ||
            ['text', 'regex', 'maxResults', 'filename'].some(key => input[key] !== undefined)) {
          response.addError('Provide query with optional role/region, or use the original text/regex search; do not mix modes.');
          return;
        }
        const result = await discovery.find(context.currentTab(), input, { signal });
        assertActive(signal);
        response.addTextResult(JSON.stringify(result));
      } };
    }
    if (!targetActions.has(tool.schema.name)) return tool;
    return { ...tool, schema: { ...tool.schema,
      inputSchema: tool.schema.inputSchema.extend({
        observationId: z.string().min(1).max(100).optional().describe('Query-mode browser_find ID; validates targets and returns compact output. Verify separately.'),
      }),
    }, handle: async (context, input, response, signal) => {
      const { observationId, ...nativeInput } = input;
      if (observationId === undefined) return tool.handle(context, input, response, signal);
      assertActive(signal);
      const tab = context.currentTab();
      const refs = tool.schema.name === 'browser_drag' ? [input.startTarget, input.endTarget] : [input.target];
      await discovery.validate(tab, { observationId, refs }, { signal });
      const assertTab = () => {
        assertActive(signal);
        if (context.currentTab() !== tab || tab?.page?.isClosed?.()) throw new Error('Current browser tab changed; find targets on the selected page again.');
      };
      assertTab();
      discovery.invalidate(tab, observationId);
      let nativeError = false;
      const compactResponse = new Proxy(response, { get(target, key) {
        if (key === 'setIncludeSnapshot') return () => {};
        if (key === 'addError') return (...args) => { nativeError = true; return target.addError(...args); };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      // Native defineTabTool resolves ensureTab again. Bind that dispatch to
      // the tab we validated so a closing/changed selection cannot redirect eN.
      const boundContext = new Proxy(context, { get(target, key) {
        if (key === 'ensureTab') return async () => { assertTab(); return tab; };
        if (key === 'currentTab') return () => { assertTab(); return tab; };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      await tool.handle(boundContext, nativeInput, compactResponse, signal);
      assertActive(signal);
      if (!nativeError) response.addTextResult(JSON.stringify({ status: 'action_returned', observationId, verifyRequired: true }));
    } };
  });
  guarded.push({ schema: {
    name: 'browser_expand_region', title: 'Expand a target region', type: 'readOnly',
    description: 'Read only the form, region or dialog containing a query-mode browser_find candidate. Requires its observationId and real ref; stale observations must be queried again. No click, navigation or scroll.',
    inputSchema: z.object({
      observationId: z.string().min(1).max(100),
      ref: z.string().min(1).max(100).describe('Candidate ref returned by query-mode browser_find.'),
    }),
  }, handle: async (context, input, response, signal) => {
    assertActive(signal);
    const result = await discovery.expand(context.currentTab(), input, { signal });
    assertActive(signal);
    response.addTextResult(JSON.stringify(result));
  } });
  return guarded;
}

module.exports = { withTargetDiscovery };

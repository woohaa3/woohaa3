import {it,expect} from 'vitest';
import {CANVAS_BUILDER_FLOW} from '../src/backend/prompts.js';
it('routes single-character motion to explicit motion tasks and truthful completion',()=>{
 const flow=CANVAS_BUILDER_FLOW.join('\n');
 expect(flow).toContain('motion');expect(flow).toContain('NPZ');expect(flow).toContain('官方 SOMA 白模');expect(flow).toContain('get_node_output');
});

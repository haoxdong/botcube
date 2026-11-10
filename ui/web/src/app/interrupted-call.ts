/**
 * The checkpoint saver answers each tool call that has no result yet with this placeholder whenever it loads the record
 * (langgraph-checkpoint-aws): a read mid-Turn answers the calls still running, and a stopped Turn its cut call.
 */
export const UNANSWERED_CALL = /^Tool call '.+' with id '.+' was interrupted before completion\.$/;

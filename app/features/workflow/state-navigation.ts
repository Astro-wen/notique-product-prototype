export const WORKFLOW_LEAVE_EVENT='notique:workflow-before-leave';
/** Returns true when the visible editor asks navigation to wait for save/cancel. */
export function workflowHasUnsavedInput():boolean {
  return typeof window!=='undefined' && !window.dispatchEvent(new Event(WORKFLOW_LEAVE_EVENT,{cancelable:true}));
}

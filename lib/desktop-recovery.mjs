/** Bounded recovery guidance. No UI input, retries, or foreground guard bypass. */
export function desktopRecovery(error,{root,windowId,action,window,windows=[]}={}) {
  const originalMessage=String(error?.message??error??'Unknown desktop failure').slice(0,4000);
  let code='DESKTOP_ACTION_UNVERIFIED';
  if(/new owned\/modal|modal dialog|owned\/dialog|window is disabled/i.test(originalMessage))code='DESKTOP_MODAL_CHANGED';
  else if(/foreground|focus|covered by another application/i.test(originalMessage))code='DESKTOP_FOCUS_UNAVAILABLE';
  else if(/owned window/i.test(originalMessage))code='DESKTOP_MODAL_CHANGED';
  else if(/stale|consumed|expired|moved\/resized|observation|reobserve/i.test(originalMessage))code='DESKTOP_OBSERVATION_STALE';
  else if(/worker|timed out|timeout|backend|input desktop|interactive/i.test(originalMessage))code='DESKTOP_WORKER_UNAVAILABLE';
  else if(/closed|replaced|not responding|unknown window/i.test(originalMessage))code='DESKTOP_TARGET_UNAVAILABLE';
  const validId=Number.isSafeInteger(windowId)&&windowId>0;
  const installArgs=typeof root==='string'&&root?{root}:{};
  window??=windows.find(w=>w?.id===windowId);
  const steps=[{tool:'desktop_windows',arguments:{...installArgs},reason:'Get fresh allowed window IDs and select the target or its enabled owned dialog; do not reuse stale IDs.'}];
  if(validId)steps.push({tool:'desktop_observe',arguments:{...installArgs,windowId},condition:'The requested ID is still present and is the selected enabled target.',reason:'Read its current screenshots and focus; this supplies a new observationId.'});
  if(validId&&(code==='DESKTOP_FOCUS_UNAVAILABLE'||window?.minimized))steps.push({tool:'desktop_action',arguments:{...installArgs,windowId,action:'activate_window',parameters:{}},requires:'Fresh observationId from desktop_observe; verify the returned observation before sending any key or text.',reason:window?.minimized?'Restore the selected minimized target and request activation.':'Request foreground activation of the observed selected target. Windows may still deny activation.'});
  steps.push({tool:'desktop_observe',arguments:{...installArgs,...(validId?{windowId}:{})},condition:'After any activation, dialog selection, backend restart, or manual intervention.',reason:'Verify the selected window, focused control, and visible result before deciding whether the original action is still needed.'});
  return {code,originalMessage,targetWindowId:validId?windowId:null,requestedAction:action??null,inputOutcome:'unknown',automaticRetry:false,requiresFreshObservation:true,selectedWindowMinimized:Boolean(window?.minimized),knownTargetWindows:windows.filter(w=>w&&Number.isSafeInteger(w.id)&&(!window?.pid||w.pid===window.pid)).slice(0,20).map(w=>({id:w.id,pid:w.pid,title:typeof w.title==='string'?w.title.slice(0,256):'',minimized:Boolean(w.minimized)})),steps,note:'Preserve the original error. An activation request cannot guarantee Windows will grant foreground focus. Do not repeat edits or bypass the foreground guard.'};
}

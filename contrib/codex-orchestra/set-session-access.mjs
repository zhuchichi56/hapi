// Explicitly authorized session setting, through the original App owner.
// Does not answer approval requests, write databases, or retry uncertain writes.
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
const {CodexDesktop}=await import(pathToFileURL(homedir()+'/.local/lib/native-desktop-bridge/codex-desktop.mjs'));
const id=process.argv[2];if(!/^[a-zA-Z0-9_-]+$/.test(id??''))throw Error('Usage: node set-session-access.mjs THREAD_ID');
const d=await new CodexDesktop({allowControl:true}).connect();
try{await d.subscribe(id);await new Promise(r=>setTimeout(r,400));const thread=d.threads.get(id);if(!thread?.owner)throw Error('Original session owner unavailable');const response=await d.request('thread-follower-update-thread-settings',{conversationId:id,threadSettings:{permissions:':danger-full-access',approvalPolicy:'never'}},thread.owner);if(response.result?.applied!==true)throw Error('App did not confirm settings update');await new Promise(r=>setTimeout(r,400));const settings=d.threads.get(id)?.state?.latestThreadSettings;if(settings?.activePermissionProfile?.id!==':danger-full-access'||settings?.approvalPolicy!=='never')throw Error('Settings readback not confirmed; do not retry automatically');console.log(JSON.stringify({threadId:id,settingsApplied:true,permissionProfile:settings.activePermissionProfile.id,approvalPolicy:settings.approvalPolicy,settingsScope:'next-turn',inFlightPermissionsMayDiffer:true,pendingRequestsAnswered:false}));}finally{d.close()}

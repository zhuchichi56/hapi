import { CodexDesktop, projectConversation } from './codex-desktop.mjs';

const threadId = process.argv[2] ?? process.env.CODEX_THREAD_ID;
if (!threadId) throw Error('Usage: node probe.mjs <existing-native-thread-id>');
const desktop = new CodexDesktop();
const result = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('No native snapshot received within 10 seconds')), 10000);
  desktop.once('state', ({ revision, state }) => {
    clearTimeout(timer);
    const view = projectConversation(state);
    resolve({ connected: true, nativeSnapshot: true, revision,
      runtimeStatus: view.runtimeStatus, turns: view.turns.length,
      items: view.turns.reduce((sum, turn) => sum + turn.items.length, 0),
      historyComplete: view.historyComplete });
  });
  desktop.once('offline', ({ reason }) => { clearTimeout(timer); reject(Error(reason)); });
});
// Install rejection handling before connecting, since connection failure can occur immediately.
result.catch(() => {});
try {
  await desktop.connect();
  await desktop.subscribe(threadId);
  console.log(JSON.stringify(await result));
} finally { desktop.close(); }
